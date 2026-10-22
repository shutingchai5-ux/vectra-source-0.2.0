"""Local PKI, authenticated objects and audit checkpoints for the course demo.

The registry and CA directory are trusted administrative state. A signed audit
checkpoint should be retained outside the audit database to detect rollback.
Nothing in this module treats a public key supplied with a report as trusted.
"""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import sqlite3
import ssl
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import rfc8785
from cryptography import x509
from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID, ObjectIdentifier


APP_KEY_OID = ObjectIdentifier("1.3.6.1.4.1.57264.1.1")
IDENTITY_ROLES = {
    "coordinator": "coordinator", "analyst": "analyst", "rsu": "rsu",
    "report": "report", "vehicle-a": "vehicle", "vehicle-b": "vehicle",
    "vehicle-c": "vehicle",
}
GENESIS = "0" * 64
_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


class SecurityError(ValueError):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message
        super().__init__(message)


def _json_keys(value: Any) -> None:
    if isinstance(value, dict):
        if any(not isinstance(k, str) for k in value):
            raise SecurityError("INVALID_JSON", "JSON object keys must be strings")
        for item in value.values():
            _json_keys(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _json_keys(item)


def canonical_bytes(value: Any) -> bytes:
    """RFC 8785 JCS bytes, interoperable with ECMAScript JSON roundtrips.

    JSON parsers represent an integral double such as 1e20 as a Python int when
    its canonical spelling has no exponent. Restore its exact double value
    before JCS serialization. Integers which would lose precision are rejected;
    callers must represent arbitrary-precision identifiers as JSON strings.
    """
    try:
        _json_keys(value)
        return rfc8785.dumps(_jcs_numbers(value))
    except SecurityError:
        raise
    except (rfc8785.CanonicalizationError, TypeError, ValueError, OverflowError, RecursionError) as exc:
        raise SecurityError("INVALID_JSON", "Object is not valid interoperable RFC 8785 JSON") from exc


def _jcs_numbers(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _jcs_numbers(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jcs_numbers(item) for item in value]
    if type(value) is int and abs(value) > 2**53 - 1:
        approximate = float(value)
        if int(approximate) != value:
            raise SecurityError("INVALID_JSON", "Integer cannot be represented exactly by an IEEE 754 double; use a JSON string")
        return approximate
    return value


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(value: Any) -> bytes:
    if not isinstance(value, str):
        raise SecurityError("INVALID_ENCODING", "Expected a base64 string")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise SecurityError("INVALID_ENCODING", "Malformed base64 encoding") from exc


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _at() -> str:
    return _now().isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _atomic_write(path: Path, data: bytes, private: bool = False) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    try:
        with temporary.open("xb") as stream:
            if private:
                os.chmod(temporary, 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # Windows security scanners can briefly hold a newly written target.
        # Retry that transient sharing error without falling back to in-place
        # writes (which could leave a truncated encrypted object/checkpoint).
        for attempt in range(6):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(0.01 * 2 ** attempt)
        # The replacement retains the temporary file's private permissions.
        # Do not perform a fallible chmod after committing the new contents:
        # callers must be able to trust that a reported failure kept the old file.
    finally:
        temporary.unlink(missing_ok=True)


def _validity(cert: x509.Certificate) -> tuple[datetime, datetime]:
    return cert.not_valid_before_utc, cert.not_valid_after_utc


class SecurityStore:
    """Persistent local trust root and distinct TLS/application signing keys."""

    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self._lock = threading.RLock()

    @property
    def ca_cert_path(self) -> Path:
        return self.root / "ca" / "ca.crt"

    def identity_path(self, identity: str) -> Path:
        if identity not in IDENTITY_ROLES:
            raise SecurityError("UNKNOWN_IDENTITY", "Identity is not registered")
        return self.root / "identities" / identity

    def _registry(self) -> dict:
        try:
            value = json.loads((self.root / "registry.json").read_text("utf-8"))
            if value.get("version") != 1 or not isinstance(value["identities"], dict):
                raise ValueError("Invalid registry format")
            return value
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            raise SecurityError("TRUST_STORE_INVALID", "Trust registry is absent or malformed") from exc

    def provision(self) -> None:
        """Create demo credentials once; fail closed on incomplete existing state."""
        with self._lock:
            if (self.root / "registry.json").exists():
                for identity in IDENTITY_ROLES:
                    self._validate_identity(identity, allow_disabled=True)
                    location = self.identity_path(identity)
                    if not (location / "tls.key").is_file() or not (location / "signing.key").is_file():
                        raise SecurityError("CREDENTIALS_MISSING", f"Private credentials missing for {identity}")
                return
            if self.ca_cert_path.exists() or (self.root / "ca" / "ca.key").exists():
                raise SecurityError("PROVISION_INCOMPLETE", "Partial PKI exists; restore it or use a new data directory")
            now = _now()
            ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Vehicular Demo Local CA")])
            ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
                  .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
                  .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=3650))
                  .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
                  .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
                  .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
                  .sign(ca_key, hashes.SHA256()))
            _atomic_write(self.root / "ca" / "ca.key", ca_key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption()), private=True)
            _atomic_write(self.ca_cert_path, ca.public_bytes(serialization.Encoding.PEM))
            registry = {"version": 1, "ca_fingerprint": ca.fingerprint(hashes.SHA256()).hex(), "identities": {}}
            for identity, role in IDENTITY_ROLES.items():
                tls_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
                signing_key = ed25519.Ed25519PrivateKey.generate()
                public_raw = signing_key.public_key().public_bytes(
                    serialization.Encoding.Raw, serialization.PublicFormat.Raw)
                san = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                       x509.UniformResourceIdentifier(f"urn:vehicular:{identity}")]
                if identity.startswith("vehicle-"):
                    san.append(x509.DNSName(f"MPyC party {ord(identity[-1]) - ord('a')}"))
                certificate = (x509.CertificateBuilder()
                    .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, identity)]))
                    .issuer_name(ca.subject).public_key(tls_key.public_key())
                    .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
                    .not_valid_after(now + timedelta(days=365))
                    .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                    .add_extension(x509.KeyUsage(True, False, True, False, False, False, False, False, False), critical=True)
                    .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH, ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
                    .add_extension(x509.SubjectAlternativeName(san), critical=False)
                    .add_extension(x509.UnrecognizedExtension(APP_KEY_OID, hashlib.sha256(public_raw).digest()), critical=False)
                    .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
                    .sign(ca_key, hashes.SHA256()))
                location = self.identity_path(identity)
                _atomic_write(location / "tls.key", tls_key.private_bytes(serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8, serialization.NoEncryption()), private=True)
                _atomic_write(location / "tls.crt", certificate.public_bytes(serialization.Encoding.PEM))
                _atomic_write(location / "signing.key", signing_key.private_bytes(serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8, serialization.NoEncryption()), private=True)
                _atomic_write(location / "signing.pub", signing_key.public_key().public_bytes(serialization.Encoding.PEM,
                    serialization.PublicFormat.SubjectPublicKeyInfo))
                registry["identities"][identity] = {"id": identity, "role": role, "enabled": True,
                    "cert_fingerprint": certificate.fingerprint(hashes.SHA256()).hex(),
                    "signing_public_key": _b64(public_raw),
                    "valid_from": certificate.not_valid_before_utc.isoformat(),
                    "valid_until": certificate.not_valid_after_utc.isoformat()}
            _atomic_write(self.root / "registry.json", canonical_bytes(registry), private=True)

    def identities(self) -> list[dict]:
        return [dict(entry) for entry in self._registry()["identities"].values()]

    def set_enabled(self, identity: str, enabled: bool) -> None:
        """Administrative operation; caller is responsible for admin authorization."""
        if not isinstance(enabled, bool):
            raise SecurityError("INVALID_STATUS", "Identity status must be boolean")
        with self._lock:
            registry = self._registry()
            if identity not in registry["identities"]:
                raise SecurityError("UNKNOWN_IDENTITY", "Identity is not registered")
            registry["identities"][identity]["enabled"] = enabled
            _atomic_write(self.root / "registry.json", canonical_bytes(registry), private=True)

    def _validate_identity(self, identity: str, *, allow_disabled: bool = False,
                           certificate: x509.Certificate | None = None) -> dict:
        registry = self._registry()
        entry = registry["identities"].get(identity)
        if not entry or identity not in IDENTITY_ROLES:
            raise SecurityError("UNKNOWN_IDENTITY", "Identity is not registered")
        if entry.get("enabled") is not True and not allow_disabled:
            raise SecurityError("IDENTITY_DISABLED", f"Identity {identity} is disabled")
        try:
            ca = x509.load_pem_x509_certificate(self.ca_cert_path.read_bytes())
            cert = certificate or x509.load_pem_x509_certificate((self.identity_path(identity) / "tls.crt").read_bytes())
            if ca.fingerprint(hashes.SHA256()).hex() != registry["ca_fingerprint"]:
                raise SecurityError("UNTRUSTED_CA", "CA fingerprint differs from pinned trust root")
            if cert.fingerprint(hashes.SHA256()).hex() != entry["cert_fingerprint"]:
                raise SecurityError("CERTIFICATE_UNREGISTERED", "Certificate does not match registered identity")
            now = _now()
            if not (_validity(ca)[0] <= now <= _validity(ca)[1]):
                raise SecurityError("CA_EXPIRED", "Local CA is outside its validity period")
            if not (_validity(cert)[0] <= now <= _validity(cert)[1]):
                raise SecurityError("CERTIFICATE_EXPIRED", "Certificate is outside its validity period")
            if not ca.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
                raise SecurityError("UNTRUSTED_CA", "Trust root is not a CA")
            if not ca.extensions.get_extension_for_class(x509.KeyUsage).value.key_cert_sign:
                raise SecurityError("UNTRUSTED_CA", "CA is not permitted to sign certificates")
            ca_public = ca.public_key()
            if not isinstance(ca_public, rsa.RSAPublicKey):
                raise SecurityError("UNTRUSTED_CA", "Unsupported local CA key")
            ca_public.verify(ca.signature, ca.tbs_certificate_bytes, padding.PKCS1v15(), ca.signature_hash_algorithm)
            if cert.issuer != ca.subject:
                raise SecurityError("UNTRUSTED_CA", "Certificate issuer differs from the trust root")
            ca_public.verify(cert.signature, cert.tbs_certificate_bytes, padding.PKCS1v15(), cert.signature_hash_algorithm)
            if cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
                raise SecurityError("CERTIFICATE_PURPOSE", "Participant certificate cannot be a CA")
            eku = cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
            if ExtendedKeyUsageOID.CLIENT_AUTH not in eku or ExtendedKeyUsageOID.SERVER_AUTH not in eku:
                raise SecurityError("CERTIFICATE_PURPOSE", "Certificate lacks the required TLS purposes")
            names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            if f"urn:vehicular:{identity}" not in names.get_values_for_type(x509.UniformResourceIdentifier):
                raise SecurityError("IDENTITY_MISMATCH", "Certificate identity is not the registered identity")
            public_raw = _unb64(entry["signing_public_key"])
            binding = cert.extensions.get_extension_for_oid(APP_KEY_OID).value.value
            if binding != hashlib.sha256(public_raw).digest():
                raise SecurityError("SIGNING_KEY_MISMATCH", "Signing public key is not bound to the certificate")
            ed25519.Ed25519PublicKey.from_public_bytes(public_raw)
            return dict(entry)
        except SecurityError:
            raise
        except (OSError, ValueError, TypeError, KeyError, x509.ExtensionNotFound, InvalidSignature) as exc:
            raise SecurityError("CERTIFICATE_INVALID", "Certificate chain or key binding validation failed") from exc

    def authenticated_identity(self, certificate_der: bytes, expected: str | None = None) -> str:
        """Map an actual TLS peer certificate to its pinned, enabled identity."""
        try:
            certificate = x509.load_der_x509_certificate(certificate_der)
        except (TypeError, ValueError) as exc:
            raise SecurityError("CERTIFICATE_INVALID", "Malformed TLS peer certificate") from exc
        fingerprint = certificate.fingerprint(hashes.SHA256()).hex()
        matches = [i["id"] for i in self.identities() if i["cert_fingerprint"] == fingerprint]
        if len(matches) != 1:
            raise SecurityError("CERTIFICATE_UNREGISTERED", "TLS peer certificate is not registered")
        identity = matches[0]
        if expected is not None and expected != identity:
            raise SecurityError("IDENTITY_MISMATCH", "TLS peer is not the expected identity")
        self._validate_identity(identity, certificate=certificate)
        return identity

    def tls_context(self, identity: str, *, server: bool = False) -> ssl.SSLContext:
        self._validate_identity(identity)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER if server else ssl.PROTOCOL_TLS_CLIENT)
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        context.maximum_version = ssl.TLSVersion.TLSv1_3
        context.verify_mode = ssl.CERT_REQUIRED
        context.load_verify_locations(cafile=str(self.ca_cert_path))
        location = self.identity_path(identity)
        context.load_cert_chain(str(location / "tls.crt"), str(location / "tls.key"))
        return context

    def sign(self, signer: str, payload: dict) -> dict:
        entry = self._validate_identity(signer)
        if not isinstance(payload, dict):
            raise SecurityError("INVALID_PAYLOAD", "Signed payload must be a JSON object")
        encoded = canonical_bytes(payload)
        try:
            key = serialization.load_pem_private_key((self.identity_path(signer) / "signing.key").read_bytes(), password=None)
            if not isinstance(key, ed25519.Ed25519PrivateKey):
                raise ValueError("Wrong key type")
            raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
            if raw != _unb64(entry["signing_public_key"]):
                raise SecurityError("SIGNING_KEY_MISMATCH", "Private signing key differs from the registered key")
            # Roundtrip prevents caller mutations from changing the returned payload.
            return {"signer": signer, "payload": json.loads(encoded), "signature": _b64(key.sign(encoded))}
        except SecurityError:
            raise
        except (OSError, ValueError, TypeError) as exc:
            raise SecurityError("SIGNING_KEY_INVALID", "Private signing credential is unavailable or invalid") from exc

    def verify(self, envelope: dict, expected_signer: str | None = None) -> dict:
        if not isinstance(envelope, dict) or not isinstance(envelope.get("signer"), str) or not isinstance(envelope.get("payload"), dict):
            raise SecurityError("INVALID_ENVELOPE", "Expected signer, object payload and signature")
        signer = envelope["signer"]
        if expected_signer is not None and signer != expected_signer:
            raise SecurityError("IDENTITY_MISMATCH", "Signature is not from the expected signer")
        entry = self._validate_identity(signer)
        try:
            key = ed25519.Ed25519PublicKey.from_public_bytes(_unb64(entry["signing_public_key"]))
            encoded = canonical_bytes(envelope["payload"])
            key.verify(_unb64(envelope.get("signature")), encoded)
            return json.loads(encoded)
        except InvalidSignature as exc:
            raise SecurityError("SIGNATURE_INVALID", "Application signature validation failed") from exc


