"""Dashboard model choices, credential boundaries and atomic mode changes."""
from dataclasses import replace
import json
import threading
import time
import uuid

from fastapi.testclient import TestClient
import httpx
import pytest

from vehicular.api import create_app
from vehicular.config import Settings
from vehicular.model_settings import (ModelSettingsError, ModelSettingsStore,
                                      initial_settings, public_settings, updated_settings)


def test_provider_change_never_reuses_credentials_and_demo_retains_key(tmp_path):
    original = initial_settings(Settings(data_dir=tmp_path, llm_api_key="original-secret", llm_model="account-model"))
    enabled = updated_settings(original, {"mode": "llm"})
    assert enabled.llm_api_key == "original-secret"
    demo = updated_settings(enabled, {"mode": "demo"})
    assert demo.llm_api_key == "original-secret"
    assert updated_settings(demo, {"mode": "llm", "api_key": ""}).llm_api_key == "original-secret"
    with pytest.raises(ModelSettingsError):
        updated_settings(enabled, {"mode": "llm", "provider": "deepseek"})
    switched = updated_settings(enabled, {"mode": "demo", "provider": "deepseek"})
    assert switched.llm_api_key == ""
    assert switched.llm_model == "deepseek-flash"
    custom = updated_settings(original, {"mode": "llm", "provider": "custom", "base_url": "https://first.example/v1",
                                         "model": "custom-model", "api_key": "custom-secret"})
    with pytest.raises(ModelSettingsError):
        updated_settings(custom, {"mode": "llm", "base_url": "https://second.example/v1"})
    assert updated_settings(custom, {"mode": "demo", "clear_api_key": True}).llm_api_key == ""


@pytest.mark.parametrize("changes", [
    {"provider": "unknown"}, {"provider": []}, {"api_key": ["secret"]}, {"api_key": "bad\nkey"},
    {"api_key": "bad key"}, {"model": "bad\u0085model"}, {"model": "x" * 201},
    {"base_url": "http://remote.example/v1"}, {"base_url": "https://user:secret@example.com/v1"},
    {"base_url": "https://example.com/v1?api_key=secret"}, {"base_url": "https://example.com/v1#secret"},
    {"base_url": "https://example.com:bad/v1"}, {"base_url": "https://example.com/v1?"},
    {"base_url": " https://example.com/v1"}, {"clear_api_key": "yes"}, {"extra": "secret"},
])
def test_validation_errors_do_not_echo_input(tmp_path, changes):
    current = initial_settings(Settings(data_dir=tmp_path))
    with pytest.raises(ModelSettingsError) as error:
        updated_settings(current, {"mode": "llm", "provider": "custom", "base_url": "https://example.com/v1",
                                   "model": "model", "api_key": "valid-secret", **changes})
    assert "secret" not in str(error.value)


