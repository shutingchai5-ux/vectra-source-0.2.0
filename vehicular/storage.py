"""Atomic persistent tasks and input-query budget."""
import hashlib
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from .security import SecurityError, canonical_bytes


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

    def step(self, task_id, agent, action, detail, status="completed"):
        with self.lock:
            task = self.get(task_id)
            task["steps"].append({"agent": agent, "action": action, "detail": detail, "status": status, "at": time.time()})
            return self.update(task_id, steps=task["steps"])

    def reserve_query(self, principal: str, cooldown: float):
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT last_at FROM budgets WHERE principal=?", (principal,)).fetchone()
            now = time.time()
            if row and now - row[0] < cooldown:
                raise SecurityError("query_budget", f"隐私查询冷却中，请在 {int(cooldown - (now-row[0]))+1} 秒后重试。")
            db.execute("INSERT OR REPLACE INTO budgets VALUES (?,?)", (principal, now))

