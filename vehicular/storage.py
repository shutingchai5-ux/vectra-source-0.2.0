"""Atomic persistent tasks and input-query budget."""
import hashlib
import json
import math
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from .security import SecurityError, canonical_bytes


TRACE_KINDS = {"model", "tool", "security", "exchange", "mpc", "report", "analysis"}
TRACE_METADATA = {
    "mode", "provider", "model", "tool", "round", "tool_result_count", "tool_count", "phase", "stage", "peer",
    "task_id", "request_id", "request_digest", "task_digest", "message_digest", "report_digest", "message_type",
    "session_id", "sequence", "metric", "road", "window_seconds", "participant_count", "threshold",
    "event_id", "check", "outcome", "tls_version", "transport", "protocol", "status_code", "elapsed_ms",
    "participants", "sender_role", "recipient_role", "certificate_fingerprint", "code", "count",
    "cipher", "peer_fingerprint", "source",
}


def _public_metadata(metadata):
    """Trace metadata is fixed public protocol context, never arbitrary payloads."""
    if not isinstance(metadata, dict):
        return {}
    result = {}
    for key, value in metadata.items():
        if key not in TRACE_METADATA:
            continue
        if isinstance(value, str) and len(value) <= 512 and all(ord(char) >= 32 for char in value):
            result[key] = value
        elif value is None or type(value) in {bool, int}:
            result[key] = value
        elif type(value) is float and math.isfinite(value):
            result[key] = value
        elif key == "participants" and isinstance(value, list) and len(value) <= 16:
            result[key] = [item for item in value if isinstance(item, str) and len(item) <= 80]
    return result


class TaskStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,
                    digest TEXT NOT NULL, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS budgets (principal TEXT PRIMARY KEY, last_at REAL);
            """)
            # Interrupted computations are never silently rerun after restart.
            for row in db.execute("SELECT id, body FROM tasks").fetchall():
                task = json.loads(row[1])
                if task["status"] in {"queued", "running"}:
                    task.update(status="failed", error={"code": "service_restarted", "message": "服务重启，未完成任务已停止，请创建新的请求。"})
                    for step in task.get("steps", []):
                        if step.get("status") in {"queued", "running"}:
                            step.update(status="failed", updated_at=time.time(),
                                        detail=step.get("detail", "") + "（服务重启，此步骤未完成。）")
                    db.execute("UPDATE tasks SET body=? WHERE id=?", (json.dumps(task, ensure_ascii=False), row[0]))

    def connect(self):
        return sqlite3.connect(self.path, timeout=15)

    def create(self, request: dict):
        digest = hashlib.sha256(canonical_bytes({k: v for k, v in request.items() if k != "request_id"})).hexdigest()
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT digest,body FROM tasks WHERE request_id=?", (request["request_id"],)).fetchone()
            if row:
                if row[0] != digest:
                    raise SecurityError("idempotency_conflict", "相同请求 ID 不能绑定不同内容。")
                return json.loads(row[1]), False
            task = {"id": str(uuid.uuid4()), "request_id": request["request_id"], "request": request["request"],
                    "road": request["road"], "window_seconds": request["window_seconds"],
                    "created_at": time.time(), "status": "queued", "steps": []}
            db.execute("INSERT INTO tasks VALUES (?,?,?,?)", (task["id"], request["request_id"], digest, json.dumps(task, ensure_ascii=False)))
            return task, True

    def get(self, task_id):
        with self.connect() as db:
            row = db.execute("SELECT body FROM tasks WHERE id=?", (task_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def list(self, limit=50):
        with self.connect() as db:
            rows = db.execute("SELECT body FROM tasks ORDER BY rowid DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def update(self, task_id, **values):
        with self.lock, self.connect() as db:
            row = db.execute("SELECT body FROM tasks WHERE id=?", (task_id,)).fetchone()
            task = json.loads(row[0])
            task.update(values)
            db.execute("UPDATE tasks SET body=? WHERE id=?", (json.dumps(task, ensure_ascii=False, allow_nan=False), task_id))
            return task

    def step(self, task_id, agent, action, detail, status="completed", *, id=None, kind=None,
             sender=None, recipient=None, protocol=None, evidence_ids=None, metadata=None):
        with self.lock:
            task = self.get(task_id)
            now = time.time()
            step = {"id": id or str(uuid.uuid4()), "agent": agent, "action": action, "detail": detail,
                    "status": status, "at": now}
            if kind in TRACE_KINDS:
                step["kind"] = kind
            for name, value in (("sender", sender), ("recipient", recipient), ("protocol", protocol)):
                if isinstance(value, str) and len(value) <= 160:
                    step[name] = value
            if evidence_ids is not None:
                step["evidence_ids"] = list(dict.fromkeys(value for value in evidence_ids if type(value) is int and value > 0))[:80]
            if metadata is not None:
                step["metadata"] = _public_metadata(metadata)
            existing = next((item for item in task["steps"] if item.get("id") == step["id"]), None)
            if existing is None:
                task["steps"].append(step)
            else:
                step.pop("at")
                existing.update(step, updated_at=now)
            return self.update(task_id, steps=task["steps"])

    def update_step(self, task_id, step_id, **values):
        with self.lock:
            current = next((step for step in self.get(task_id)["steps"] if step.get("id") == step_id), None)
            if current is None:
                raise KeyError("Task step does not exist")
            allowed = {key: current[key] for key in ("agent", "action", "detail", "status", "kind", "sender", "recipient", "protocol", "evidence_ids", "metadata") if key in current}
            allowed.update(values)
            return self.step(task_id, id=step_id, **allowed)

    def reserve_query(self, principal: str, cooldown: float):
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT last_at FROM budgets WHERE principal=?", (principal,)).fetchone()
            now = time.time()
            if row and now - row[0] < cooldown:
                raise SecurityError("query_budget", f"隐私查询冷却中，请在 {int(cooldown - (now-row[0]))+1} 秒后重试。")
            db.execute("INSERT OR REPLACE INTO budgets VALUES (?,?)", (principal, now))