def test_model_store_encrypts_key_and_overrides_environment(tmp_path, monkeypatch):
    settings = initial_settings(Settings(data_dir=tmp_path))
    settings = updated_settings(settings, {"mode": "llm", "provider": "custom", "base_url": "http://localhost:8123/v1",
                                          "model": "local-model", "api_key": "saved-key-not-plaintext"})
    store = ModelSettingsStore(tmp_path)
    store.save(settings)
    assert all(b"saved-key-not-plaintext" not in path.read_bytes() for path in store.root.iterdir())
    assert len(store.key_path.read_bytes()) == 32
    monkeypatch.setenv("VECTRA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("VECTRA_MODE", "llm")
    monkeypatch.setenv("LLM_API_KEY", "different-env-key")
    monkeypatch.setenv("LLM_MODEL", "different-env-model")
    loaded = Settings.from_env(tmp_path)
    loaded.validate()  # The CLI performs this check before starting a service.
    assert loaded.llm_api_key == "saved-key-not-plaintext"
    assert loaded.llm_model == "local-model"
    assert loaded.llm_provider == "custom"
    assert loaded.mode == "llm"
    store.save(replace(loaded, mode="demo", llm_api_key=""))
    assert Settings.from_env(tmp_path).llm_api_key == ""
    assert Settings.from_env(tmp_path).mode == "demo"
    assert "saved-key-not-plaintext" not in json.dumps(public_settings(loaded))
    store.key_path.write_bytes(b"invalid")
    with pytest.raises(ModelSettingsError, match="无法解密"):
        store.load(settings)


@pytest.mark.integration
def test_api_settings_switch_transport_restore_and_secret_boundaries(tmp_path):
    requests = []

    def mock_model(request):
        requests.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "ready"}}]})

    transport = httpx.MockTransport(mock_model)
    original = Settings(data_dir=tmp_path)
    with TestClient(create_app(original, llm_transport=transport)) as client:
        assert client.get("/api/model-settings").status_code == 401
        client.get("/")
        defaults = client.get("/api/model-settings").json()
        assert defaults["mode"] == "demo" and defaults["provider"] == "openai"
        assert not defaults["api_key_configured"]
        secret = "new-secret-for-model"
        configured = client.put("/api/model-settings", json={"mode": "llm", "provider": "custom",
                                "base_url": "https://model.example/v1", "model": "account-model", "api_key": secret})
        assert configured.status_code == 200, configured.text
        assert configured.json()["api_key_configured"]
        service = client.app.state.service
        assert service.settings.mode == "llm"
        assert service.agent.transport is transport
        service.agent.complete([], [])
        assert str(requests[-1].url) == "https://model.example/v1/chat/completions"
        assert requests[-1].headers["authorization"] == "Bearer " + secret
        assert json.loads(requests[-1].content)["model"] == "account-model"
        switched = client.put("/api/model-settings", json={"mode": "demo"})
        assert switched.status_code == 200 and switched.json()["api_key_configured"]
        assert client.get("/api/state").json()["mode"] == "demo"
        assert client.put("/api/model-settings", json={"mode": "llm"}).status_code == 200
        assert client.put("/api/model-settings", json={"mode": "llm", "provider": "deepseek"}).status_code == 422
        csrf = client.put("/api/model-settings", json={"mode": "demo"}, headers={"Origin": "https://attacker.example"})
        assert csrf.status_code == 403
        for body in ({"mode": "llm", "api_key": {"secret": secret}}, {"mode": secret}, [secret]):
            rejected = client.put("/api/model-settings", json=body)
            assert rejected.status_code == 422 and secret not in rejected.text
        malformed = client.put("/api/model-settings", content='{"api_key":"' + secret)
        assert malformed.status_code == 422 and secret not in malformed.text
        public = configured.text + client.get("/api/state").text + json.dumps(service.audit.list(1000))
        assert secret not in public
        for path in (tmp_path / "settings").iterdir():
            assert secret.encode() not in path.read_bytes()
    # A directly constructed Settings is overridden just like Settings.from_env.
    with TestClient(create_app(replace(original, llm_api_key="other-key"), llm_transport=transport)) as client:
        client.get("/")
        service = client.app.state.service
        assert service.settings.mode == "llm" and service.settings.llm_api_key == secret
        assert client.get("/api/model-settings").json()["base_url"] == "https://model.example/v1"
        service.agent.complete([], [])
        assert requests[-1].headers["authorization"] == "Bearer " + secret


@pytest.mark.integration
def test_busy_settings_rejected_and_task_admission_is_serialized(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        client.get("/")
        service = client.app.state.service
        with service.execution_lock:
            assert client.put("/api/model-settings", json={"mode": "demo"}).status_code == 409
        queued, _ = service.tasks.create({"request": "调查事件", "request_id": str(uuid.uuid4()), "road": "S101", "window_seconds": 60})
        assert client.put("/api/model-settings", json={"mode": "demo"}).status_code == 409
        service.tasks.update(queued["id"], status="failed")
        entered, release = threading.Event(), threading.Event()
        original_save = service.model_store.save

        def delayed_save(settings):
            entered.set()
            assert release.wait(5)
            original_save(settings)

        service.model_store.save = delayed_save
        outcome = []
        changer = threading.Thread(target=lambda: outcome.append(client.put("/api/model-settings", json={"mode": "demo"})))
        changer.start()
        assert entered.wait(5)
        requests = []
        creator = threading.Thread(target=lambda: requests.append(client.post("/api/tasks", json={
            "request": "调查最近的安全事件", "request_id": str(uuid.uuid4())})))
        creator.start()
        time.sleep(0.05)
        assert not requests
        release.set()
        changer.join(5)
        creator.join(5)
        assert outcome[0].status_code == 200
        assert requests[0].status_code == 202
