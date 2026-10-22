"""Service ownership is live OS state; metadata never authorizes a PID kill."""
import json
import asyncio
import os
from pathlib import Path
import secrets
import stat
from types import SimpleNamespace

import pytest

from vehicular.config import Settings
from vehicular.lifecycle import (
    AlreadyRunningError, ProjectLease, ensure_stopped, read_server_state, serve,
)


def test_os_lease_blocks_duplicate_service_and_releases_on_context_exit(tmp_path):
    with ProjectLease(tmp_path):
        with pytest.raises(AlreadyRunningError):
            ProjectLease(tmp_path).acquire()
        with pytest.raises(AlreadyRunningError):
            ensure_stopped(tmp_path)
    ensure_stopped(tmp_path)
    with ProjectLease(tmp_path):
        pass


def test_lease_release_is_idempotent_and_exception_safe(tmp_path):
    lease = ProjectLease(tmp_path)
    with pytest.raises(ValueError):
        with lease:
            raise ValueError("operation failed")
    lease.release()
    ensure_stopped(tmp_path)


@pytest.fixture
def mock_server(monkeypatch):
    import uvicorn
    from vehicular import api

    app = SimpleNamespace(state=SimpleNamespace())
    monkeypatch.setattr(api, "create_app", lambda settings: app)
    observed = {}

    class Server:
        def __init__(self, config):
            self.config = config
            self.should_exit = False
            observed["server"] = self

        def run(self):
            observed["callback"](self)

    monkeypatch.setattr(uvicorn, "Server", Server)
    observed["app"] = app
    return observed


def test_serve_private_metadata_and_shutdown_callback_are_owned(tmp_path, mock_server):
    settings = Settings(data_dir=tmp_path / "runtime", port=8001)

    def running(server):
        state = read_server_state(tmp_path)
        assert state["pid"] == os.getpid()
        assert state["host"] == "127.0.0.1" and state["port"] == 8001
        assert state["token"] == mock_server["app"].state.control_token
        assert state["project_dir"] == str(tmp_path.resolve())
        if os.name != "nt":
            assert stat.S_IMODE((tmp_path / ".vectra" / "server.json").stat().st_mode) == 0o600
        with pytest.raises(AlreadyRunningError):
            ensure_stopped(tmp_path)
        mock_server["app"].state.shutdown_callback()
        assert server.should_exit

    mock_server["callback"] = running
    serve(settings, tmp_path)
    assert read_server_state(tmp_path) is None
    ensure_stopped(tmp_path)


def test_server_exception_releases_lease_and_removes_owned_metadata(tmp_path, mock_server):
    def running(server):
        raise RuntimeError("simulated Uvicorn error")

    mock_server["callback"] = running
    with pytest.raises(RuntimeError, match="simulated Uvicorn error"):
        serve(Settings(data_dir=tmp_path / "runtime"), tmp_path)
    assert read_server_state(tmp_path) is None
    ensure_stopped(tmp_path)


def test_ctrl_c_returns_normally_cleans_state_and_allows_restart(tmp_path, mock_server):
    def interrupted(server):
        assert read_server_state(tmp_path) is not None
        # Match asyncio.Runner's chained exception from the user's traceback.
        try:
            raise asyncio.CancelledError()
        except asyncio.CancelledError:
            raise KeyboardInterrupt()

    mock_server["callback"] = interrupted
    settings = Settings(data_dir=tmp_path / "runtime")
    serve(settings, tmp_path)
    assert read_server_state(tmp_path) is None
    ensure_stopped(tmp_path)
    mock_server["callback"] = lambda server: None
    serve(settings, tmp_path)
    assert read_server_state(tmp_path) is None


def test_unexpected_async_cancellation_is_not_hidden(tmp_path, mock_server):
    def cancelled(server):
        raise asyncio.CancelledError("unexpected cancellation")

    mock_server["callback"] = cancelled
    with pytest.raises(asyncio.CancelledError, match="unexpected cancellation"):
        serve(Settings(data_dir=tmp_path / "runtime"), tmp_path)
    assert read_server_state(tmp_path) is None
    ensure_stopped(tmp_path)


def test_server_cleanup_does_not_remove_replaced_ownership_metadata(tmp_path, mock_server):
    replacement = secrets.token_urlsafe(32)

    def running(server):
        state = read_server_state(tmp_path)
        state["token"] = replacement
        (tmp_path / ".vectra" / "server.json").write_text(json.dumps(state), "utf-8")

    mock_server["callback"] = running
    serve(Settings(data_dir=tmp_path / "runtime"), tmp_path)
    assert read_server_state(tmp_path)["token"] == replacement
    # A copied/stale PID file cannot retain a live lease after service exit.
    ensure_stopped(tmp_path)


@pytest.mark.parametrize("state", [[], {}, {"token": "attacker"}, "malformed"])
def test_malformed_metadata_is_rejected(tmp_path, state):
    state_dir = tmp_path / ".vectra"
    state_dir.mkdir()
    (state_dir / "server.json").write_text(json.dumps(state), "utf-8")
    with pytest.raises(RuntimeError, match="metadata"):
        read_server_state(tmp_path)


def test_service_metadata_cannot_be_reused_after_copying_a_project(tmp_path, mock_server):
    source = tmp_path / "source project"
    destination = tmp_path / "copied project"

    def running(server):
        copied = destination / ".vectra"
        copied.mkdir(parents=True)
        (copied / "server.json").write_bytes((source / ".vectra" / "server.json").read_bytes())
        with pytest.raises(RuntimeError, match="another project"):
            read_server_state(destination)

    mock_server["callback"] = running
    serve(Settings(data_dir=source / "runtime"), source)
