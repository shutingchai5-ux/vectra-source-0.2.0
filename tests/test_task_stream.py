"""Live task snapshots preserve ordered progress and recover on reconnect."""
import json
import time
import uuid

from fastapi.testclient import TestClient

from vehicular.api import create_app
from vehicular.config import Settings


def snapshots(response):
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-store"
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def test_task_stream_is_protected_and_replays_completed_or_failed_history(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert client.get("/api/tasks/missing/stream").status_code == 401
        client.get("/")
        assert client.get("/api/tasks/missing/stream").status_code == 404
        service = client.app.state.service
        for status in ("completed", "failed"):
            task, _ = service.tasks.create({"request": "公开状态", "request_id": str(uuid.uuid4()),
                                           "road": "S101", "window_seconds": 60})
            service.tasks.step(task["id"], "安全执行层", "已检查任务", "公开的任务范围", status)
            service.tasks.update(task["id"], status=status)
            url = f"/api/tasks/{task['id']}/stream"
            first = snapshots(client.get(url))
            replay = snapshots(client.get(url, headers={"Last-Event-ID": "old-client-cursor"}))
            assert len(first) == len(replay) == 1
            assert first[0] == replay[0]
            assert first[0]["status"] == status
            assert first[0]["steps"][0]["action"] == "已检查任务"


def test_stream_emits_running_progress_before_terminal_snapshot(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        client.get("/")
        service = client.app.state.service

        def execute(task_id):
            service.tasks.update(task_id, status="running")
            service.tasks.step(task_id, "协调器", "发出任务", "准备发送批准的公开任务", "running")
            time.sleep(0.55)
            service.tasks.step(task_id, "RSU", "授权完成", "固定范围校验通过")
            time.sleep(0.55)
            service.tasks.update(task_id, status="completed", summary="已完成公开状态查询")

        service.execute = execute
        response = client.post("/api/tasks", json={"request": "公开状态", "request_id": str(uuid.uuid4())})
        task_id = response.json()["id"]
        history = snapshots(client.get(f"/api/tasks/{task_id}/stream"))
        assert len(history) >= 3
        running = [task for task in history if task["status"] == "running"]
        assert running and running[0]["steps"][0]["action"] == "发出任务"
        assert any(task["status"] == "running" and len(task["steps"]) == 2 for task in history)
        assert history[-1]["status"] == "completed"
        assert history[-1]["summary"] == "已完成公开状态查询"
        assert [step["action"] for step in history[-1]["steps"]] == ["发出任务", "授权完成"]
