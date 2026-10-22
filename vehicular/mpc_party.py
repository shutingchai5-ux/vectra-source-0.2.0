"""One private vehicle worker. No individual sample is written to stdout or sent to the coordinator."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import ssl
import sys
import time
from decimal import Decimal, ROUND_HALF_UP

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from vehicular.mpc import (DONE_MARKER, ERROR_MARKER, PARTICIPANTS,
                           RESULT_MARKER, MpcError, task_digest)
from vehicular.security import SecurityError, SecurityStore

TASK_FIELDS = {"task_id", "request_id", "sender", "recipient", "purpose", "metric",
               "road", "window_seconds", "participants", "issued_at", "expires_at"}


def verify_task(root: Path | str, envelope: dict, vehicle_id: str, now: float | None = None) -> dict:
    """Every vehicle verifies the pinned coordinator and the complete disclosure policy."""
    try:
        if vehicle_id not in PARTICIPANTS or set(envelope) != {"payload", "signature", "signer"}:
            raise ValueError("Invalid participant or envelope")
        store = SecurityStore(Path(root))
        payload = store.verify(envelope, expected_signer="coordinator")
        # Verify every fixed party's certificate and enabled registry state before input use.
        for participant in PARTICIPANTS:
            cert = store.identity_path(participant) / "tls.crt"
            from cryptography import x509
            from cryptography.hazmat.primitives import serialization
            certificate = x509.load_pem_x509_certificate(cert.read_bytes())
            store.authenticated_identity(certificate.public_bytes(serialization.Encoding.DER),
                                         expected=participant)
        clock = time.time() if now is None else now
        if (set(payload) != TASK_FIELDS or payload["sender"] != "coordinator" or
                payload["recipient"] != "coordinator" or payload["purpose"] != "traffic_statistics" or
                payload["metric"] != "mean_speed" or payload["road"] != "S101" or
                type(payload["window_seconds"]) is not int or payload["window_seconds"] != 60 or
                payload["participants"] != list(PARTICIPANTS)):
            raise ValueError("Policy does not approve this task")
        for field in ("task_id", "request_id"):
            if not isinstance(payload[field], str) or not 1 <= len(payload[field]) <= 128:
                raise ValueError("Missing task binding")
        issued, expires = payload["issued_at"], payload["expires_at"]
        if (isinstance(issued, bool) or isinstance(expires, bool) or
                not isinstance(issued, (int, float)) or not isinstance(expires, (int, float)) or
                not math.isfinite(issued) or not math.isfinite(expires) or
                not clock - 60 <= issued <= clock + 5 or not issued < expires or
                not clock < expires <= issued + 120):
            raise ValueError("Task freshness check failed")
        return payload
    except (SecurityError, OSError, ValueError, TypeError, KeyError) as exc:
        raise MpcError("task_unauthorized", "车辆独立校验拒绝未授权任务。") from exc


def read_local_sample(root: Path, vehicle_id: str, task: dict) -> int:
    """Decrypt only this node's sample and convert km/h to integer hundredths.

    A local simulator produces its configured speed at task time. For a real
    recorded source, observed_at must fall inside the approved 60-second window.
    """
    try:
        node = root / "vehicles" / vehicle_id
        key = (node / "storage.key").read_bytes()
        blob = (node / "sample.enc").read_bytes()
        if len(key) != 32 or len(blob) < 28 or len(blob) > 65536:
            raise ValueError("Invalid local sample format")
        data = json.loads(AESGCM(key).decrypt(blob[:12], blob[12:], vehicle_id.encode()))
        if data.get("vehicle_id") != vehicle_id or data.get("road") != task["road"]:
            raise ValueError("Sample context mismatch")
        speed = data.get("speed_kmh")
        if (isinstance(speed, bool) or not isinstance(speed, (float, int)) or
                not math.isfinite(speed) or not 0 <= speed <= 300):
            raise ValueError("Input out of range")
        observed = time.time() if data.get("source") == "simulation" else data.get("observed_at")
        if (isinstance(observed, bool) or not isinstance(observed, (int, float)) or
                not math.isfinite(observed) or not time.time() - task["window_seconds"] <= observed <= time.time() + 5):
            raise ValueError("Sample is stale")
        return int((Decimal(str(speed)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (OSError, InvalidTag, ValueError, TypeError, KeyError, AttributeError) as exc:
        raise MpcError("sample_invalid", "车辆本地输入认证或范围检查失败。") from exc


def install_peer_pinning(mpc) -> None:
    """Bind TLS client certificates to MPyC pids before accepting protocol bytes.

    Stock MPyC 0.11 validates the CA and server hostname. This additional check
    verifies both directions against the enrolled certificate fingerprints.
    """
    from mpyc import asyncoro
    expected = json.loads(Path(".config/peers.json").read_text("utf-8"))
    original = asyncoro.MessageExchanger

    class PinnedMessageExchanger(original):
        def connection_made(self, transport):
            certificate = transport.get_extra_info("peercert", default=None)
            ssl_object = transport.get_extra_info("ssl_object", default=None)
            if not certificate or ssl_object is None or ssl_object.version() != "TLSv1.3":
                transport.abort()
                return
            self.peer_fingerprint = hashlib.sha256(ssl_object.getpeercert(binary_form=True)).hexdigest()
            if self.peer_pid is not None and expected.get(str(self.peer_pid)) != self.peer_fingerprint:
                transport.abort()
                return
            super().connection_made(transport)

        def data_received(self, data):
            if self.transport is None:
                return
            if self.peer_pid is None:
                # MPyC announces a two-byte pid before sending PRSS keys/shares.
                pid_bytes = bytes(self.bytes) + data
                if len(pid_bytes) >= 2:
                    peer_pid = int.from_bytes(pid_bytes[:2], "little")
                    if (not 0 <= peer_pid < self.runtime.pid or
                            expected.get(str(peer_pid)) != self.peer_fingerprint):
                        self.transport.abort()
                        return
            super().data_received(data)

        def connection_lost(self, exc):
            if self.transport is None:
                return
            # A rejected peer never had a registered pid; avoid deregistering it.
            if self.peer_pid is None:
                return
            super().connection_lost(exc)

    asyncoro.MessageExchanger = PinnedMessageExchanger
    original_create_server = mpc._loop.create_server
    original_create_connection = mpc._loop.create_connection

    def require_tls13(kwargs):
        context = kwargs.get("ssl")
        if not isinstance(context, ssl.SSLContext):
            raise MpcError("identity_invalid", "车辆协议必须使用双向 TLS 1.3。")
        context.minimum_version = ssl.TLSVersion.TLSv1_3

    async def loopback_server(factory, host=None, *args, **kwargs):
        require_tls13(kwargs)
        return await original_create_server(factory, "127.0.0.1", *args, **kwargs)

    async def tls13_connection(factory, *args, **kwargs):
        require_tls13(kwargs)
        return await original_create_connection(factory, *args, **kwargs)

    mpc._loop.create_server = loopback_server
    mpc._loop.create_connection = tls13_connection


async def collaborate(mpc, private_speed: int, envelope: dict, task: dict) -> dict | None:
    await mpc.start()
    secure_integer = mpc.SecInt(32)
    secret_inputs = mpc.input(secure_integer(private_speed), senders=range(3))
    # Reconstruction is restricted to party 0; only the approved mean is emitted.
    total = await mpc.output(mpc.sum(secret_inputs), receivers=0)
    await mpc.shutdown()
    if mpc.pid != 0:
        return None
    return {"average_speed": round(total / 300, 2), "participant_count": 3,
            "participants": list(PARTICIPANTS), "road": task["road"],
            "window_seconds": task["window_seconds"], "task_id": task["task_id"],
            "task_digest": task_digest(envelope)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--task-file", type=Path, required=True)
    parser.add_argument("--vehicle", choices=PARTICIPANTS, required=True)
    args, mpyc_args = parser.parse_known_args()
    try:
        if args.task_file.stat().st_size > 65536:
            raise MpcError("task_unauthorized", "任务对象过大。")
        envelope = json.loads(args.task_file.read_text("utf-8"))
        task = verify_task(args.root, envelope, args.vehicle)
        private_speed = read_local_sample(args.root, args.vehicle, task)
        # Import MPyC after independent authorization; MPyC consumes only its args.
        sys.argv = [sys.argv[0]] + mpyc_args
        from mpyc.runtime import mpc
        if (mpc.pid != PARTICIPANTS.index(args.vehicle) or len(mpc.parties) != 3 or
                mpc.threshold != 1 or not mpc.options.ssl):
            raise MpcError("identity_invalid", "车辆协议配置无效。")
        install_peer_pinning(mpc)
        result = mpc.run(collaborate(mpc, private_speed, envelope, task))
        if result is not None:
            print(RESULT_MARKER + json.dumps(result, sort_keys=True, ensure_ascii=False), flush=True)
        print(DONE_MARKER, flush=True)
        return 0
    except MpcError as exc:
        print(ERROR_MARKER + exc.code, flush=True)
        return 2
    except (OSError, ValueError, KeyError, TypeError, SecurityError):
        print(ERROR_MARKER + "task_unauthorized", flush=True)
        return 2
    except Exception:
        print(ERROR_MARKER + "mpc_failed", flush=True)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