def encrypt_object(payload: dict, key: bytes, *, context: str = "export") -> dict:
    if not isinstance(payload, dict):
        raise SecurityError("INVALID_PAYLOAD", "Encrypted payload must be a JSON object")
    if not isinstance(key, bytes) or len(key) != 32:
        raise SecurityError("KEY_INVALID", "AES-256-GCM requires a 32-byte key")
    if not isinstance(context, str) or not context:
        raise SecurityError("CONTEXT_INVALID", "Encryption context is required")
    nonce = secrets.token_bytes(12)
    aad = canonical_bytes({"algorithm": "AES-256-GCM", "version": 1, "context": context})
    ciphertext = AESGCM(key).encrypt(nonce, canonical_bytes(payload), aad)
    return {"algorithm": "AES-256-GCM", "version": 1, "nonce": _b64(nonce), "ciphertext": _b64(ciphertext)}


def decrypt_object(envelope: dict, key: bytes, *, context: str = "export") -> dict:
    if not isinstance(key, bytes) or len(key) != 32:
        raise SecurityError("KEY_INVALID", "AES-256-GCM requires a 32-byte key")
    if not isinstance(context, str) or not context:
        raise SecurityError("CONTEXT_INVALID", "Encryption context is required")
    if not isinstance(envelope, dict) or envelope.get("algorithm") != "AES-256-GCM" or envelope.get("version") != 1:
        raise SecurityError("AEAD_INVALID", "Unsupported authenticated object format")
    try:
        nonce = _unb64(envelope.get("nonce"))
        if len(nonce) != 12:
            raise SecurityError("AEAD_INVALID", "Invalid AES-GCM nonce")
        aad = canonical_bytes({"algorithm": "AES-256-GCM", "version": 1, "context": context})
        plaintext = AESGCM(key).decrypt(nonce, _unb64(envelope.get("ciphertext")), aad)
        payload = json.loads(plaintext)
        if not isinstance(payload, dict):
            raise ValueError("Payload must be an object")
        return payload
    except (InvalidTag, ValueError, TypeError, UnicodeError) as exc:
        raise SecurityError("AEAD_INVALID", "Authenticated decryption failed") from exc


