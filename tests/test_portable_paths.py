"""Check configuration isolation, installed assets and portable data locations."""
import os
from pathlib import Path
import tomllib

from fastapi.testclient import TestClient
import pytest

from vehicular import config
from vehicular.api import PACKAGE_WEB, create_app
from vehicular.config import Settings, resolve_project_dir


@pytest.fixture(autouse=True)
def isolated_config_env(monkeypatch):
    for name in list(os.environ):
        if name.startswith("VECTRA_") or name.startswith("LLM_"):
            monkeypatch.delenv(name)


def test_checkout_defaults_to_source_root_when_cwd_changes(tmp_path, monkeypatch):
    source_root = tmp_path / "车联网项目 source code"
    source_root.mkdir()
    (source_root / "pyproject.toml").write_text("[project]\nname='fixture'\n", encoding="utf-8")
    (source_root / ".env").write_text("VECTRA_DATA_DIR=本机数据/runtime\nVECTRA_PORT=8123\n", encoding="utf-8-sig")
    elsewhere = tmp_path / "different working directory"
    elsewhere.mkdir()
    monkeypatch.setattr(config, "PACKAGE_ROOT", source_root / "vehicular")
    monkeypatch.chdir(elsewhere)

    settings = Settings.from_env()
    assert settings.data_dir == source_root / "本机数据/runtime"
    assert settings.port == 8123


def test_wheel_uses_working_directory_instead_of_site_packages(tmp_path, monkeypatch):
    site_packages = tmp_path / "readonly installation" / "site-packages"
    monkeypatch.setattr(config, "PACKAGE_ROOT", site_packages / "vehicular")
    working = tmp_path / "用户运行目录 with spaces"
    working.mkdir()
    (working / ".env").write_text("VECTRA_DATA_DIR=private data\n", encoding="utf-8")
    monkeypatch.chdir(working)

    assert resolve_project_dir() == working
    assert Settings.from_env().data_dir == working / "private data"
    assert not site_packages.exists()


def test_explicit_directory_overrides_environment_root_and_cwd(tmp_path, monkeypatch):
    chosen = tmp_path / "指定 project"
    chosen.mkdir()
    (chosen / ".env").write_text("VECTRA_PORT=8101\n", encoding="utf-8")
    env_root = tmp_path / "environment project"
    env_root.mkdir()
    (env_root / ".env").write_text("VECTRA_PORT=8102\n", encoding="utf-8")
    monkeypatch.setenv("VECTRA_PROJECT_DIR", str(env_root))
    monkeypatch.chdir(tmp_path)

    assert Settings.from_env().port == 8102
    assert Settings.from_env(chosen).port == 8101
    assert Settings.from_env(Path("指定 project")).data_dir == chosen / "runtime"


def test_environment_values_override_dotenv_without_global_mutation(tmp_path, monkeypatch):
    first = tmp_path / "first"
    first.mkdir()
    (first / ".env").write_text(
        "LLM_API_KEY=test-local-only\nLLM_MODEL=test-model\nVECTRA_PORT=8111\n", encoding="utf-8"
    )
    second = tmp_path / "second"
    second.mkdir()
    monkeypatch.setenv("VECTRA_PORT", "8222")

    first_settings = Settings.from_env(first)
    second_settings = Settings.from_env(second)
    assert first_settings.port == second_settings.port == 8222
    assert first_settings.llm_api_key == "test-local-only"
    assert "test-local-only" not in repr(first_settings)
    assert second_settings.llm_api_key == ""
    assert "LLM_API_KEY" not in os.environ
    assert "LLM_MODEL" not in os.environ


def test_data_directory_expands_home_and_preserves_absolute_override(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("VECTRA_DATA_DIR", "~/private data")
    assert Settings.from_env(tmp_path / "project").data_dir == tmp_path / "private data"
    absolute = tmp_path / "external runtime"
    monkeypatch.setenv("VECTRA_DATA_DIR", str(absolute))
    assert Settings.from_env(tmp_path / "project").data_dir == absolute


@pytest.mark.parametrize("port", [0, -1, 65536, True, 8000.5])
def test_settings_reject_invalid_port(tmp_path, port):
    with pytest.raises(ValueError, match="VECTRA_PORT"):
        Settings(data_dir=tmp_path, port=port).validate()


@pytest.mark.parametrize("field,value", [("query_cooldown", float("nan")), ("query_cooldown", float("inf")),
                                         ("mpc_timeout", float("nan")), ("mpc_timeout", float("-inf"))])
def test_settings_reject_nonfinite_limits(tmp_path, field, value):
    with pytest.raises(ValueError, match="cooldown or MPC timeout"):
        Settings(data_dir=tmp_path, **{field: value}).validate()


def test_dashboard_assets_come_from_package_even_when_runtime_root_changes(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    app = create_app(Settings(data_dir=tmp_path / "separate runtime"))
    # Static routes need no collaboration-service startup or private data files.
    client = TestClient(app)
    assert client.get("/").status_code == 200
    assert "vectra_session" in client.cookies
    for filename, content_type in [("app.css", "text/css"), ("app.js", "javascript")]:
        response = client.get(f"/assets/{filename}")
        assert response.status_code == 200
        assert content_type in response.headers["content-type"]
    assert PACKAGE_WEB.parent.name == "vehicular"


def test_build_metadata_includes_dashboard_assets():
    project = Path(__file__).resolve().parents[1]
    metadata = tomllib.loads((project / "pyproject.toml").read_text("utf-8"))
    patterns = metadata["tool"]["setuptools"]["package-data"]["vehicular"]
    assert set(patterns) == {"web/*.html", "web/*.css", "web/*.js"}
    assert {path.name for pattern in patterns for path in PACKAGE_WEB.parent.glob(pattern)} == {
        "index.html", "app.css", "app.js"
    }


def test_shutdown_requires_independent_control_token_and_same_origin(tmp_path):
    app = create_app(Settings(data_dir=tmp_path))
    app.state.control_token = "test-private-control"
    calls = []
    app.state.shutdown_callback = lambda: calls.append("requested")
    client = TestClient(app)
    assert client.post("/api/control/shutdown").status_code == 403
    assert client.get("/").status_code == 200
    assert client.post("/api/control/shutdown").status_code == 403
    assert client.post("/api/control/shutdown", headers={"X-Vectra-Control": "wrong"}).status_code == 403
    assert client.post("/api/control/shutdown", headers={"X-Vectra-Control": "test-private-control",
                                                        "Origin": "http://foreign.invalid"}).status_code == 403
    assert calls == []
    response = client.post("/api/control/shutdown", headers={"X-Vectra-Control": "test-private-control"})
    assert response.json() == {"requested": True}
    assert calls == ["requested"]
    # Possessing the stop credential cannot read Agent state or reports.
    client.cookies.clear()
    assert client.get("/api/state", headers={"X-Vectra-Control": "test-private-control"}).status_code == 401


def test_standalone_api_has_no_shutdown_control(tmp_path):
    client = TestClient(create_app(Settings(data_dir=tmp_path)))
    assert client.post("/api/control/shutdown", headers={"X-Vectra-Control": "any"}).status_code == 403
