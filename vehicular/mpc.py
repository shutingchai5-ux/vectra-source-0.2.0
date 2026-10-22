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
import queue
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
TRACE_MARKER = "VEHICULAR_MPC_TRACE:"
PROTOCOL = "MPyC 0.11 / Shamir m=3 t=1 / mutually authenticated TLS 1.3"

# Worker output is an allowlisted control channel, never a source of display text.
_TRACE_STAGES = {
    "task_verified": ("security", "独立任务认证", "已独立验证协调器签名、三方参与者身份、任务授权与有效期。", "completed"),
    "input_verified": ("security", "本地输入认证", "本车 AES-GCM 输入认证、范围和新鲜性检查已通过；输入留在车辆进程。", "completed"),
    "tls_peer_verified": ("security", "车辆对端身份认证", "实际 TLS 1.3 连接的证书指纹与登记的参与者身份一致。", "completed"),
    "network_ready": ("mpc", "三方网络就绪", "MPyC 已完成三方双向 TLS 1.3 网络启动。", "completed"),
    "shares_started": ("exchange", "开始秘密份额交换", "开始通过车辆间 TLS 连接分发 Shamir 份额；不向协调器传送单车输入。", "running"),
    "shares_ready": ("exchange", "秘密份额交换完成", "本车已完成份额分发并收齐三方份额；份额内容不进入过程记录。", "completed"),
    "output_started": ("mpc", "开始授权输出协议", "对秘密份额求和，并将批准的聚合输出限定给 vehicle-a。", "running"),
    "output_ready": ("mpc", "授权聚合输出已重构", "vehicle-a 已完成批准聚合值的重构，等待协调端完整协议与结果绑定校验。", "completed"),
    "output_sent": ("exchange", "授权输出份额已发送", "本车已完成面向 vehicle-a 的聚合输出份额协议。", "completed"),
    "protocol_closed": ("mpc", "车辆协议已关闭", "本车已完成 MPyC 关闭与连接同步。", "completed"),
}


