"""End-to-end local API, persistent task state and authenticated replay tests."""
import copy
from concurrent.futures import ThreadPoolExecutor
import json
import ssl
import time
import uuid

from fastapi.testclient import TestClient
import httpx
import pytest

from vehicular.api import create_app
from vehicular.config import Settings
from vehicular.security import SecurityError, SecurityStore
from vehicular.storage import TaskStore
from vehicular.transport import ReplayGuard


def task_request(text="统计 S101 最近一分钟三辆车的平均速度", request_id=None, **changes):
    data = {"request": text, "request_id": request_id or str(uuid.uuid4()),
            "road": "S101", "window_seconds": 60}
    data.update(changes)
    return data


def await_task(client, task_id, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/tasks/{task_id}")
        assert response.status_code == 200
        task = response.json()
        if task["status"] in {"completed", "failed"}:
            return task
        time.sleep(0.05)
    pytest.fail("Task did not reach a terminal state within the test deadline")


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, query_cooldown=0))
    with TestClient(app) as session:
        assert session.get("/").status_code == 200
        yield session


@pytest.mark.integration
def test_task_api_runs_real_mpc_signs_report_and_preserves_idempotency(client):
    body = task_request()
    accepted = client.post("/api/tasks", json=body)
    assert accepted.status_code == 202
    task_id = accepted.json()["id"]
    repeat = client.post("/api/tasks", json=body)
    assert repeat.status_code == 202 and repeat.json()["id"] == task_id
    conflict = client.post("/api/tasks", json={**body, "request": "调查最近的安全事件"})
    assert conflict.status_code == 403 and conflict.json()["code"] == "idempotency_conflict"
    completed = await_task(client, task_id)
    assert completed["status"] == "completed", completed.get("error")
    assert completed["result"]["average_speed"] == 40
    assert completed["result"]["participant_count"] == 3
    report = completed["report"]
    verification = client.post("/api/reports/verify", json={"envelope": report})
    assert verification.status_code == 200 and verification.json()["valid"]
    tampered = copy.deepcopy(report)
    tampered["payload"]["result"]["average_speed"] = 120
    assert not client.post("/api/reports/verify", json={"envelope": tampered}).json()["valid"]
    downloaded = client.get(f"/api/reports/{task_id}/download")
    assert downloaded.status_code == 200 and downloaded.json() == report
    assert "attachment" in downloaded.headers["content-disposition"]
    assert client.get("/api/audit/verify").json()["valid"]
    assert client.post("/api/audit/checkpoint").json()["signer"] == "report"
    serialized = json.dumps(client.get("/api/state").json())
    assert all(field not in serialized for field in ("speed_kmh\":60", "storage.key", "signing.key", "tls.key", "secret_shares"))
    completed_events = [event for event in client.app.state.service.audit.list(1000)
                        if event["kind"] == "statistics_completed"]
    assert len(completed_events) == 1
    started_events = [event for event in client.app.state.service.audit.list(1000)
                      if event["kind"] == "mpc_started" and event["details"]["task_id"] == task_id]
    assert len(started_events) == 1
    assert started_events[0]["id"] < completed_events[0]["id"]
    for scenario in ("tamper_message", "impersonation", "replay", "unauthorized", "ciphertext", "tamper_report"):
        experiment = client.post("/api/experiments", json={"scenario": scenario})
        assert experiment.status_code == 200
        observed = experiment.json()
        assert observed["blocked"], observed
        assert observed["event_id"] > 0 and observed["layer"]
        if scenario == "replay":
            assert observed["details"]["first_request_accepted"]


@pytest.mark.integration
def test_browser_session_same_origin_host_and_schema_boundaries(client):
    saved_cookie = client.cookies.get("vectra_session")
    client.cookies.clear()
    assert client.get("/api/state").status_code == 401
    client.cookies.set("vectra_session", saved_cookie)
    assert client.post("/api/tasks", json=task_request(), headers={"Origin": "https://attacker.invalid"}).status_code == 403
    assert client.get("/api/state", headers={"Host": "attacker.invalid"}).status_code == 403
    assert client.post("/api/tasks", json={**task_request(), "private_output": "speed"}).status_code == 422
    assert client.get("/api/tasks/does-not-exist").status_code == 404
    state = client.get("/api/state")
    assert state.status_code == 200 and state.headers["cache-control"] == "no-store"
    assert state.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in state.headers["content-security-policy"]