def _file_context(path: Path, context: str | None) -> tuple[str, str]:
    """Bind storage to a logical purpose and filename, independent of its root."""
    logical_context = "local-file" if context is None else context
    if not isinstance(logical_context, str) or not logical_context:
        raise SecurityError("CONTEXT_INVALID", "Encryption context is required")
    binding = {"format": "vehicular-local-file", "version": 2,
               "filename": path.name, "context": logical_context}
    return logical_context, canonical_bytes(binding).decode("utf-8")


def secure_write(path: Path, key: bytes, payload: dict, *, context: str | None = None) -> None:
    """Write a portable authenticated file without binding its absolute root.

    A filename still identifies the object after the project/data directory is
    moved. Callers sharing a key across purposes should pass an explicit stable
    context on both write and read. The general encrypt_object wire format is
    unchanged; this local storage wrapper authenticates its own v2 metadata.
    """
    path = Path(path)
    logical_context, binding = _file_context(path, context)
    envelope = {"format": "vehicular-local-file", "version": 2,
                "filename": path.name, "context": logical_context,
                "encrypted": encrypt_object(payload, key, context=binding)}
    _atomic_write(path, canonical_bytes(envelope), private=True)


def _read_encrypted_file(path: Path) -> dict:
    try:
        envelope = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError, UnicodeError) as exc:
        raise SecurityError("AEAD_INVALID", "Encrypted object cannot be read") from exc
    if not isinstance(envelope, dict):
        raise SecurityError("AEAD_INVALID", "Encrypted file must contain an object")
    return envelope


