"""Launch three private vehicle processes and collect only their approved aggregate.

The coordinator never opens a vehicle's sample or storage key. MPyC provides
Shamir secret sharing with m=3, t=1 (passive, honest-majority security). Local
process isolation is a teaching deployment, not protection from the host owner.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from vehicular.security import canonical_bytes

PARTICIPANTS = ("vehicle-a", "vehicle-b", "vehicle-c")
RESULT_MARKER = "VEHICULAR_MPC_RESULT:"
ERROR_MARKER = "VEHICULAR_MPC_ERROR:"
DONE_MARKER = "VEHICULAR_MPC_DONE"
PROTOCOL = "MPyC 0.11 / Shamir m=3 t=1 / mutually authenticated TLS 1.3"


class MpcError(RuntimeError):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def task_digest(task: dict) -> str:
    return hashlib.sha256(canonical_bytes(task)).hexdigest()


def initialize_samples(root: Path | str) -> None:
    """Provision demo sensor fixtures once; never replace existing private data.

    Each worker samples its own local simulator when a task is authorized. These
    deterministic teaching fixtures are not claimed to be real vehicle readings.
    """
    root = Path(root)
    for vehicle_id, speed in zip(PARTICIPANTS, (60, 40, 20)):
        node = root / "vehicles" / vehicle_id
        node.mkdir(parents=True, exist_ok=True)
        sample_path = node / "sample.enc"
        if sample_path.exists():
            continue
        key_path = node / "storage.key"
        if not key_path.exists():
            try:
                with key_path.open("xb") as handle:
                    handle.write(AESGCM.generate_key(bit_length=256))
                key_path.chmod(0o600)
            except FileExistsError:
                pass
        key = key_path.read_bytes()
        if len(key) != 32:
            raise MpcError("sample_configuration", "车辆本地加密密钥配置无效。")
        plaintext = json.dumps({"vehicle_id": vehicle_id, "road": "S101",
                                "speed_kmh": speed, "source": "simulation"},
                               sort_keys=True, separators=(",", ":")).encode()
        nonce = os.urandom(12)
        ciphertext = nonce + AESGCM(key).encrypt(nonce, plaintext, vehicle_id.encode())
        try:
            with sample_path.open("xb") as handle:
                handle.write(ciphertext)
            sample_path.chmod(0o600)
        except FileExistsError:
            pass


def _ports() -> list[int]:
    """Allocate independent available loopback ports instead of a fixed range."""
    reservations: list[socket.socket] = []
    try:
        for _ in PARTICIPANTS:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            listener.bind(("127.0.0.1", 0))
            reservations.append(listener)
        return [listener.getsockname()[1] for listener in reservations]
    finally:
        for listener in reservations:
            listener.close()


class MpcRunner:
    """Bounded, synchronous subprocess orchestration suitable for a worker thread."""
    def __init__(self, root: Path | str):
        self.root = Path(root).resolve()
        self._lock = threading.Lock()

    def run(self, task: dict, timeout: float = 20, offline_party: str | int | None = None) -> dict:
        if not isinstance(task, dict):
            raise MpcError("task_unauthorized", "协作任务必须为已签名对象。")
        if timeout <= 0 or not math.isfinite(timeout):
            raise MpcError("configuration", "计算超时配置无效。")
        if isinstance(offline_party, int) and 0 <= offline_party < len(PARTICIPANTS):
            offline_party = PARTICIPANTS[offline_party]
        if offline_party is not None and offline_party not in PARTICIPANTS:
            raise MpcError("configuration", "模拟离线车辆无效。")
        with self._lock:
            return self._run(task, float(timeout), offline_party)

    def _run(self, task: dict, timeout: float, offline_party: str | None) -> dict:
        started = time.monotonic()
        deadline = started + timeout
        processes: list[tuple[str, subprocess.Popen]] = []
        run_root = self.root / "mpc-runs"
        run_root.mkdir(parents=True, exist_ok=True)
        workspace = None
        try:
            workspace = Path(tempfile.mkdtemp(prefix="task-", dir=run_root))
            task_file = workspace / "task.json"
            task_file.write_text(json.dumps(task, ensure_ascii=False), encoding="utf-8")
            ports = _ports()
            peers = {}
            for pid, vehicle_id in enumerate(PARTICIPANTS):
                cert_path = self.root / "identities" / vehicle_id / "tls.crt"
                certificate = x509.load_pem_x509_certificate(cert_path.read_bytes())
                peers[str(pid)] = hashlib.sha256(
                    certificate.public_bytes(serialization.Encoding.DER)).hexdigest()
            project_root = str(Path(__file__).resolve().parent.parent)
            env = os.environ.copy()
            env["PYTHONPATH"] = project_root + os.pathsep + env.get("PYTHONPATH", "")
            env["PYTHONUNBUFFERED"] = "1"
            for pid, vehicle_id in enumerate(PARTICIPANTS):
                if vehicle_id == offline_party:
                    continue
                node_work = workspace / vehicle_id
                config = node_work / ".config"
                config.mkdir(parents=True)
                identity = self.root / "identities" / vehicle_id
                shutil.copyfile(identity / "tls.crt", config / f"party_{pid}.crt")
                shutil.copyfile(identity / "tls.key", config / f"party_{pid}.key")
                shutil.copyfile(self.root / "ca" / "ca.crt", config / "mpyc_ca.crt")
                (config / "peers.json").write_text(json.dumps(peers), encoding="utf-8")
                command = [sys.executable, "-m", "vehicular.mpc_party",
                           "--root", str(self.root), "--task-file", str(task_file),
                           "--vehicle", vehicle_id, "-I", str(pid), "-T", "1",
                           "--ssl", "--no-log", "--no-numpy"]
                for port in ports:
                    command += ["-P", f"127.0.0.1:{port}"]
                creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                process = subprocess.Popen(command, cwd=node_work, env=env,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           text=True, encoding="utf-8", errors="replace",
                                           creationflags=creationflags)
                processes.append((vehicle_id, process))
            while True:
                if any(process.poll() not in (None, 0) for _, process in processes):
                    self._raise_worker_failure(processes)
                if all(process.poll() == 0 for _, process in processes):
                    break
                if time.monotonic() >= deadline:
                    raise MpcError("mpc_timeout", "隐私计算超时：全部三辆车辆必须在线且通过身份验证。")
                time.sleep(0.03)
            outputs = {}
            for vehicle_id, process in processes:
                stdout, _ = process.communicate(timeout=max(0.1, deadline - time.monotonic()))
                outputs[vehicle_id] = stdout
                if DONE_MARKER not in stdout.splitlines():
                    raise MpcError("mpc_failed", "车辆未完成隐私计算。")
            lines = [line[len(RESULT_MARKER):] for line in
                     outputs.get(PARTICIPANTS[0], "").splitlines() if line.startswith(RESULT_MARKER)]
            if len(lines) != 1 or len(outputs) != len(PARTICIPANTS):
                raise MpcError("mpc_failed", "未收到完整的授权聚合结果。")
            result = json.loads(lines[0])
            self._validate_result(result, task)
            result.update(protocol=PROTOCOL, threshold=1, transport="mTLS",
                          elapsed_ms=round((time.monotonic() - started) * 1000),
                          sample_source="local_simulated_vehicles")
            return result
        except MpcError:
            raise
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
            raise MpcError("mpc_failed", "隐私计算进程或凭据配置失败；未发布部分结果。") from exc
        finally:
            for _, process in processes:
                if process.poll() is None:
                    process.terminate()
            for _, process in processes:
                try:
                    process.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=3)
            if workspace is not None and workspace.resolve().parent == run_root.resolve():
                shutil.rmtree(workspace)

    @staticmethod
    def _raise_worker_failure(processes: list[tuple[str, subprocess.Popen]]) -> None:
        for _, process in processes:
            if process.poll() not in (None, 0):
                stdout, _ = process.communicate(timeout=1)
                codes = [line[len(ERROR_MARKER):] for line in stdout.splitlines()
                         if line.startswith(ERROR_MARKER)]
                code = codes[0] if codes else "mpc_failed"
                messages = {
                    "task_unauthorized": "车辆独立校验拒绝了未授权或无效签名的任务。",
                    "sample_invalid": "车辆本地输入认证、范围或新鲜性检查失败。",
                    "identity_invalid": "车辆身份或通信证书校验失败。",
                    "mpc_failed": "车辆隐私计算失败；未发布部分结果。",
                }
                if code not in messages:
                    code = "mpc_failed"
                raise MpcError(code, messages[code])
        raise MpcError("mpc_failed", "车辆隐私计算失败。")

    @staticmethod
    def _validate_result(result: dict, task: dict) -> None:
        if not isinstance(result, dict):
            raise MpcError("mpc_failed", "聚合结果格式无效。")
        value = result.get("average_speed")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise MpcError("mpc_failed", "聚合结果数值无效。")
        expected = {"average_speed", "participant_count", "participants", "road",
                    "window_seconds", "task_id", "task_digest"}
        if (set(result) != expected or not 0 <= value <= 300 or
                result["participant_count"] != 3 or result["participants"] != list(PARTICIPANTS) or
                result["road"] != "S101" or result["window_seconds"] != 60 or
                result["task_id"] != task.get("payload", {}).get("task_id") or
                result["task_digest"] != task_digest(task)):
            raise MpcError("mpc_failed", "聚合结果与批准任务不匹配。")