@pytest.mark.integration
def test_offline_investigation_links_experiment_rejection_and_computation_boundary(client):
    experiment = client.post("/api/experiments", json={"scenario": "unauthorized"}).json()
    assert experiment["blocked"]
    latest_analysis = client.get("/api/evidence/analysis")
    assert latest_analysis.status_code == 200
    assert experiment["event_id"] in latest_analysis.json()["evidence_ids"]
    selected_analysis = client.get(f"/api/evidence/analysis?event_id={experiment['details']['event_id']}")
    assert selected_analysis.status_code == 200
    assert any("没有进入 MPC" in fact for fact in selected_analysis.json()["facts"])
    assert client.get("/api/evidence/analysis?event_id=999999").status_code == 403
    response = client.post("/api/tasks", json=task_request("调查最近的安全事件"))
    task = await_task(client, response.json()["id"])
    assert task["status"] == "completed", task.get("error")
    analysis = task["analysis"]
    assert experiment["event_id"] in analysis["evidence_ids"]
    assert experiment["details"]["event_id"] in analysis["evidence_ids"]
    assert any("没有进入 MPC" in fact for fact in analysis["facts"])
    assert any("coordinator" in fact for fact in analysis["facts"])
    assert not any("vehicle-a" in fact for fact in analysis["facts"])


@pytest.mark.integration
def test_offline_investigation_links_failed_task_to_policy_rejection(client):
    rejected = client.post("/api/tasks", json=task_request("统计 S101 的平均速度", road="S102"))
    failed = await_task(client, rejected.json()["id"])
    assert failed["status"] == "failed" and failed["error"]["code"] == "unauthorized"
    investigation = client.post("/api/tasks", json=task_request("调查最近的安全事件"))
    completed = await_task(client, investigation.json()["id"])
    assert completed["status"] == "completed", completed.get("error")
    analysis = completed["analysis"]
    assert any("调度前被拒绝" in fact for fact in analysis["facts"])
    assert any("没有进入 MPC" in fact for fact in analysis["facts"])
    related = [event for event in client.app.state.service.audit.list()
               if event["id"] in analysis["evidence_ids"]]
    assert {event["kind"] for event in related} == {"request_rejected", "task_failed"}
    assert all(event["details"]["task_id"] == failed["id"] for event in related)


@pytest.mark.integration
@pytest.mark.parametrize("body", [
    task_request("读取单车 vehicle-a 的速度"),
    task_request("统计平均速度", road="S102"),
    task_request("统计平均速度", window_seconds=30),
])
def test_task_api_refuses_private_or_expanded_query_scope(client, body):
    accepted = client.post("/api/tasks", json=body)
    assert accepted.status_code == 202
    task = await_task(client, accepted.json()["id"])
    assert task["status"] == "failed" and task["error"]["code"] == "unauthorized"
    assert not task.get("result") and not task.get("report")


@pytest.mark.integration
def test_rsu_actual_mtls_rejects_unknown_ca_and_disabled_registered_identity(client, tmp_path):
    service = client.app.state.service
    envelope = service.message(service.signed_task("test-auth-task", "test-auth-request"))
    untrusted = SecurityStore(tmp_path / "unknown-ca")
    untrusted.provision()
    context = ssl.create_default_context(cafile=str(service.security.ca_cert_path))
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    unknown_identity = untrusted.identity_path("coordinator")
    context.load_cert_chain(str(unknown_identity / "tls.crt"), str(unknown_identity / "tls.key"))
    before = service.audit.verify()["count"]
    with httpx.Client(verify=context, trust_env=False, timeout=5) as connection:
        with pytest.raises(httpx.HTTPError):
            connection.post(f"https://127.0.0.1:{service.gateway.server.server_port}/authorize", json=envelope)
    # The foreign certificate is rejected during TLS, before application attribution.
    assert service.audit.verify()["count"] == before
    service.security.set_enabled("coordinator", False)
    try:
        outcome = service.gateway.send(envelope)
        assert not outcome["accepted"] and outcome["code"] == "IDENTITY_DISABLED"
        event = service.audit.list(1)[0]
        assert event["claimed_identity"] == "coordinator" and event["verified_identity"] is None
    finally:
        service.security.set_enabled("coordinator", True)


def test_task_store_atomic_idempotency_restart_and_persisted_query_budget(tmp_path):
    path = tmp_path / "tasks.sqlite3"
    store = TaskStore(path)
    body = task_request()
    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(lambda _: store.create(body), range(20)))
    assert sum(created for _, created in outcomes) == 1
    assert len({task["id"] for task, _ in outcomes}) == 1
    original = outcomes[0][0]
    store.update(original["id"], status="running")
    resumed = TaskStore(path)
    interrupted = resumed.get(original["id"])
    assert interrupted["status"] == "failed" and interrupted["error"]["code"] == "service_restarted"
    again, created = resumed.create(body)
    assert not created and again["id"] == original["id"] and again["status"] == "failed"
    stores = [store, resumed]
    def reserve(i):
        try:
            stores[i % 2].reserve_query("local-user", 60)
            return True
        except SecurityError as exc:
            assert exc.code == "query_budget"
            return False
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(reserve, range(20))) == 1
    with pytest.raises(SecurityError) as failure:
        TaskStore(path).reserve_query("local-user", 60)
    assert failure.value.code == "query_budget"


