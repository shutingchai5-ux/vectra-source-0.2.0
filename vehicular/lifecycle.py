"""Local foreground service ownership and authenticated shutdown metadata.

An OS file lock owns a project while its service is running. The lock file may
remain after exit; only the live lock matters. Metadata contains a private
control token, never an instruction to terminate a PID or another application.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import secrets
import time

from .config import resolve_project_dir
from .project_lock import AlreadyRunningError, ProjectLease


def ensure_stopped(project_dir) -> None:
    """Check live ownership without trusting stale PID metadata.

    Maintenance callers should instead retain a ProjectLease context throughout
    their operation, so another serve command cannot start during the mutation.
    """
    with ProjectLease(project_dir):
        pass


def _state_path(project_dir) -> Path:
    return resolve_project_dir(project_dir) / ".vectra" / "server.json"


def read_server_state(project_dir) -> dict | None:
    """Read validated endpoint metadata without exposing its control token."""
    root = resolve_project_dir(project_dir)
    try:
        state = json.loads(_state_path(root).read_text("utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, UnicodeError) as exc:
        raise RuntimeError("Service control metadata cannot be read") from exc
    if (not isinstance(state, dict) or
            set(state) != {"pid", "host", "port", "token", "project_dir", "started_at"} or
            type(state["pid"]) is not int or state["pid"] <= 0 or
            not isinstance(state["host"], str) or state["host"] not in {"127.0.0.1", "localhost", "::1"} or
            type(state["port"]) is not int or not 1 <= state["port"] <= 65535 or
            not isinstance(state["token"], str) or len(state["token"]) < 32 or
            state["project_dir"] != str(root) or
            isinstance(state["started_at"], bool) or
            not isinstance(state["started_at"], (int, float)) or
            not math.isfinite(state["started_at"]) or state["started_at"] <= 0):
        raise RuntimeError("Service control metadata is malformed or belongs to another project")
    return state


def _write_server_state(project_dir, state: dict) -> None:
    path = _state_path(project_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(state, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        temporary.unlink(missing_ok=True)


def _remove_owned_state(project_dir, token: str) -> None:
    path = _state_path(project_dir)
    try:
        state = json.loads(path.read_text("utf-8"))
        if isinstance(state, dict) and state.get("token") == token:
            path.unlink(missing_ok=True)
    except (OSError, ValueError, UnicodeError):
        # Do not delete metadata we cannot prove belongs to this invocation.
        pass


def serve(settings, project_dir=None) -> None:
    """Run Uvicorn in the foreground while retaining project ownership."""
    import uvicorn
    from .api import create_app

    settings.validate()
    root = resolve_project_dir(project_dir)
    with ProjectLease(root):
        token = secrets.token_urlsafe(32)
        app = create_app(settings)
        server = uvicorn.Server(uvicorn.Config(app, host=settings.host, port=settings.port,
                                             log_level="info"))
        app.state.control_token = token
        app.state.shutdown_callback = lambda: setattr(server, "should_exit", True)
        state = {"pid": os.getpid(), "host": settings.host, "port": settings.port,
                 "token": token, "project_dir": str(root), "started_at": time.time()}
        try:
            _write_server_state(root, state)
            try:
                server.run()
            except KeyboardInterrupt:
                # Uvicorn replays SIGINT after graceful shutdown. asyncio.Runner
                # turns that into KeyboardInterrupt (with CancelledError as its
                # context). Treat this requested stop as a normal CLI exit;
                # all other server errors still propagate to the caller.
                pass
        finally:
            _remove_owned_state(root, token)