def _decrypt_file(path: Path, envelope: dict, key: bytes, context: str | None) -> dict:
    logical_context, binding = _file_context(path, context)
    if envelope.get("version") == 1 and "format" not in envelope:
        # Legacy ciphertext remains readable at its original path. Do not try
        # guessed old paths: exporting it requires explicit migration first.
        if context is not None:
            raise SecurityError("CONTEXT_INVALID", "Legacy encrypted files have no logical context; migrate them first")
        return decrypt_object(envelope, key, context="local-file:" + str(path.resolve()))
    if (set(envelope) != {"format", "version", "filename", "context", "encrypted"} or
            envelope.get("format") != "vehicular-local-file" or
            type(envelope.get("version")) is not int or envelope["version"] != 2 or
            envelope.get("filename") != path.name or envelope.get("context") != logical_context):
        raise SecurityError("AEAD_INVALID", "Encrypted file format or object context does not match")
    return decrypt_object(envelope["encrypted"], key, context=binding)


def secure_read(path: Path, key: bytes, *, context: str | None = None) -> dict:
    """Read v2 files after relocation, or legacy v1 files at their old path."""
    path = Path(path)
    return _decrypt_file(path, _read_encrypted_file(path), key, context)


def migrate_encrypted_file(path: Path, key: bytes, *, context: str | None = None) -> bool:
    """Authenticate and atomically upgrade an old file before relocating data.

    Returns True when a legacy file was rewritten, or False for an already-v2
    file after verifying its authentication. Migration must run at the original
    legacy location with the original key. Invalid ciphertext is never replaced.
    """
    path = Path(path)
    envelope = _read_encrypted_file(path)
    if envelope.get("version") == 1 and "format" not in envelope:
        payload = _decrypt_file(path, envelope, key, None)
        secure_write(path, key, payload, context=context)
        return True
    _decrypt_file(path, envelope, key, context)
    return False