def _trace_event(vehicle_id: str, line: str) -> dict | None:
    """Decode fixed public stage codes; ignore arbitrary worker text and fields."""
    if vehicle_id not in PARTICIPANTS or len(line) > 256 or not line.startswith(TRACE_MARKER):
        return None
    try:
        data = json.loads(line[len(TRACE_MARKER):])
        if not isinstance(data, dict) or set(data) not in ({"stage"}, {"stage", "peer"}):
            return None
        stage = data.get("stage")
        if not isinstance(stage, str) or stage not in _TRACE_STAGES:
            return None
        peer = data.get("peer")
        if (stage == "tls_peer_verified") != (peer is not None):
            return None
        if peer is not None and (peer not in PARTICIPANTS or peer == vehicle_id):
            return None
        if stage == "output_ready" and vehicle_id != PARTICIPANTS[0]:
            return None
        kind, action, detail, status = _TRACE_STAGES[stage]
        metadata = {"stage": stage, "source": "worker"}
        if peer is not None:
            metadata.update(peer=peer, tls_version="TLSv1.3")
        if stage in {"shares_started", "shares_ready", "network_ready"}:
            metadata.update(participant_count=3, threshold=1)
        phase = "shares" if stage in {"shares_started", "shares_ready"} else "output" if stage in {"output_started", "output_ready", "output_sent"} else stage
        if peer is not None:
            phase += "-" + peer
        return {"id": f"mpc-{vehicle_id}-{phase}", "agent": vehicle_id, "action": action, "detail": detail, "status": status,
                "kind": kind, "sender": vehicle_id, "recipient": peer or ("vehicle-a" if stage in {"output_started", "output_sent"} else "mpc"),
                "protocol": "TLS 1.3 / Shamir m=3 t=1", "metadata": metadata}
    except (ValueError, TypeError):
        return None


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

    def run(self, task: dict, timeout: float = 20, offline_party: str | int | None = None, on_progress=None) -> dict:
        if not isinstance(task, dict):
            raise MpcError("task_unauthorized", "协作任务必须为已签名对象。")
        if timeout <= 0 or not math.isfinite(timeout):
            raise MpcError("configuration", "计算超时配置无效。")
        if isinstance(offline_party, int) and 0 <= offline_party < len(PARTICIPANTS):
            offline_party = PARTICIPANTS[offline_party]
        if offline_party is not None and offline_party not in PARTICIPANTS:
            raise MpcError("configuration", "模拟离线车辆无效。")
        with self._lock:
            return self._run(task, float(timeout), offline_party, on_progress)

    def _run(self, task: dict, timeout: float, offline_party: str | None, on_progress=None) -> dict:
        started = time.monotonic()
        deadline = started + timeout
        processes: list[tuple[str, subprocess.Popen]] = []
        readers = []
        incoming = queue.Queue()
        outputs = {}
        stdout_closed = set()

        def read_stdout(vehicle_id, stream):
            try:
                while True:
                    line = stream.readline(8193)
                    if not line:
                        break
                    if len(line) >= 8193 and not line.endswith("\n"):
                        # Discard oversized lines without retaining worker data.
                        while line and not line.endswith("\n"):
                            line = stream.readline(8193)
                        continue
                    line = line.rstrip("\r\n")
                    if line.startswith((TRACE_MARKER, RESULT_MARKER, ERROR_MARKER)) or line == DONE_MARKER:
                        incoming.put((vehicle_id, line))
            finally:
                incoming.put((vehicle_id, None))

        def drain_stderr(stream):
            # Drain concurrently so diagnostics can never fill a subprocess pipe.
            # Never retain or publish arbitrary stderr content.
            while stream.read(4096):
                pass

        def consume(item):
            vehicle_id, line = item
            if line is None:
                stdout_closed.add(vehicle_id)
            elif line.startswith(TRACE_MARKER):
                event = _trace_event(vehicle_id, line)
                if event is not None and on_progress is not None:
                    on_progress(event)
            else:
                outputs[vehicle_id].append(line)

        def drain_pending():
            while True:
                try:
                    consume(incoming.get_nowait())
                except queue.Empty:
                    return
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
                outputs[vehicle_id] = []
                for target, stream in ((read_stdout, process.stdout), (drain_stderr, process.stderr)):
                    args = (vehicle_id, stream) if target is read_stdout else (stream,)
                    reader = threading.Thread(target=target, args=args, daemon=True)
                    reader.start()
                    readers.append(reader)
            while True:
                drain_pending()
                failed = [vehicle for vehicle, process in processes if process.poll() not in (None, 0)]
                if any(vehicle in stdout_closed for vehicle in failed):
                    self._raise_worker_failure([(vehicle, process) for vehicle, process in processes if vehicle in stdout_closed], outputs)
                if all(process.poll() == 0 for _, process in processes) and len(stdout_closed) == len(processes):
                    break
                if time.monotonic() >= deadline:
                    raise MpcError("mpc_timeout", "隐私计算超时：全部三辆车辆必须在线且通过身份验证。")
                try:
                    consume(incoming.get(timeout=min(0.03, max(0.001, deadline - time.monotonic()))))
                except queue.Empty:
                    pass
            for vehicle_id, _ in processes:
                if DONE_MARKER not in outputs[vehicle_id]:
                    raise MpcError("mpc_failed", "车辆未完成隐私计算。")
            lines = [line[len(RESULT_MARKER):] for line in
                     outputs.get(PARTICIPANTS[0], []) if line.startswith(RESULT_MARKER)]
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
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
            for reader in readers:
                reader.join(timeout=3)
            for _, process in processes:
                for stream in (process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()
            if workspace is not None and workspace.resolve().parent == run_root.resolve():
                shutil.rmtree(workspace)

    @staticmethod
    def _raise_worker_failure(processes: list[tuple[str, subprocess.Popen]], outputs) -> None:
        for vehicle_id, process in processes:
            if process.poll() not in (None, 0):
                codes = [line[len(ERROR_MARKER):] for line in outputs.get(vehicle_id, [])
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
