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
_RSU_CHECKS = {
    "transport_identity": ("TLS 对端身份验证", "RSU 已将实际 TLS 客户端证书绑定到登记身份。"),
    "message_signature": ("消息数字签名验证", "消息 Ed25519 签名与 TLS 对端身份一致。"),
    "message_context": ("消息上下文校验", "消息发送者、接收者、用途与允许调用的身份一致。"),
    "task_signature": ("独立任务签名验证", "内层任务已通过协调器签名验证。"),
    "task_policy": ("最小授权策略校验", "任务仅允许固定三车、S101、60 秒窗口和均值输出，且仍在有效期内。"),
    "task_binding": ("任务与消息绑定校验", "内层任务与传输消息的任务及请求标识一致。"),
    "replay_guard": ("防重放窗口校验", "认证消息已通过持久化序号与会话接收窗口检查。"),
}


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
                signed_task_id = None
                checks = []
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
                    checks.append("transport_identity")
                    # Transport identity and signing identity must agree before attribution.
                    payload = gateway.security.verify(envelope, expected_signer=peer)
                    verified = peer
                    checks.append("message_signature")
                    if payload.get("sender") != peer or payload.get("recipient") != "rsu" or payload.get("purpose") != "traffic_statistics":
                        raise SecurityError("context_mismatch", "身份、接收者或消息用途不匹配。")
                    if peer != "coordinator" or payload.get("message_type") != "task":
                        raise SecurityError("unauthorized", "对端无权调用联合统计工具。")
                    checks.append("message_context")
                    task = gateway.security.verify(payload.get("task", {}), expected_signer="coordinator")
                    checks.append("task_signature")
                    if isinstance(task.get("task_id"), str):
                        signed_task_id = task["task_id"]
                    authorize_task(task)
                    checks.append("task_policy")
                    if task["task_id"] != payload.get("task_id") or task["request_id"] != payload.get("request_id"):
                        raise SecurityError("context_mismatch", "任务与传输消息绑定不匹配。")
                    checks.append("task_binding")
                    gateway.guard.accept(payload)
                    checks.append("replay_guard")
                    event = gateway.audit.append("task_authorized", {"task_id": task["task_id"], "transport": "mTLS", "metric": "mean_speed"}, claimed, verified)
                    body = {"accepted": True, "event_id": event["id"], "task_id": task["task_id"]}
                    status = 200
                except (SecurityError, ValueError, TypeError, KeyError) as exc:
                    code = getattr(exc, "code", "invalid_message")
                    message = str(exc) if isinstance(exc, SecurityError) else "消息格式不正确。"
                    details = {"code": code, "layer": "RSU", "reason": message}
                    if signed_task_id is not None:
                        details["task_id"] = signed_task_id
                    event = gateway.audit.append("request_rejected", details, claimed, verified)
                    body, status = {"accepted": False, "code": code, "message": message, "event_id": event["id"]}, 403
                body["checks"] = checks
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

    def send(self, envelope, identity="coordinator", on_progress=None):
        actor = identity if identity in {"coordinator", "analyst", "report", "rsu", *PARTICIPANTS} else "client"

        def progress(action, detail, *, status="completed", kind="security", sender=None,
                     recipient="rsu", metadata=None, evidence_ids=None, identifier=None):
            if on_progress is not None:
                event = {"agent": "RSU 安全网关", "action": action, "detail": detail, "status": status,
                         "kind": kind, "sender": sender or actor, "recipient": recipient,
                         "protocol": "mTLS / TLS 1.3 / Ed25519", "metadata": metadata or {}}
                if evidence_ids:
                    event["evidence_ids"] = evidence_ids
                if identifier is not None:
                    event["id"] = identifier
                on_progress(event)

        context = ssl.create_default_context(cafile=str(self.root / "ca/ca.crt"))
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        context.load_cert_chain(self.root / f"identities/{identity}/tls.crt", self.root / f"identities/{identity}/tls.key")
        progress("发送签名任务封装", "开始向 RSU 提交携带签名的任务消息；接收方将独立验证。", status="running",
                 kind="exchange", metadata={"stage": "request_started"}, identifier="rsu-request")
        with httpx.Client(verify=context, trust_env=False, timeout=10) as client:
            with client.stream("POST", f"https://127.0.0.1:{self.server.server_port}/authorize", json=envelope) as response:
                stream = response.extensions.get("network_stream")
                tls = stream.get_extra_info("ssl_object") if stream else None
                if tls is None or tls.version() != "TLSv1.3":
                    raise SecurityError("untrusted_peer", "未建立可验证的 TLS 连接。")
                certificate = tls.getpeercert(True)
                self.security.authenticated_identity(certificate, expected="rsu")
                progress("签名任务封装已发送", "携带签名的任务消息已发送到 RSU；消息内容不进入过程记录。",
                         kind="exchange", metadata={"stage": "request_sent"}, identifier="rsu-request")
                progress("RSU 连接身份已验证", "实际连接已协商 TLS 1.3，并验证 RSU 证书与登记身份。",
                         sender="rsu", recipient=actor,
                         metadata={"stage": "rsu_peer_verified", "tls_version": tls.version(),
                                   "cipher": tls.cipher()[0], "peer_fingerprint": hashlib.sha256(certificate).hexdigest()})
                response.read()
                body = response.json()
                event_id = body.get("event_id")
                evidence = [event_id] if type(event_id) is int and event_id > 0 else []
                for check in body.get("checks", []):
                    if isinstance(check, str) and check in _RSU_CHECKS:
                        action, detail = _RSU_CHECKS[check]
                        progress(action, detail, sender="rsu", recipient=actor,
                                 metadata={"stage": "rsu_check", "check": check, **({"event_id": event_id} if evidence else {})},
                                 evidence_ids=evidence)
                accepted = body.get("accepted") is True
                progress("收到 RSU 授权" if accepted else "收到 RSU 拒绝", "RSU 已批准此请求进入隐私计算调度。" if accepted else "RSU 已拒绝本次请求；后续未完成的校验不标记为通过。",
                         status="completed" if accepted else "rejected", kind="exchange", sender="rsu", recipient=actor,
                         metadata={"stage": "authorization_response", "outcome": "accepted" if accepted else "rejected",
                                   **({"event_id": event_id} if evidence else {})}, evidence_ids=evidence)
                return body

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
