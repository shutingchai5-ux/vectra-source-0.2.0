"""Exercise transferable source packages without installing or copying a venv."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace
import zipfile

import pytest


SOURCE_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def portable_project(tmp_path):
    # Both spaces and non-ASCII text occur in real Windows project directories.
    root = tmp_path / "移动项目 source code"
    root.mkdir()
    for filename in ("run.py", "pyproject.toml", "README.md", ".env.example"):
        shutil.copy2(SOURCE_ROOT / filename, root / filename)
    for directory in ("vehicular", "web", "scripts", "docs"):
        source = SOURCE_ROOT / directory
        if source.is_dir():
            shutil.copytree(source, root / directory,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    # Migration must not leak machine-bound environments or local identities.
    forbidden = (
        ".env", ".venv/pyvenv.cfg", "runtime/identities/coordinator/signing.key",
        "runtime.backup/identities/coordinator/signing.key", "dist/old.zip",
        "artifacts/local-evidence.json", ".pytest_cache/state", ".git/config",
        "vehicular/__pycache__/config.pyc",
    )
    for relative in forbidden:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("private local material", encoding="utf-8")
    return root, forbidden


def invoke_launcher(root, cwd, *arguments):
    environment = os.environ.copy()
    environment["PYTHONUTF8"] = "1"
    return subprocess.run(
        [sys.executable, str(root / "run.py"), *arguments], cwd=cwd,
        env=environment, capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=30,
    )


@pytest.fixture
def launcher_module(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("vectra_launcher_under_test", SOURCE_ROOT / "run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = tmp_path / "launcher project"
    environment = root / ".venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    python.parent.mkdir(parents=True)
    python.write_text("fake interpreter - never executed", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", root)
    monkeypatch.setattr(module, "ENV_DIR", environment)
    monkeypatch.setattr(module, "PYTHON", python)
    monkeypatch.setattr(module, "STAMP", environment / ".vectra-environment.json")
    monkeypatch.setattr(module, "STATE", root / ".vectra/server.json")
    return module


@pytest.mark.parametrize("exit_code", [0, 7])
def test_interrupts_wait_for_child_without_forcing_termination(
        launcher_module, monkeypatch, capsys, exit_code):
    class ForegroundChild:
        wait_calls = 0

        def wait(self):
            self.wait_calls += 1
            if self.wait_calls <= 2:
                raise KeyboardInterrupt
            return exit_code

        def terminate(self):
            pytest.fail("Ctrl+C must allow the child to complete its shutdown")

        def kill(self):
            pytest.fail("Ctrl+C must not kill the child during shutdown")

    child = ForegroundChild()
    spawned = []

    def spawn(arguments, **options):
        spawned.append((arguments, options))
        return child

    monkeypatch.setattr(launcher_module.subprocess, "Popen", spawn)
    arguments = [launcher_module.PYTHON, "-m", "vehicular.cli", "serve"]
    assert launcher_module.execute(arguments) == exit_code
    assert len(spawned) == 1
    assert child.wait_calls == 3
    output = capsys.readouterr()
    assert output.out.count("waiting for the service to finish shutting down") == 1
    assert not output.err


@pytest.mark.parametrize("value", [None, [], "invalid metadata", 1])
def test_non_object_environment_metadata_has_actionable_error(launcher_module, value):
    launcher_module.STAMP.write_text(json.dumps(value), encoding="utf-8")
    issue = launcher_module.environment_problem()
    assert "metadata" in issue.lower() and "setup --recreate" in issue


@pytest.mark.parametrize("value", [None, [], "invalid metadata", 1])
def test_non_object_server_metadata_has_actionable_error(launcher_module, value):
    launcher_module.STATE.parent.mkdir(parents=True)
    launcher_module.STATE.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(RuntimeError, match="metadata"):
        launcher_module.read_state()


def test_copied_environment_is_rejected_before_running_its_interpreter(launcher_module, monkeypatch):
    launcher_module.STAMP.write_text(json.dumps({
        "project_dir": str(launcher_module.ROOT.parent / "old computer folder"),
        "platform": sys.platform,
    }), encoding="utf-8")

    def must_not_probe(executable):
        pytest.fail("A copied environment interpreter should not be executed")

    monkeypatch.setattr(launcher_module, "probe_python", must_not_probe)
    assert "setup --recreate" in launcher_module.environment_problem()


def test_setup_does_not_install_or_clear_metadata_while_project_is_owned(launcher_module, monkeypatch):
    from vehicular.project_lock import AlreadyRunningError, ProjectLease

    launcher_module.STATE.parent.mkdir(parents=True)
    launcher_module.STATE.write_text("active service metadata", encoding="utf-8")
    installations = []
    monkeypatch.setattr(launcher_module, "install_environment", lambda args: installations.append(args))
    arguments = SimpleNamespace(recreate=True, test=False, no_init=True)
    with ProjectLease(launcher_module.ROOT):
        with pytest.raises(AlreadyRunningError):
            launcher_module.setup(arguments)
        assert launcher_module.STATE.read_text("utf-8") == "active service metadata"
    assert not installations


def test_setup_recovers_stale_metadata_and_installs_while_holding_ownership(launcher_module, monkeypatch):
    from vehicular.project_lock import AlreadyRunningError, ProjectLease

    launcher_module.STATE.parent.mkdir(parents=True)
    launcher_module.STATE.write_text("stale or malformed service metadata", encoding="utf-8")
    installations = []

    def install(args):
        assert not launcher_module.STATE.exists()
        # Another service cannot start while setup modifies the environment.
        with pytest.raises(AlreadyRunningError):
            with ProjectLease(launcher_module.ROOT):
                pass
        installations.append(args)

    monkeypatch.setattr(launcher_module, "install_environment", install)
    arguments = SimpleNamespace(recreate=False, test=False, no_init=True)
    assert launcher_module.setup(arguments) == 0
    assert installations == [arguments]
    assert not launcher_module.STATE.exists()
    # Successful setup releases its lease for the next service invocation.
    with ProjectLease(launcher_module.ROOT):
        pass


def test_setup_releases_project_ownership_when_installation_fails(launcher_module, monkeypatch):
    from vehicular.project_lock import ProjectLease

    def failed_install(args):
        raise RuntimeError("simulated dependency installation failure")

    monkeypatch.setattr(launcher_module, "install_environment", failed_install)
    arguments = SimpleNamespace(recreate=False, test=False, no_init=True)
    with pytest.raises(RuntimeError, match="simulated dependency installation failure"):
        launcher_module.setup(arguments)
    # A failed installation must not strand an OS lock or block a retry.
    with ProjectLease(launcher_module.ROOT):
        pass


def test_launcher_help_from_an_unrelated_working_directory(portable_project, tmp_path):
    root, _ = portable_project
    caller = tmp_path / "another working directory"
    caller.mkdir()
    result = invoke_launcher(root, caller, "--help")
    assert result.returncode == 0, result.stdout + result.stderr
    for command in ("setup", "start", "stop", "check", "test", "package"):
        assert command in result.stdout


def test_source_archive_excludes_local_configuration_identity_and_environment(
        portable_project, tmp_path):
    root, forbidden = portable_project
    caller = tmp_path / "unrelated caller"
    caller.mkdir()
    output = tmp_path / "exports" / "transfer.zip"
    result = invoke_launcher(root, caller, "package", "--output", str(output))
    assert result.returncode == 0, result.stdout + result.stderr
    with zipfile.ZipFile(output) as archive:
        names = set(archive.namelist())
        assert {"run.py", "pyproject.toml", "README.md", ".env.example"} <= names
        assert "vehicular/config.py" in names
        assert not names.intersection(forbidden)
        assert all(not name.startswith((".venv/", "runtime", "artifacts/", ".git/"))
                   for name in names)
        assert all("__pycache__" not in name and not name.endswith(".pyc") for name in names)
        assert all(not Path(name).is_absolute() and ".." not in Path(name).parts for name in names)


def test_extracted_source_launcher_does_not_retain_original_project_location(
        portable_project, tmp_path):
    root, _ = portable_project
    output = tmp_path / "migration.zip"
    result = invoke_launcher(root, tmp_path, "package", "--output", str(output))
    assert result.returncode == 0, result.stdout + result.stderr
    relocated = tmp_path / "另一台电脑 source code"
    with zipfile.ZipFile(output) as archive:
        archive.extractall(relocated)
    # Removing the original proves that resolving the launcher cannot rely on it.
    assert root.resolve().is_relative_to(tmp_path.resolve())
    assert root.resolve() != tmp_path.resolve()
    shutil.rmtree(root)
    result = invoke_launcher(relocated, tmp_path, "--help")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "setup" in result.stdout and "start" in result.stdout
    assert not (relocated / ".venv").exists()
    assert not (relocated / "runtime").exists()


def test_archive_excludes_its_output_and_stale_temporary_output(portable_project, tmp_path):
    root, _ = portable_project
    output = root / "docs" / "transfer.zip"
    output.parent.mkdir(exist_ok=True)
    output.write_bytes(b"previous package")
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_bytes(b"interrupted previous package")
    result = invoke_launcher(root, tmp_path, "package", "--output", str(output))
    assert result.returncode == 0, result.stdout + result.stderr
    with zipfile.ZipFile(output) as archive:
        assert "docs/transfer.zip" not in archive.namelist()
        assert "docs/transfer.zip.tmp" not in archive.namelist()
    assert not temporary.exists()


def test_archive_excludes_a_source_directory_symlink_to_external_data(portable_project, tmp_path):
    root, _ = portable_project
    external = tmp_path / "external private records"
    external.mkdir()
    (external / "private-record.json").write_text("private external data", encoding="utf-8")
    source = root / "docs"
    preserved = root / "docs-preserved"
    assert source.resolve().is_relative_to(root.resolve())
    assert preserved.resolve().is_relative_to(root.resolve())
    source.rename(preserved)
    try:
        source.symlink_to(external, target_is_directory=True)
    except OSError as failure:
        pytest.skip(f"Directory symlink creation is not permitted: {failure}")
    output = tmp_path / "no-external-data.zip"
    result = invoke_launcher(root, tmp_path, "package", "--output", str(output))
    assert result.returncode == 0, result.stdout + result.stderr
    with zipfile.ZipFile(output) as archive:
        assert "docs/private-record.json" not in archive.namelist()
