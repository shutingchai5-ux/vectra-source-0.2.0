"""Verify real cryptographic failures, PKI binding and persistent audit anchors."""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import secrets
import shutil
import sqlite3
import ssl
import subprocess

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from vehicular.security import (
    AuditLog, SecurityError, SecurityStore, canonical_bytes,
    decrypt_object, encrypt_object, secure_read, secure_write,
)


@pytest.fixture
def security(tmp_path):
    store = SecurityStore(tmp_path / "security")
    store.provision()
    return store


def test_provision_is_persistent_and_identity_is_pinned(security):
    signed = security.sign("report", {"average_speed": 40, "participants": 3})
    before = security.identities()
    security.provision()
    assert before == security.identities()
    assert security.verify(signed, "report") == signed["payload"]
    assert len(before) == 7
    certificate = x509.load_pem_x509_certificate((security.identity_path("vehicle-b") / "tls.crt").read_bytes())
    assert security.authenticated_identity(certificate.public_bytes(serialization.Encoding.DER), "vehicle-b") == "vehicle-b"
    sans = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert "MPyC party 1" in sans.get_values_for_type(x509.DNSName)
    context = security.tls_context("rsu", server=True)
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.minimum_version == ssl.TLSVersion.TLSv1_3


def test_signature_tamper_expected_identity_and_disabled_identity(security):
    signed = security.sign("report", {"average_speed": 40})
    with pytest.raises(SecurityError, match="expected signer"):
        security.verify(signed, "coordinator")
    signed["payload"]["average_speed"] = 99
    with pytest.raises(SecurityError) as failure:
        security.verify(signed)
    assert failure.value.code == "SIGNATURE_INVALID"
    clean = security.sign("coordinator", {"tool": "statistics"})
    security.set_enabled("coordinator", False)
    with pytest.raises(SecurityError) as failure:
        security.verify(clean)
    assert failure.value.code == "IDENTITY_DISABLED"
    with pytest.raises(SecurityError):
        security.sign("coordinator", {"tool": "statistics"})


