"""Moving data preserves authenticated storage without weakening its bindings."""
import base64
import json
from pathlib import Path
import secrets
import shutil

import pytest

from vehicular.mpc import initialize_samples
from vehicular.mpc_party import read_local_sample
from vehicular.mpc import MpcError
from vehicular import security
from vehicular.security import (
    SecurityError, canonical_bytes, encrypt_object, migrate_encrypted_file,
    secure_read, secure_write,
)


def _legacy(path: Path, key: bytes, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_bytes(encrypt_object(
        payload, key, context="local-file:" + str(path.resolve()))))


def test_private_atomic_write_has_no_permission_failure_after_commit(tmp_path, monkeypatch):
    path = tmp_path / "model-settings.enc"
    key = secrets.token_bytes(32)
    secure_write(path, key, {"mode": "demo"})
    real_chmod = security.os.chmod
    permission_targets = []

    def temporary_permissions_only(target, mode):
        permission_targets.append(Path(target))
        if Path(target) == path:
            raise PermissionError("cannot change committed target permissions")
        return real_chmod(target, mode)

    monkeypatch.setattr(security.os, "chmod", temporary_permissions_only)
    secure_write(path, key, {"mode": "llm"})
    assert permission_targets and path not in permission_targets
    assert secure_read(path, key) == {"mode": "llm"}
    committed = path.read_bytes()

    def denied_permissions(target, mode):
        raise PermissionError("temporary permission setup denied")

    monkeypatch.setattr(security.os, "chmod", denied_permissions)
    with pytest.raises(PermissionError):
        secure_write(path, key, {"mode": "demo"})
    assert path.read_bytes() == committed
    assert not list(tmp_path.glob("*.tmp"))


def test_report_directory_can_move_to_another_project_root(tmp_path):
    source = tmp_path / "old computer" / "runtime" / "reports"
    destination = tmp_path / "new computer" / "renamed project" / "runtime" / "reports"
    source.mkdir(parents=True)
    key = secrets.token_bytes(32)
    (source / "storage.key").write_bytes(key)
    payload = {"signer": "report", "payload": {"task_id": "123", "average_speed": 40},
               "signature": "signature bytes are preserved"}
    secure_write(source / "123.enc", key, payload)
    shutil.copytree(source, destination)
    assert secure_read(destination / "123.enc", (destination / "storage.key").read_bytes()) == payload


def test_renamed_ciphertext_and_rewritten_filename_metadata_are_rejected(tmp_path):
    key = secrets.token_bytes(32)
    original = tmp_path / "task-123.enc"
    renamed = tmp_path / "task-124.enc"
    secure_write(original, key, {"task_id": "123"})
    shutil.copyfile(original, renamed)
    with pytest.raises(SecurityError) as failure:
        secure_read(renamed, key)
    assert failure.value.code == "AEAD_INVALID"
    envelope = json.loads(renamed.read_text("utf-8"))
    envelope["filename"] = renamed.name
    renamed.write_text(json.dumps(envelope), "utf-8")
    with pytest.raises(SecurityError) as failure:
        secure_read(renamed, key)
    assert failure.value.code == "AEAD_INVALID"


def test_explicit_purpose_and_tampered_purpose_are_rejected(tmp_path):
    key = secrets.token_bytes(32)
    path = tmp_path / "sample.enc"
    secure_write(path, key, {"speed": 60}, context="vehicle-a")
    assert secure_read(path, key, context="vehicle-a") == {"speed": 60}
    with pytest.raises(SecurityError):
        secure_read(path, key, context="vehicle-b")
    with pytest.raises(SecurityError):
        secure_read(path, key)
    envelope = json.loads(path.read_text("utf-8"))
    envelope["context"] = "vehicle-b"
    path.write_text(json.dumps(envelope), "utf-8")
    with pytest.raises(SecurityError) as failure:
        secure_read(path, key, context="vehicle-b")
    assert failure.value.code == "AEAD_INVALID"


def test_legacy_files_read_at_original_path_and_migrate_before_copy(tmp_path):
    key = secrets.token_bytes(32)
    source = tmp_path / "legacy" / "123.enc"
    payload = {"task_id": "123", "average_speed": 40}
    _legacy(source, key, payload)
    assert secure_read(source, key) == payload
    destination = tmp_path / "relocated" / source.name
    destination.parent.mkdir()
    shutil.copyfile(source, destination)
    with pytest.raises(SecurityError):
        secure_read(destination, key)
    with pytest.raises(SecurityError):
        migrate_encrypted_file(destination, key)
    assert migrate_encrypted_file(source, key)
    assert not migrate_encrypted_file(source, key)
    shutil.copyfile(source, destination)
    assert secure_read(destination, key) == payload


def test_migration_can_add_an_explicit_logical_context(tmp_path):
    key = secrets.token_bytes(32)
    path = tmp_path / "123.enc"
    _legacy(path, key, {"result": 40})
    assert migrate_encrypted_file(path, key, context="reports")
    assert not migrate_encrypted_file(path, key, context="reports")
    assert secure_read(path, key, context="reports") == {"result": 40}
    with pytest.raises(SecurityError):
        secure_read(path, key)


@pytest.mark.parametrize("legacy", [False, True])
def test_corrupt_ciphertext_is_rejected_and_never_replaced_by_migration(tmp_path, legacy):
    key = secrets.token_bytes(32)
    path = tmp_path / "123.enc"
    if legacy:
        _legacy(path, key, {"result": 40})
    else:
        secure_write(path, key, {"result": 40})
    envelope = json.loads(path.read_text("utf-8"))
    encrypted = envelope if legacy else envelope["encrypted"]
    ciphertext = bytearray(base64.b64decode(encrypted["ciphertext"]))
    ciphertext[0] ^= 1
    encrypted["ciphertext"] = base64.b64encode(ciphertext).decode("ascii")
    path.write_text(json.dumps(envelope), "utf-8")
    before = path.read_bytes()
    with pytest.raises(SecurityError) as failure:
        secure_read(path, key)
    assert failure.value.code == "AEAD_INVALID"
    with pytest.raises(SecurityError):
        migrate_encrypted_file(path, key)
    assert path.read_bytes() == before


def test_vehicle_samples_relocate_with_independent_keys_and_identity_binding(tmp_path):
    source = tmp_path / "source runtime"
    destination = tmp_path / "destination runtime"
    initialize_samples(source)
    keys = [(source / "vehicles" / vehicle_id / "storage.key").read_bytes()
            for vehicle_id in ("vehicle-a", "vehicle-b", "vehicle-c")]
    assert len(set(keys)) == 3
    shutil.copytree(source, destination)
    task = {"road": "S101", "window_seconds": 60}
    assert read_local_sample(destination, "vehicle-a", task) == 6000
    assert read_local_sample(destination, "vehicle-b", task) == 4000
    shutil.copyfile(destination / "vehicles" / "vehicle-a" / "sample.enc",
                    destination / "vehicles" / "vehicle-b" / "sample.enc")
    with pytest.raises(MpcError):
        read_local_sample(destination, "vehicle-b", task)
    # Even an accidental key copy cannot turn vehicle-a input into vehicle-b.
    shutil.copyfile(destination / "vehicles" / "vehicle-a" / "storage.key",
                    destination / "vehicles" / "vehicle-b" / "storage.key")
    with pytest.raises(MpcError):
        read_local_sample(destination, "vehicle-b", task)