class AuditLog:
    """Append-only hash chain with an external, report-signed checkpoint file.

    Local files remain under the administrator's trust boundary. Export a
    checkpoint to a separately protected verifier to detect full-directory
    rewrites. A hash chain alone cannot provide that guarantee.
    """

    def __init__(self, db_path: Path, security: SecurityStore):
        self.db_path = Path(db_path).resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.security = security
        self.checkpoint_path = self.db_path.with_suffix(self.db_path.suffix + ".checkpoint.json")
        with _LOCKS_GUARD:
            self._lock = _LOCKS.setdefault(str(self.db_path), threading.RLock())
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY, event TEXT NOT NULL)")

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(str(self.db_path), timeout=30)
        try:
            db.execute("PRAGMA busy_timeout=30000")
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _chain(db: sqlite3.Connection) -> tuple[int, str]:
        head, count = GENESIS, 0
        for row_id, encoded in db.execute("SELECT id,event FROM audit_events ORDER BY id"):
            try:
                event = json.loads(encoded)
                supplied_hash = event.pop("hash")
                count += 1
                if row_id != count or event["id"] != count or event["prev_hash"] != head:
                    raise ValueError("sequence or previous hash mismatch")
                if set(event) != {"id", "at", "kind", "details", "claimed_identity", "verified_identity", "prev_hash"}:
                    raise ValueError("event fields mismatch")
                if supplied_hash != hashlib.sha256(canonical_bytes(event)).hexdigest():
                    raise ValueError("event hash mismatch")
                head = supplied_hash
            except (ValueError, KeyError, TypeError, AttributeError) as exc:
                raise SecurityError("AUDIT_CHAIN_INVALID", f"Audit event {row_id} is invalid") from exc
        return count, head

    def _read_checkpoint(self) -> dict | None:
        if not self.checkpoint_path.exists():
            return None
        try:
            return json.loads(self.checkpoint_path.read_text("utf-8"))
        except (OSError, ValueError, UnicodeError) as exc:
            raise SecurityError("AUDIT_CHECKPOINT_INVALID", "Audit checkpoint cannot be read") from exc

    def _check_checkpoint(self, count: int, head: str, checkpoint: dict | None,
                          *, db: sqlite3.Connection | None = None, allow_extension: bool = False) -> None:
        if checkpoint is None:
            if count:
                raise SecurityError("AUDIT_CHECKPOINT_MISSING", "Nonempty audit chain has no trusted checkpoint")
            return
        payload = self.security.verify(checkpoint, expected_signer="report")
        if payload.get("type") != "audit-checkpoint" or payload.get("database") != self.db_path.name:
            raise SecurityError("AUDIT_CHECKPOINT_INVALID", "Checkpoint belongs to another audit context")
        anchored_count, anchored_head = payload.get("count"), payload.get("head")
        if type(anchored_count) is not int or anchored_count < 0 or not isinstance(anchored_head, str):
            raise SecurityError("AUDIT_CHECKPOINT_INVALID", "Checkpoint sequence and head are malformed")
        if allow_extension and anchored_count < count and db is not None:
            row = db.execute("SELECT event FROM audit_events WHERE id=?", (anchored_count,)).fetchone()
            actual_head = GENESIS if anchored_count == 0 else json.loads(row[0])["hash"] if row else None
            if actual_head == anchored_head:
                return
        if anchored_count != count or anchored_head != head:
            raise SecurityError("AUDIT_CHECKPOINT_MISMATCH", "Audit chain differs from its signed checkpoint")

    def _sign_checkpoint(self, count: int, head: str) -> dict:
        return self.security.sign("report", {"type": "audit-checkpoint", "database": self.db_path.name,
            "count": count, "head": head, "at": _at()})

    def append(self, kind: str, details: dict, claimed_identity: str | None = None,
               verified_identity: str | None = None) -> dict:
        if not isinstance(kind, str) or not kind or not isinstance(details, dict):
            raise SecurityError("AUDIT_EVENT_INVALID", "Audit kind and object details are required")
        # Ensure the complete event is JSON before entering a transaction.
        canonical_bytes(details)
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            count, head = self._chain(db)
            self._check_checkpoint(count, head, self._read_checkpoint())
            event = {"id": count + 1, "at": _at(), "kind": kind, "details": details,
                     "claimed_identity": claimed_identity, "verified_identity": verified_identity, "prev_hash": head}
            event["hash"] = hashlib.sha256(canonical_bytes(event)).hexdigest()
            db.execute("INSERT INTO audit_events(id,event) VALUES (?,?)", (event["id"], canonical_bytes(event).decode("utf-8")))
            # The SQLite write lock serializes independent processes while the
            # external anchor is written. Interrupted writes fail verification.
            checkpoint = self._sign_checkpoint(count + 1, event["hash"])
            _atomic_write(self.checkpoint_path, canonical_bytes(checkpoint), private=True)
            return json.loads(canonical_bytes(event))

    def list(self, limit: int = 100) -> list[dict]:
        limit = max(1, min(int(limit), 1000))
        with self._lock, self._connect() as db:
            try:
                return [json.loads(row[0]) for row in db.execute("SELECT event FROM audit_events ORDER BY id DESC LIMIT ?", (limit,))]
            except ValueError as exc:
                raise SecurityError("AUDIT_CHAIN_INVALID", "Audit records are malformed") from exc

    def checkpoint(self) -> dict:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            count, head = self._chain(db)
            current = self._read_checkpoint()
            self._check_checkpoint(count, head, current)
            if current is not None:
                return current
            checkpoint = self._sign_checkpoint(count, head)
            _atomic_write(self.checkpoint_path, canonical_bytes(checkpoint), private=True)
            return checkpoint

    def verify(self, checkpoint: dict | None = None) -> dict:
        try:
            with self._lock, self._connect() as db:
                db.execute("BEGIN IMMEDIATE")
                count, head = self._chain(db)
                self._check_checkpoint(count, head, checkpoint if checkpoint is not None else self._read_checkpoint(),
                                       db=db, allow_extension=checkpoint is not None)
                return {"valid": True, "count": count, "head": head, "reason": "Signed checkpoint and hash chain verified"}
        except (SecurityError, sqlite3.DatabaseError) as exc:
            return {"valid": False, "count": 0, "reason": str(exc), "code": getattr(exc, "code", "AUDIT_DATABASE_INVALID")}
