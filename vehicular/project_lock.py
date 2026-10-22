"""Dependency-free OS ownership lock for setup, maintenance and service runs."""
from __future__ import annotations

import os
from pathlib import Path


class AlreadyRunningError(RuntimeError):
    """A service or maintenance operation already owns this project."""


class ProjectLease:
    """Nonblocking OS lease, automatically released if its process exits.

    This module intentionally imports only Python's standard library so the
    portable launcher can retain ownership before installing dependencies.
    """

    def __init__(self, project_dir):
        self.project_dir = Path(project_dir).expanduser().resolve()
        self.directory = self.project_dir / ".vectra"
        self.path = self.directory / "server.lock"
        self._handle = None

    def acquire(self):
        if self._handle is not None:
            raise RuntimeError("This project lease is already acquired")
        self.directory.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        try:
            self.path.chmod(0o600)
            # Windows byte-range locking requires a real byte and seek(0).
            if handle.seek(0, os.SEEK_END) == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            handle.close()
            raise AlreadyRunningError(
                "This project is already running or performing maintenance; stop it first.") from exc
        self._handle = handle
        return self

    def release(self):
        handle, self._handle = self._handle, None
        if handle is None:
            return
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

    def __enter__(self):
        return self.acquire()

    def __exit__(self, exc_type, exc, traceback):
        self.release()
