"""Public task timelines describe actual work without exposing private payloads."""
import json
import time
import uuid

from fastapi.testclient import TestClient
import httpx
import pytest

from vehicular.agents import AgentError, ToolAgent, tool_schema
from vehicular.api import create_app
from vehicular.config import Settings
from vehicular.mpc import MpcError
from vehicular.security import SecurityError
from vehicular.storage import TaskStore


def request_body(text="统计S101三辆车的平均速度"):
    return {"request": text, "request_id": str(uuid.uuid4()), "road": "S101", "window_seconds": 60}


def wait_task(client, task_id):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        task = client.get(f"/api/tasks/{task_id}").json()
        if task["status"] in {"completed", "failed"}:
            return task
        time.sleep(0.025)
    pytest.fail("Task did not finish")


def test_stable_trace_steps_filter_metadata_and_restart_pending_work(tmp_path):
    path = tmp_path / "tasks.sqlite3"
    store = TaskStore(path)
    task, _ = store.create(request_body())
    store.step(task["id"], "安全执行层", "检查", "正在验证", "running", id="stable-step", kind="security",
               metadata={"stage": "signature", "outcome": "pending", "api_key": "not-allowed", "shares": [1, 2],
                         "message_digest": "a" * 64}, evidence_ids=[3, 3, True, "untrusted"])
    first = store.get(task["id"])["steps"][0]
    store.update_step(task["id"], "stable-step", status="completed", detail="验证通过")
    completed = store.get(task["id"])["steps"][0]
    assert completed["id"] == first["id"] and completed["at"] == first["at"]
    assert completed["status"] == "completed" and completed["updated_at"] >= completed["at"]
    assert completed["metadata"] == {"stage": "signature", "outcome": "pending", "message_digest": "a" * 64}
    assert completed["evidence_ids"] == [3]
    store.step(task["id"], "隐私计算模块", "三方协议", "等待批准聚合输出", "running", kind="mpc")
    restarted = TaskStore(path).get(task["id"])
    assert restarted["status"] == "failed"
    assert restarted["steps"][0]["status"] == "completed"
    assert restarted["steps"][1]["status"] == "failed"
    assert "未完成" in restarted["steps"][1]["detail"]


def test_agent_progress_has_stable_lifecycle_and_only_public_action_text(tmp_path):
    secret, hidden, raw_tool = "mock-private-key", "hidden-reasoning-do-not-store", "raw-tool-not-a-progress-detail"
    replies = [
        {"role": "assistant", "content": "先查询公开身份。" + secret, "reasoning_content": hidden,
         "tool_calls": [{"id": "untrusted-call-id", "type": "function", "function": {"name": "identity_status", "arguments": "{}"}}]},
        {"role": "assistant", "content": "公开查询完成。" + secret, "reasoning_content": hidden},
    ]
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"choices": [{"message": replies.pop(0)}]}))
    runner = ToolAgent(Settings(data_dir=tmp_path, mode="llm", llm_model="mock-model", llm_api_key=secret), transport)
    actions, progress = [], []
    result = runner.run("PRIVATE_SYSTEM_PROMPT", "USER_PROMPT_NOT_IN_TRACE", [tool_schema("identity_status", "公开身份")],
                        {"identity_status": lambda: {"public": raw_tool}}, lambda *args: actions.append(args), on_progress=progress.append)
    rendered = json.dumps(progress, ensure_ascii=False)
    assert all(value not in rendered for value in (secret, hidden, raw_tool, "PRIVATE_SYSTEM_PROMPT", "USER_PROMPT_NOT_IN_TRACE", "untrusted-call-id"))
    assert secret not in result and "[凭据已隐藏]" in result
    assert len(actions) == 1 and actions[0][1] == "completed"
    model_events = [event for event in progress if event["action"] == "模型请求"]
    assert [event["status"] for event in model_events] == ["running", "completed", "running", "completed"]
    assert model_events[0]["id"] == model_events[1]["id"]
    assert model_events[2]["metadata"]["tool_result_count"] == 1
    assert all(event["sender"] == "agent" and event["recipient"] == "model" for event in model_events)
    responses = [event for event in progress if event["action"] == "模型响应"]
    assert len(responses) == 2 and all(event["sender"] == "model" and event["recipient"] == "agent" for event in responses)
    tool_events = [event for event in progress if event["kind"] == "tool"]
    assert [event["status"] for event in tool_events] == ["running", "completed"]
    assert tool_events[0]["id"] == tool_events[1]["id"]


