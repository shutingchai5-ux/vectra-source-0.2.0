"""Loopback mTLS RSU gateway and persistent, authenticated replay window."""
import hashlib
import json
import math
import sqlite3
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
from cryptography import x509
from cryptography.x509.oid import NameOID

from .security import SecurityError

PARTICIPANTS = ["vehicle-a", "vehicle-b", "vehicle-c"]


def authorize_task(task):
    expected = {"sender": "coordinator", "recipient": "coordinator", "purpose": "traffic_statistics",
                "metric": "mean_speed", "road": "S101", "window_seconds": 60, "participants": PARTICIPANTS}
    if set(task) != set(expected) | {"task_id", "request_id", "issued_at", "expires_at"}:
        raise SecurityError("unauthorized", "任务字段超出批准范围。")
    for key, value in expected.items():
        if task.get(key) != value:
            raise SecurityError("unauthorized", f"未批准的任务参数：{key}。只允许固定三车的 S101 均值统计。")
    if type(task.get("window_seconds")) is not int or any(not isinstance(task.get(k), str) or not 1 <= len(task[k]) <= 128 for k in ("task_id", "request_id")):
        raise SecurityError("invalid_context", "缺少任务绑定信息。")
    now = time.time()
    if any(isinstance(task.get(k), bool) or not isinstance(task.get(k), (int, float)) or not math.isfinite(task[k]) for k in ("issued_at", "expires_at")):
        raise SecurityError("invalid_context", "缺少任务有效期。")
    if not now-60 <= task["issued_at"] <= now+5 or not task["issued_at"] < task["expires_at"] or not now < task["expires_at"] <= task["issued_at"]+120:
        raise SecurityError("expired", "任务已过期或有效期超出批准范围。")
    return task


class ReplayGuard:
    def __init__(self, path, window=64):
        self.path, self.window = path, window
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS replay(sender TEXT,session TEXT,seq INTEGER,PRIMARY KEY(sender,session,seq))")
            db.execute("CREATE TABLE IF NOT EXISTS sessions(sender TEXT,session TEXT,started REAL,expires REAL,PRIMARY KEY(sender,session))")

    def accept(self, payload):
        seq = payload.get("sequence")
        if type(seq) is not int or seq < 0 or seq > 2**31:
            raise SecurityError("invalid_sequence", "无效的消息序号。")
        sender, session = payload["sender"], payload.get("session_id")
        now, expiry = time.time(), payload.get("expires_at", 0)
        issued = payload.get("timestamp", 0)
        if not isinstance(session, str) or not 8 <= len(session) <= 100:
            raise SecurityError("invalid_session", "无效的会话绑定。")
        if not isinstance(expiry, (int, float)) or not isinstance(issued, (int, float)) or not issued - 5 <= now <= expiry or expiry-issued > 120:
            raise SecurityError("expired", "消息已过期。")
        with sqlite3.connect(self.path, timeout=15) as db:
            db.execute("BEGIN IMMEDIATE")
            high = db.execute("SELECT MAX(seq) FROM replay WHERE sender=? AND session=?", (sender,session)).fetchone()[0]
            if high is not None and seq <= high - self.window:
                raise SecurityError("stale_sequence", "消息超出滑动接收窗口。")
            if db.execute("SELECT 1 FROM replay WHERE sender=? AND session=? AND seq=?", (sender,session,seq)).fetchone():
                raise SecurityError("replay", "已认证的同一消息已接收，拒绝重复执行。")
            db.execute("INSERT INTO replay VALUES (?,?,?)", (sender,session,seq))
            db.execute("INSERT OR IGNORE INTO sessions VALUES (?,?,?,?)", (sender,session,now,expiry))
            if high is not None:
                db.execute("DELETE FROM replay WHERE sender=? AND session=? AND seq<?", (sender,session,max(high,seq)-self.window))


class RsuGateway:
    def __init__(self, root, security, audit):
        self.root, self.security, self.audit = root, security, audit
        self.guard = ReplayGuard(root / "replay.sqlite3")
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                claimed = verified = None
                try:
                    if self.path != "/authorize":
                        raise SecurityError("unknown_tool", "该接口未在工具白名单中。")
                    size = int(self.headers.get("Content-Length", "0"))
                    if not 0 < size <= 65536:
                        raise SecurityError("invalid_message", "消息长度超出限制。")
                    envelope = json.loads(self.rfile.read(size))
                    claimed = envelope.get("signer")
                    der = self.connection.getpeercert(binary_form=True)
                    cert = x509.load_der_x509_certificate(der)
                    peer = gateway.security.authenticated_identity(der)
                    # Transport identity and signing identity must agree before attribution.
                    payload = gateway.security.verify(envelope, expected_signer=peer)
                    verified = peer
                    if payload.get("sender") != peer or payload.get("recipient") != "rsu" or payload.get("purpose") != "traffic_statistics":
                        raise SecurityError("context_mismatch", "身份、接收者或消息用途不匹配。")
                    if peer != "coordinator" or payload.get("message_type") != "task":
                        raise SecurityError("unauthorized", "对端无权调用联合统计工具。")
                    task = gateway.security.verify(payload.get("task", {}), expected_signer="coordinator")
                    authorize_task(task)
                    if task["task_id"] != payload.get("task_id") or task["request_id"] != payload.get("request_id"):
                        raise SecurityError("context_mismatch", "任务与传输消息绑定不匹配。")
                    gateway.guard.accept(payload)
                    event = gateway.audit.append("task_authorized", {"task_id": task["task_id"], "transport": "mTLS", "metric": "mean_speed"}, claimed, verified)
                    body = {"accepted": True, "event_id": event["id"], "task_id": task["task_id"]}
                    status = 200
                except (SecurityError, ValueError, TypeError, KeyError) as exc:
                    code = getattr(exc, "code", "invalid_message")
                    message = str(exc) if isinstance(exc, SecurityError) else "消息格式不正确。"
                    event = gateway.audit.append("request_rejected", {"code": code, "layer": "RSU", "reason": message}, claimed, verified)
                    body, status = {"accepted": False, "code": code, "message": message, "event_id": event["id"]}, 403
                raw = json.dumps(body, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.server.timeout = 5
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        context.verify_mode = ssl.CERT_REQUIRED
        context.load_cert_chain(root / "identities/rsu/tls.crt", root / "identities/rsu/tls.key")
        context.load_verify_locations(root / "ca/ca.crt")
        # TLS handshakes occur in request threads; a slow peer cannot block accept().
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True, do_handshake_on_connect=False)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def send(self, envelope, identity="coordinator"):
        context = ssl.create_default_context(cafile=str(self.root / "ca/ca.crt"))
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        context.load_cert_chain(self.root / f"identities/{identity}/tls.crt", self.root / f"identities/{identity}/tls.key")
        with httpx.Client(verify=context, trust_env=False, timeout=10) as client:
            with client.stream("POST", f"https://127.0.0.1:{self.server.server_port}/authorize", json=envelope) as response:
                stream = response.extensions.get("network_stream")
                tls = stream.get_extra_info("ssl_object") if stream else None
                if tls is None:
                    raise SecurityError("untrusted_peer", "未建立可验证的 TLS 连接。")
                self.security.authenticated_identity(tls.getpeercert(True), expected="rsu")
                response.read()
                return response.json()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
