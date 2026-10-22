#!/usr/bin/env python3
"""Portable, standard-library launcher. All paths follow this source folder."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
ENV_DIR = ROOT / ".venv"
PYTHON = ENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
STAMP = ENV_DIR / ".vectra-environment.json"
STATE = ROOT / ".vectra/server.json"


def child_environment():
    values = os.environ.copy()
    values.update(PYTHONIOENCODING="utf-8", PYTHONUTF8="1", VECTRA_PROJECT_DIR=str(ROOT),
                  PIP_DISABLE_PIP_VERSION_CHECK="1", PIP_NO_INPUT="1")
    temporary = ROOT / ".build-temp"
    temporary.mkdir(exist_ok=True)
    values.update(TMP=str(temporary), TEMP=str(temporary), TMPDIR=str(temporary))
    return values


def probe_python(executable):
    code = "import json,sys; print(json.dumps({'prefix':sys.prefix,'version':list(sys.version_info[:2]),'platform':sys.platform}))"
    try:
        result = subprocess.run([str(executable), "-c", code], cwd=ROOT, env=child_environment(),
                                capture_output=True, text=True, encoding="utf-8", timeout=15)
        return json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def environment_problem():
    if not PYTHON.is_file():
        return "Project environment is missing. Run: python run.py setup"
    if STAMP.exists():
        try:
            stamp = json.loads(STAMP.read_text("utf-8"))
            if not isinstance(stamp, dict):
                raise ValueError("invalid metadata")
            if stamp.get("project_dir") != str(ROOT) or stamp.get("platform") != sys.platform:
                return "The virtual environment belongs to another location/computer. Run: python run.py setup --recreate"
        except (ValueError, OSError):
            return "Environment metadata is invalid. Run: python run.py setup --recreate"
    probe = probe_python(PYTHON)
    if not probe or Path(probe["prefix"]).resolve() != ENV_DIR.resolve() or probe["platform"] != sys.platform:
        return "Project Python is unusable. Run: python run.py setup --recreate"
    if not (3, 11) <= tuple(probe["version"]) < (3, 15):
        return "Project Python must be 3.11-3.14. Recreate the environment with a supported Python."
    return None


def require_environment():
    issue = environment_problem()
    if issue:
        raise RuntimeError(issue)


def execute(arguments):
    """Keep Ctrl+C graceful; subprocess.call() would kill the child on interruption."""
    process = subprocess.Popen([str(value) for value in arguments], cwd=ROOT, env=child_environment())
    waiting_for_shutdown = False
    while True:
        try:
            return process.wait()
        except KeyboardInterrupt:
            if not waiting_for_shutdown:
                print("\nCtrl+C received; waiting for the service to finish shutting down.", flush=True)
                waiting_for_shutdown = True


def archive_environment():
    if not ENV_DIR.exists():
        return
    if ENV_DIR.is_symlink() or ENV_DIR.resolve().parent != ROOT:
        raise RuntimeError("Refusing to move an environment outside this project.")
    destination = ROOT / (".venv.backup-" + time.strftime("%Y%m%d-%H%M%S"))
    suffix = 0
    while destination.exists():
        suffix += 1
        destination = ROOT / (".venv.backup-" + time.strftime("%Y%m%d-%H%M%S") + "-" + str(suffix))
    ENV_DIR.rename(destination)
    print("Previous environment preserved at:", destination)


def install_environment(args):
    if args.recreate:
        archive_environment()
    if not PYTHON.is_file():
        print("Creating project environment with:", sys.executable, flush=True)
        result = execute([sys.executable, "-m", "venv", str(ENV_DIR)])
        # Some Windows installations create the interpreter but fail ensurepip.
        if result and not PYTHON.is_file():
            raise RuntimeError("Cannot create .venv. Install Python with the venv/ensurepip components.")
    issue = environment_problem()
    if issue:
        raise RuntimeError(issue)
    pip_probe = subprocess.run([str(PYTHON), "-m", "pip", "--version"], cwd=ROOT,
                               env=child_environment(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if pip_probe.returncode:
        # --python targets only the project environment, never system packages.
        if execute([sys.executable, "-m", "pip", "--python", str(PYTHON), "install", "pip"]):
            raise RuntimeError("Cannot bootstrap project pip. Install Python with pip, then retry setup.")
    target = ".[test]" if args.test else "."
    if execute([PYTHON, "-m", "pip", "install", "-e", target]):
        raise RuntimeError("Dependency installation failed. Check internet access and supported Python version.")
    stamp = {"project_dir": str(ROOT), "platform": sys.platform,
             "version": probe_python(PYTHON)["version"]}
    STAMP.write_text(json.dumps(stamp, indent=2), encoding="utf-8")
    configuration = ROOT / ".env"
    if not configuration.exists() and (ROOT / ".env.example").exists():
        shutil.copyfile(ROOT / ".env.example", configuration)
        print("Created .env from .env.example; existing configuration is always preserved.")


def setup(args):
    # This module has no third-party imports and is usable before installation.
    from vehicular.project_lock import ProjectLease
    with ProjectLease(ROOT):
        # The OS lease proves that no managed service owns this directory.
        # A crash may leave endpoint metadata, but never a live OS lock.
        STATE.unlink(missing_ok=True)
        install_environment(args)
    if not args.no_init and execute([PYTHON, "-m", "vehicular.cli", "init", "--project-dir", ROOT]):
        raise RuntimeError("Initialization failed; existing runtime data was preserved.")
    print("Setup complete. Start: python run.py start | Stop: python run.py stop")
    return 0


def read_state():
    if not STATE.exists():
        return None
    try:
        state = json.loads(STATE.read_text("utf-8"))
        if (not isinstance(state, dict) or state.get("project_dir") != str(ROOT) or not isinstance(state.get("token"), str)
                or not state["token"] or type(state.get("port")) is not int
                or not 1 <= state["port"] <= 65535 or state.get("host") not in {"127.0.0.1", "localhost", "::1"}):
            raise ValueError("invalid metadata")
        return state
    except (ValueError, OSError, KeyError) as exc:
        raise RuntimeError("Local server metadata is invalid or was copied from another computer. Do not migrate .vectra.") from exc


def stop(args):
    state = read_state()
    if state is None:
        print("No managed server is running for this project.")
        return 0
    host = "[::1]" if state["host"] == "::1" else state["host"]
    request = urllib.request.Request(f"http://{host}:{state['port']}/api/control/shutdown", data=b"{}",
                                    headers={"X-Vectra-Control": state["token"], "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5) as response:
            result = json.loads(response.read())
            if result.get("requested") is not True:
                raise RuntimeError("Server did not acknowledge shutdown.")
    except (urllib.error.URLError, ValueError, TimeoutError) as exc:
        raise RuntimeError("Shutdown connection failed. Use Ctrl+C in the server terminal. A crashed server's stale metadata is replaced at the next start.") from exc
    print("Graceful shutdown requested; waiting for active work to finish.", flush=True)
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        current = read_state()
        if current is None or current["token"] != state["token"]:
            print("Server stopped.")
            return 0
        time.sleep(0.1)
    raise RuntimeError("Shutdown was requested, but active work is still finishing. Wait or use the original server terminal.")


def start(args):
    require_environment()
    command = [PYTHON, "-m", "vehicular.cli", "serve", "--project-dir", ROOT]
    if args.port is not None:
        command += ["--port", str(args.port)]
    print("Starting this project's server. Ctrl+C stops it; another terminal can run python run.py stop.", flush=True)
    return execute(command)


def package_source(args):
    import tomllib
    metadata = ROOT / "pyproject.toml"
    version = tomllib.loads(metadata.read_text("utf-8"))["project"]["version"] if metadata.exists() else "0.2.0"
    target = Path(args.output).expanduser().resolve() if args.output else ROOT / "dist" / f"vectra-source-{version}.zip"
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    roots = [ROOT / name for name in ("run.py", "README.md", "pyproject.toml", "requirements.txt", ".env.example", ".gitignore", ".editorconfig",
                                     "vehicular", "scripts", "tests", "docs", ".github")]
    excluded_dirs = {"__pycache__", ".pytest_cache", "runtime", ".venv", ".git", "dist", "artifacts", "node_modules"}
    excluded_suffixes = {".pyc", ".key", ".pem", ".crt", ".enc", ".db", ".sqlite3", ".p12", ".log"}
    entries = []
    for source in roots:
        if source.is_symlink():
            continue
        paths = source.rglob("*") if source.is_dir() else [source]
        for path in paths:
            if not path.is_file() or path.is_symlink():
                continue
            relative = path.relative_to(ROOT)
            if (any(part in excluded_dirs or part.startswith((".venv", ".pytest-", ".test-")) for part in relative.parts)
                    or path.name == ".env" or path.name.endswith(".pid.json") or path.suffix in excluded_suffixes):
                continue
            resolved = path.resolve()
            if not resolved.is_relative_to(ROOT) or resolved in {target, temporary}:
                continue
            entries.append((path, relative.as_posix()))
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path, name in sorted(entries, key=lambda entry: entry[1]):
                archive.write(path, name)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    print("Portable source archive:", target)
    print("Excluded virtual environments, local configuration, runtime data and private credentials.")
    return 0


def main():
    if not (3, 11) <= sys.version_info[:2] < (3, 15):
        print("VECTRA requires Python 3.11-3.14. Use a supported Python to run this launcher.", file=sys.stderr)
        return 1
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="VECTRA portable project launcher (Windows/Linux/macOS)")
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("setup", help="create project .venv, install and initialize")
    install.add_argument("--test", action="store_true", help="also install pytest")
    install.add_argument("--no-init", action="store_true", help="install only")
    install.add_argument("--recreate", action="store_true", help="preserve and replace a moved/old .venv")
    launch = commands.add_parser("start", help="start in the foreground")
    launch.add_argument("--port", type=int)
    shutdown = commands.add_parser("stop", help="request authenticated graceful shutdown")
    shutdown.add_argument("--timeout", type=float, default=60)
    commands.add_parser("check", help="diagnose local runtime and configuration")
    commands.add_parser("migrate-data", help="convert old report encryption before moving runtime")
    test = commands.add_parser("test", help="run tests from the project environment")
    test.add_argument("pytest_args", nargs=argparse.REMAINDER)
    commands.add_parser("demo", help="run CLI demo in its own runtime-demo data directory")
    bundle = commands.add_parser("package", help="export a source-only migration ZIP")
    bundle.add_argument("--output")
    args = parser.parse_args()
    if args.command == "setup":
        return setup(args)
    if args.command == "package":
        return package_source(args)
    if args.command == "stop":
        if not 0 < args.timeout <= 600:
            raise RuntimeError("--timeout must be between 0 and 600 seconds")
        return stop(args)
    if args.command == "start":
        if args.port is not None and not 1 <= args.port <= 65535:
            raise RuntimeError("--port must be between 1 and 65535")
        return start(args)
    if args.command == "check":
        print(json.dumps({"project_dir": str(ROOT), "platform": platform.platform(),
                          "launcher_python": sys.executable, "environment_problem": environment_problem()}, indent=2, ensure_ascii=False))
        require_environment()
        return execute([PYTHON, "-m", "vehicular.cli", "check", "--project-dir", ROOT])
    require_environment()
    if args.command == "test":
        forwarded = args.pytest_args[1:] if args.pytest_args[:1] == ["--"] else args.pytest_args
        command = [PYTHON, "-m", "pytest", "-q"]
        if not any(value == "--basetemp" or value.startswith("--basetemp=") for value in forwarded):
            command += ["--basetemp", str(ROOT / ".pytest-run")]
        return execute(command + forwarded)
    if args.command == "demo":
        # CLI demos should not touch the live dashboard's recovery/query state.
        values = child_environment()
        values["VECTRA_DATA_DIR"] = str(ROOT / "runtime-demo")
        process = subprocess.Popen([str(PYTHON), "-m", "vehicular.cli", "demo", "--project-dir", str(ROOT)], cwd=ROOT, env=values)
        return process.wait()
    return execute([PYTHON, "-m", "vehicular.cli", "migrate-data", "--project-dir", ROOT])


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError) as failure:
        print("ERROR:", failure, file=sys.stderr)
        sys.exit(1)