def test_report_supplied_public_key_never_becomes_trust(security):
    attacker = ed25519.Ed25519PrivateKey.generate()
    payload = {"average_speed": 100}
    envelope = {"signer": "report", "payload": payload,
                "signature": base64.b64encode(attacker.sign(canonical_bytes(payload))).decode(),
                "public_key": base64.b64encode(attacker.public_key().public_bytes(
                    serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()}
    with pytest.raises(SecurityError) as failure:
        security.verify(envelope, "report")
    assert failure.value.code == "SIGNATURE_INVALID"


def test_registry_signing_key_must_match_certificate_binding(security):
    envelope = security.sign("report", {"result": 40})
    registry_path = security.root / "registry.json"
    registry = json.loads(registry_path.read_text("utf-8"))
    attacker = ed25519.Ed25519PrivateKey.generate()
    registry["identities"]["report"]["signing_public_key"] = base64.b64encode(
        attacker.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    registry_path.write_text(json.dumps(registry), "utf-8")
    with pytest.raises(SecurityError) as failure:
        security.verify(envelope)
    assert failure.value.code == "SIGNING_KEY_MISMATCH"


def test_certificate_pin_rejects_another_legitimate_certificate(security):
    other = (security.identity_path("vehicle-c") / "tls.crt").read_bytes()
    (security.identity_path("report") / "tls.crt").write_bytes(other)
    with pytest.raises(SecurityError) as failure:
        security.sign("report", {"result": 40})
    assert failure.value.code == "CERTIFICATE_UNREGISTERED"


def test_expired_registered_certificate_is_rejected(security):
    location = security.identity_path("vehicle-a")
    original = x509.load_pem_x509_certificate((location / "tls.crt").read_bytes())
    ca_key = serialization.load_pem_private_key((security.root / "ca" / "ca.key").read_bytes(), password=None)
    now = datetime.now(timezone.utc)
    builder = (x509.CertificateBuilder().subject_name(original.subject).issuer_name(original.issuer)
               .public_key(original.public_key()).serial_number(original.serial_number)
               .not_valid_before(now - timedelta(days=2)).not_valid_after(now - timedelta(days=1)))
    for extension in original.extensions:
        builder = builder.add_extension(extension.value, extension.critical)
    expired = builder.sign(ca_key, hashes.SHA256())
    (location / "tls.crt").write_bytes(expired.public_bytes(serialization.Encoding.PEM))
    registry_path = security.root / "registry.json"
    registry = json.loads(registry_path.read_text("utf-8"))
    registry["identities"]["vehicle-a"]["cert_fingerprint"] = expired.fingerprint(hashes.SHA256()).hex()
    registry_path.write_text(json.dumps(registry), "utf-8")
    with pytest.raises(SecurityError) as failure:
        security.sign("vehicle-a", {"task": "statistics"})
    assert failure.value.code == "CERTIFICATE_EXPIRED"


def test_tls_peer_must_be_expected_registered_enabled_identity(security):
    certificate = x509.load_pem_x509_certificate((security.identity_path("vehicle-a") / "tls.crt").read_bytes())
    der = certificate.public_bytes(serialization.Encoding.DER)
    with pytest.raises(SecurityError) as failure:
        security.authenticated_identity(der, expected="vehicle-b")
    assert failure.value.code == "IDENTITY_MISMATCH"
    security.set_enabled("vehicle-a", False)
    with pytest.raises(SecurityError) as failure:
        security.authenticated_identity(der)
    assert failure.value.code == "IDENTITY_DISABLED"
    ca = x509.load_pem_x509_certificate(security.ca_cert_path.read_bytes())
    with pytest.raises(SecurityError) as failure:
        security.authenticated_identity(ca.public_bytes(serialization.Encoding.DER))
    assert failure.value.code == "CERTIFICATE_UNREGISTERED"


def test_aes_gcm_rejects_tamper_wrong_key_and_context(tmp_path):
    key = secrets.token_bytes(32)
    obj = {"sealed_report": {"average_speed": 40}}
    sealed = encrypt_object(obj, key, context="report:123")
    assert decrypt_object(sealed, key, context="report:123") == obj
    with pytest.raises(SecurityError):
        decrypt_object(sealed, key, context="report:124")
    with pytest.raises(SecurityError):
        decrypt_object(sealed, secrets.token_bytes(32), context="report:123")
    raw = bytearray(base64.b64decode(sealed["ciphertext"]))
    raw[0] ^= 1
    sealed["ciphertext"] = base64.b64encode(raw).decode()
    with pytest.raises(SecurityError) as failure:
        decrypt_object(sealed, key, context="report:123")
    assert failure.value.code == "AEAD_INVALID"
    private_path = tmp_path / "vehicle-a" / "sample.enc"
    secure_write(private_path, key, {"speed": 60}, context="vehicle-a")
    assert secure_read(private_path, key, context="vehicle-a") == {"speed": 60}
    assert b'"speed":60' not in private_path.read_bytes()
    copied = tmp_path / "vehicle-b" / "sample.enc"
    copied.parent.mkdir()
    copied.write_bytes(private_path.read_bytes())
    with pytest.raises(SecurityError):
        secure_read(copied, key, context="vehicle-b")


def test_canonical_json_rejects_nonfinite_and_ambiguous_keys():
    assert canonical_bytes({"b": 2, "a": "中文"}) == canonical_bytes({"a": "中文", "b": 2})
    with pytest.raises(SecurityError):
        canonical_bytes({"speed": float("nan")})
    with pytest.raises(SecurityError):
        canonical_bytes({1: "x", "1": "y"})


def test_jcs_number_spellings_unicode_sort_and_precision_domain():
    numbers = [-0.0, 40.0, 1e-7, 1e-6, 1e20, 1e21, 333333333.33333329, 4.50, 2e-3]
    expected = b'[0,40,1e-7,0.000001,100000000000000000000,1e+21,333333333.3333333,4.5,0.002]'
    assert canonical_bytes(numbers) == expected
    assert canonical_bytes(json.loads(expected)) == expected
    # UTF-16 code-unit order differs from Python's Unicode code-point order.
    assert canonical_bytes({"\ue000": 1, "\U0001f600": 2}) == '{"😀":2,"\ue000":1}'.encode("utf-8")
    assert canonical_bytes({"integer": 40}) == canonical_bytes({"integer": 40.0})
    with pytest.raises(SecurityError):
        canonical_bytes({"integer": 9007199254740993})
    with pytest.raises(SecurityError):
        canonical_bytes({"integer": 10**20 + 1})
    with pytest.raises(SecurityError):
        canonical_bytes({"invalid_unicode": "\ud800"})


def test_signed_report_survives_actual_javascript_json_roundtrip(security):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is needed for the optional actual ECMAScript roundtrip check")
    payload = {"average_speed": 40.0, "negative_zero": -0.0, "small": 1e-7, "decimal": 1e-6,
               "large_decimal": 1e20, "large_exponent": 1e21,
               "unicode_fields": {"\ue000": "private-use", "\U0001f600": "emoji"}}
    envelope = security.sign("report", payload)
    javascript = """
const fs = require('node:fs');
const envelope = JSON.parse(fs.readFileSync(0, 'utf8'));
const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
    : v !== null && typeof v === 'object' ? '{' + Object.keys(v).sort().map(
        k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
    : JSON.stringify(v);
process.stdout.write(JSON.stringify({envelope, canonical: canonical(envelope.payload)}));
"""
    output = subprocess.run([node, "-e", javascript], input=json.dumps(envelope, ensure_ascii=False),
                            text=True, encoding="utf-8", capture_output=True, check=True, timeout=10)
    browser = json.loads(output.stdout)
    assert canonical_bytes(payload) == browser["canonical"].encode("utf-8")
    assert security.verify(browser["envelope"], "report") == envelope["payload"]
    browser["envelope"]["payload"]["average_speed"] = 41
    with pytest.raises(SecurityError) as failure:
        security.verify(browser["envelope"], "report")
    assert failure.value.code == "SIGNATURE_INVALID"


def test_audit_persistence_chain_and_truncation(security, tmp_path):
    path = tmp_path / "audit.db"
    audit = AuditLog(path, security)
    first = audit.append("task.accepted", {"task_id": "abc"}, "coordinator", "coordinator")
    second = audit.append("task.completed", {"task_id": "abc", "average_speed": 40})
    checkpoint = audit.checkpoint()
    assert first["id"] == 1 and second["prev_hash"] == first["hash"]
    assert AuditLog(path, security).verify(checkpoint)["valid"]
    assert audit.list()[0]["id"] == 2
    with sqlite3.connect(path) as db:
        db.execute("DELETE FROM audit_events WHERE id=2")
    assert not audit.verify(checkpoint)["valid"]
    assert not audit.verify()["valid"]
    # Refuse to sign a fresh checkpoint for the truncated chain.
    with pytest.raises(SecurityError):
        audit.checkpoint()
    with pytest.raises(SecurityError):
        audit.append("fake", {})


def test_audit_rehash_attack_cannot_replace_signed_anchor(security, tmp_path):
    path = tmp_path / "audit.db"
    audit = AuditLog(path, security)
    event = audit.append("task.accepted", {"decision": "allow"})
    exported = audit.checkpoint()
    event["details"]["decision"] = "deny"
    del event["hash"]
    event["hash"] = hashlib.sha256(canonical_bytes(event)).hexdigest()
    with sqlite3.connect(path) as db:
        db.execute("UPDATE audit_events SET event=? WHERE id=1", (json.dumps(event),))
    assert not audit.verify(exported)["valid"]
    assert not audit.verify()["valid"]
    exported["payload"]["head"] = event["hash"]
    assert not audit.verify(exported)["valid"]


def test_earlier_exported_checkpoint_verifies_an_extended_chain(security, tmp_path):
    audit = AuditLog(tmp_path / "audit.db", security)
    audit.append("first", {})
    exported = audit.checkpoint()
    audit.append("second", {})
    assert audit.verify(exported)["valid"]
    assert audit.verify()["valid"]


def test_audit_concurrent_appends_are_contiguous(security, tmp_path):
    audit = AuditLog(tmp_path / "audit.db", security)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda i: audit.append("request", {"request_id": str(i)}), range(20)))
    verified = audit.verify()
    assert verified["valid"] and verified["count"] == 20
    assert {entry["id"] for entry in audit.list()} == set(range(1, 21))
