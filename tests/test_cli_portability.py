"""Exercise the documented CLI against independent project/data directories."""
import base64
import json
import os
from pathlib import Path
import secrets
import shutil
import sys

import pytest

from vehicular import cli
from vehicular.lifecycle import AlreadyRunningError, ProjectLease
from vehicular.security import SecurityError, SecurityStore, canonical_bytes, encrypt_object, secure_read, secure_write


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    for name in list(os.environ):
        if name.startswith("VECTRA_") or name.startswith("LLM_"):
            monkeypatch.delenv(name)


def _command(monkeypatch, project, command, *options):
    monkeypatch.setattr(sys, "argv", ["vectra", command, "--project-dir", str(project), *options])
    cli.main()


def _project(tmp_path, *, data_name="private runtime"):
    project = tmp_path / "独立项目 with spaces"
    project.mkdir()
    (project / ".env").write_text(f"VECTRA_DATA_DIR={data_name}\n", encoding="utf-8-sig")
    return project, project / data_name


def _legacy_report(path, key, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_bytes(encrypt_object(payload, key, context="local-file:" + str(path.resolve()))))


def test_check_uses_explicit_project_directory_and_omits_credentials(tmp_path, monkeypatch, capsys):
    project, runtime = _project(tmp_path)
    (project / ".env").write_text(
        "VECTRA_DATA_DIR=private runtime\nVECTRA_MODE=llm\n"
        "LLM_API_KEY=cli-test-private-key\nLLM_MODEL=test-model\nVECTRA_PORT=8244\n", encoding="utf-8"
    )
    elsewhere = tmp_path / "unrelated caller"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    monkeypatch.setenv("VECTRA_PROJECT_DIR", str(elsewhere))
    _command(monkeypatch, project, "check")
    captured = capsys.readouterr()
    result = json.loads(captured.out)
    assert result == {"project_dir": str(project), "data_dir": str(runtime), "mode": "llm",
                      "host": "127.0.0.1", "port": 8244, "web_assets": True}
    assert "cli-test-private-key" not in captured.out + captured.err
    assert not runtime.exists()
    assert not (project / ".vectra").exists()


def test_check_port_override_validates_instead_of_falling_back_to_default(tmp_path, monkeypatch, capsys):
    project, _ = _project(tmp_path)
    _command(monkeypatch, project, "check", "--port", "8128")
    assert json.loads(capsys.readouterr().out)["port"] == 8128
    with pytest.raises(ValueError, match="VECTRA_PORT"):
        _command(monkeypatch, project, "check", "--port", "0")


def test_repeated_init_preserves_ca_identity_keys_and_private_samples(tmp_path, monkeypatch, capsys):
    project, runtime = _project(tmp_path)
    _command(monkeypatch, project, "init")
    first_output = capsys.readouterr().out
    assert str(runtime) in first_output
    before = {path.relative_to(runtime): path.read_bytes() for path in runtime.rglob("*") if path.is_file()}
    security = SecurityStore(runtime)
    signed = security.sign("report", {"task_id": "persisted", "average_speed": 40})
    assert len(security.identities()) == 7
    assert Path("ca/ca.key") in before
    assert Path("identities/report/signing.key") in before
    assert Path("vehicles/vehicle-a/sample.enc") in before

    _command(monkeypatch, project, "init")
    capsys.readouterr()
    after = {path.relative_to(runtime): path.read_bytes() for path in runtime.rglob("*") if path.is_file()}
    assert after == before
    assert SecurityStore(runtime).verify(signed, "report") == signed["payload"]