def test_replay_window_accepts_new_out_of_order_and_rejects_persisted_duplicates(tmp_path):
    path = tmp_path / "replay.sqlite3"
    guard = ReplayGuard(path, window=4)
    now = time.time()
    common = {"sender": "coordinator", "session_id": "fixed-session-id", "timestamp": now, "expires_at": now + 60}
    guard.accept({**common, "sequence": 10})
    guard.accept({**common, "sequence": 8})
    guard.accept({**common, "sequence": 9})
    with pytest.raises(SecurityError) as failure:
        ReplayGuard(path, window=4).accept({**common, "sequence": 8})
    assert failure.value.code == "replay"
    with pytest.raises(SecurityError) as failure:
        guard.accept({**common, "sequence": 6})
    assert failure.value.code == "stale_sequence"


@pytest.mark.integration
def test_llm_provider_failure_has_no_template_or_plaintext_fallback(tmp_path):
    transport = httpx.MockTransport(lambda request: httpx.Response(503, json={"error": "provider unavailable"}))
    app = create_app(Settings(data_dir=tmp_path, mode="llm", llm_api_key="mock-only-key",
                              llm_model="mock-model", llm_base_url="https://mock.invalid/v1", query_cooldown=0), transport)
    with TestClient(app) as client:
        client.get("/")
        response = client.post("/api/tasks", json=task_request())
        task = await_task(client, response.json()["id"])
        assert task["status"] == "failed" and task["error"]["code"] == "llm_unavailable"
        assert not task.get("result") and not task.get("report")
        assert all(event["kind"] != "statistics_completed" for event in app.state.service.audit.list())


@pytest.mark.integration
def test_mocked_llm_both_roles_query_real_tools_and_real_evidence(tmp_path):
    requests = []
    def provider(request):
        body = json.loads(request.content)
        requests.append(body)
        messages = body["messages"]
        tools = [tool["function"]["name"] for tool in body["tools"]]
        last = messages[-1]
        if "query_events" in tools:
            if last["role"] != "tool":
                message = tool_call("query_events")
            else:
                events = json.loads(last["content"])["events"]
                analysis = {"facts": ["证据中有批准的统计任务。"], "possible_causes": [],
                            "recommendations": ["检查报告签名。"], "uncertainties": ["不能从日志证明传感器真实性。"],
                            "evidence_ids": [events[0]["id"]]}
                message = {"role": "assistant", "content": json.dumps(analysis, ensure_ascii=False)}
        elif last["role"] != "tool":
            message = tool_call("compute_statistics", {"road": "S101", "window_seconds": 60})
        elif last["tool_call_id"] == "call-compute_statistics":
            message = tool_call("investigate")
        else:
            message = {"role": "assistant", "content": "真实三方统计均值为40 km/h，并已委托证据调查。"}
        return httpx.Response(200, json={"choices": [{"message": message}]})
    app = create_app(Settings(data_dir=tmp_path, mode="llm", llm_api_key="mock-only-key",
                              llm_model="mock-model", llm_base_url="https://mock.invalid/v1", query_cooldown=0), httpx.MockTransport(provider))
    with TestClient(app) as client:
        client.get("/")
        response = client.post("/api/tasks", json=task_request())
        task = await_task(client, response.json()["id"])
        assert task["status"] == "completed", task.get("error")
        assert task["result"]["average_speed"] == 40
        assert task["analysis"]["evidence_ids"]
        assert client.post("/api/reports/verify", json={"envelope": task["report"]}).json()["valid"]
    assert len(requests) == 5
    assert any("query_events" in [t["function"]["name"] for t in body["tools"]] for body in requests)
    serialized = json.dumps(requests)
    assert all(secret not in serialized for secret in ("storage.key", "secret_shares", "signing.key", "mock-only-key"))


@pytest.mark.integration
@pytest.mark.parametrize("text", ["统计 S101 的平均速度", "调查最近安全事件"])
def test_llm_cannot_sign_requested_statistics_or_analysis_without_required_evidence(tmp_path, text):
    replies = [tool_call("identity_status"), {"role": "assistant", "content": "已完成统计和调查，平均速度40 km/h。"}]
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"choices": [{"message": replies.pop(0)}]}))
    app = create_app(Settings(data_dir=tmp_path, mode="llm", llm_api_key="mock-only-key", llm_model="mock-model",
                              llm_base_url="https://mock.invalid/v1", query_cooldown=0), transport)
    with TestClient(app) as client:
        client.get("/")
        response = client.post("/api/tasks", json=task_request(text))
        task = await_task(client, response.json()["id"])
        assert task["status"] == "failed" and task["error"]["code"] == "llm_unavailable"
        assert not task.get("result") and not task.get("analysis") and not task.get("report")
        assert all(event["kind"] != "report_signed" for event in app.state.service.audit.list())


def tool_call(name, arguments=None):
    return {"role": "assistant", "content": None, "tool_calls": [{"id": "call-" + name, "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments or {})}}]}