def test_agent_progress_records_failure_without_success_or_unverified_tool_start(tmp_path):
    def failed_provider(request):
        return httpx.Response(401, json={"error": "provider-body-not-public"})

    runner = ToolAgent(Settings(data_dir=tmp_path, llm_model="mock-model", llm_api_key="mock-key"), httpx.MockTransport(failed_provider))
    progress = []
    with pytest.raises(AgentError):
        runner.run("system", "user", [], {}, lambda *args: None, on_progress=progress.append)
    assert [event["status"] for event in progress] == ["running", "failed"]
    assert progress[0]["id"] == progress[1]["id"]
    assert "provider-body-not-public" not in json.dumps(progress)
    reply = {"role": "assistant", "content": None, "tool_calls": [{"id": "unknown", "type": "function", "function": {"name": "private_data", "arguments": "{}"}}]}
    runner.transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"choices": [{"message": reply}]}))
    progress.clear()
    with pytest.raises(SecurityError):
        runner.run("system", "user", [], {}, lambda *args: None, on_progress=progress.append)
    assert not any(event["kind"] == "tool" and event["status"] == "running" for event in progress)
    assert progress[-1]["action"] == "未授权工具" and progress[-1]["status"] == "failed"


@pytest.mark.integration
def test_real_demo_task_trace_binds_security_exchange_and_report_evidence(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path, query_cooldown=0))) as client:
        client.get("/")
        accepted = client.post("/api/tasks", json=request_body())
        assert accepted.status_code == 202
        task = wait_task(client, accepted.json()["id"])
        assert task["status"] == "completed", task.get("error")
        assert task["model_context"] == {"mode": "demo", "provider": None, "model": None}
        steps = task["steps"]
        assert all(step["status"] == "completed" for step in steps), steps
        assert len({step["id"] for step in steps}) == len(steps)
        actions = [step["action"] for step in steps]
        for action in ("任务受理", "固定范围策略", "任务与消息签名", "认证与授权", "三方协议", "联合统计完成",
                       "调查委托", "审计链校验", "公开事件摘要", "证据调查", "报告签名", "报告加密保存", "报告验签", "签名与保存"):
            assert action in actions
        assert {step.get("kind") for step in steps} >= {"analysis", "security", "exchange", "mpc", "report"}
        event_ids = {event["id"] for event in client.app.state.service.audit.list(1000)}
        assert any(step.get("evidence_ids") for step in steps)
        assert all(set(step.get("evidence_ids", [])) <= event_ids for step in steps)
        assert any(step.get("sender") == "coordinator" and step.get("recipient") == "rsu" for step in steps)
        assert task["report_verification"]["valid"]
        expected_digest = task["report"]["payload"]["request_digest"]
        assert all(step["metadata"]["request_digest"] == expected_digest for step in steps if "request_digest" in step.get("metadata", {}))
        assert all(not ({"api_key", "shares", "raw_speed", "ciphertext", "private_key"} & set(step.get("metadata", {}))) for step in steps)
        assert steps[-1]["action"] == "签名与保存"


@pytest.mark.integration
def test_failed_task_trace_never_claims_mpc_or_report_completion(tmp_path, monkeypatch):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        client.get("/")
        service = client.app.state.service

        def interrupted_mpc(*args, **kwargs):
            raise MpcError("mpc_timeout", "三方协议超时，未得到批准聚合输出。")

        monkeypatch.setattr(service.mpc, "run", interrupted_mpc)
        task = wait_task(client, client.post("/api/tasks", json=request_body()).json()["id"])
        assert task["status"] == "failed" and task["error"]["code"] == "mpc_timeout"
        assert not task.get("report")
        assert all(step["status"] != "running" for step in task["steps"])
        protocol = next(step for step in task["steps"] if step["action"] == "三方协议")
        assert protocol["status"] == "failed" and "未完成" in protocol["detail"]
        assert not any(step["action"] in {"联合统计完成", "报告签名", "签名与保存"} for step in task["steps"])
        assert task["steps"][-1]["action"] == "任务终止"


@pytest.mark.integration
def test_llm_task_state_redacts_echoed_key_and_records_model_snapshot(tmp_path):
    secret, hidden = "secret-only-in-server-settings", "never-show-hidden-model-reasoning"
    replies = [
        {"role": "assistant", "content": "查询公开身份。" + secret, "reasoning_content": hidden,
         "tool_calls": [{"id": "identity", "type": "function", "function": {"name": "identity_status", "arguments": "{}"}}]},
        {"role": "assistant", "content": "查询完成。" + secret, "reasoning_content": hidden},
    ]
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"choices": [{"message": replies.pop(0)}]}))
    settings = Settings(data_dir=tmp_path, mode="llm", llm_base_url="https://model.example/v1", llm_model="account-model", llm_api_key=secret)
    with TestClient(create_app(settings, llm_transport=transport)) as client:
        client.get("/")
        task = wait_task(client, client.post("/api/tasks", json=request_body("查询已登记节点身份")).json()["id"])
        assert task["status"] == "completed", task.get("error")
        assert task["model_context"] == {"mode": "llm", "provider": "custom", "model": "account-model"}
        assert secret not in client.get("/api/state").text and hidden not in json.dumps(task)
        assert "[凭据已隐藏]" in task["summary"]
        model_steps = [step for step in task["steps"] if step["action"] == "模型请求"]
        assert len(model_steps) == 2 and all(step["status"] == "completed" for step in model_steps)
        assert any(step.get("kind") == "tool" and step["action"] == "identity_status" for step in task["steps"])