def test_migrate_data_uses_report_key_upgrades_legacy_and_verifies_repeat(tmp_path, monkeypatch, capsys):
    project, runtime = _project(tmp_path)
    reports = runtime / "reports"
    reports.mkdir(parents=True)
    report_key = secrets.token_bytes(32)
    (reports / "storage.key").write_bytes(report_key)
    # A different key outside reports must never be used for report migration.
    (runtime / "storage.key").write_bytes(secrets.token_bytes(32))
    payload = {"signer": "report", "payload": {"task_id": "001", "average_speed": 40}, "signature": "preserved"}
    path = reports / "001.enc"
    _legacy_report(path, report_key, payload)
    old_bytes = path.read_bytes()
    _command(monkeypatch, project, "migrate-data")
    assert "1 legacy reports converted" in capsys.readouterr().out
    assert path.read_bytes() != old_bytes
    assert json.loads(path.read_text("utf-8"))["version"] == 2
    assert secure_read(path, report_key) == payload
    migrated_bytes = path.read_bytes()

    _command(monkeypatch, project, "migrate-data")
    repeat = capsys.readouterr().out
    assert "0 legacy reports converted" in repeat
    assert "1 portable reports verified" in repeat
    assert path.read_bytes() == migrated_bytes
    assert (reports / "storage.key").read_bytes() == report_key
    relocated = tmp_path / "another computer" / "reports"
    shutil.copytree(reports, relocated)
    assert secure_read(relocated / path.name, (relocated / "storage.key").read_bytes()) == payload


@pytest.mark.parametrize("command", ["init", "migrate-data"])
def test_mutating_cli_commands_refuse_running_project(tmp_path, monkeypatch, command):
    project, runtime = _project(tmp_path)
    reports = runtime / "reports"
    reports.mkdir(parents=True)
    key = secrets.token_bytes(32)
    (reports / "storage.key").write_bytes(key)
    report = reports / "original.enc"
    _legacy_report(report, key, {"task_id": "original"})
    before = report.read_bytes()
    with ProjectLease(project):
        with pytest.raises(AlreadyRunningError, match="stop it first"):
            _command(monkeypatch, project, command)
    assert report.read_bytes() == before
    assert not (runtime / "registry.json").exists()


@pytest.mark.parametrize("legacy", [False, True])
def test_cli_migration_rejects_corruption_and_preserves_original(tmp_path, monkeypatch, legacy):
    project, runtime = _project(tmp_path)
    reports = runtime / "reports"
    reports.mkdir(parents=True)
    key = secrets.token_bytes(32)
    (reports / "storage.key").write_bytes(key)
    path = reports / "corrupt.enc"
    if legacy:
        _legacy_report(path, key, {"task_id": "corrupt"})
    else:
        secure_write(path, key, {"task_id": "corrupt"})
    envelope = json.loads(path.read_text("utf-8"))
    encrypted = envelope if legacy else envelope["encrypted"]
    ciphertext = bytearray(base64.b64decode(encrypted["ciphertext"]))
    ciphertext[0] ^= 1
    encrypted["ciphertext"] = base64.b64encode(ciphertext).decode("ascii")
    path.write_bytes(canonical_bytes(envelope))
    corrupted = path.read_bytes()
    with pytest.raises(SecurityError) as failure:
        _command(monkeypatch, project, "migrate-data")
    assert failure.value.code == "AEAD_INVALID"
    assert path.read_bytes() == corrupted
    assert (reports / "storage.key").read_bytes() == key
    # Failure also releases maintenance ownership for later recovery.
    with ProjectLease(project):
        pass


def test_cli_migration_missing_report_key_fails_without_replacing_report(tmp_path, monkeypatch):
    project, runtime = _project(tmp_path)
    report = runtime / "reports/missing-key.enc"
    _legacy_report(report, secrets.token_bytes(32), {"task_id": "missing-key"})
    before = report.read_bytes()
    with pytest.raises(RuntimeError, match="storage.key is missing"):
        _command(monkeypatch, project, "migrate-data")
    assert report.read_bytes() == before
    assert not (report.parent / "storage.key").exists()


def test_cli_migration_empty_new_project_needs_no_storage_key(tmp_path, monkeypatch, capsys):
    project, runtime = _project(tmp_path)
    _command(monkeypatch, project, "migrate-data")
    assert "0 legacy reports converted; 0 portable reports verified" in capsys.readouterr().out
    assert not runtime.exists()
