"""Portable local configuration; credentials never enter Agent state."""
import math
import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import dotenv_values

PACKAGE_ROOT = Path(__file__).resolve().parent
# Compatibility for callers that need the source/package location. Runtime data
# and .env discovery use resolve_project_dir() instead of this constant.
PROJECT_ROOT = PACKAGE_ROOT.parent


def resolve_project_dir(project_dir=None):
    """Select writable configuration/data location for a checkout or wheel.

    An explicit CLI/API directory wins over VECTRA_PROJECT_DIR. A source checkout
    defaults to its own root even when launched from elsewhere. A wheel defaults
    to the caller's working directory, never the installation's site-packages.
    """
    selected = project_dir if project_dir is not None else os.environ.get("VECTRA_PROJECT_DIR")
    if selected is not None:
        return Path(selected).expanduser().resolve()
    source_root = PACKAGE_ROOT.parent
    if (source_root / "pyproject.toml").is_file():
        return source_root
    return Path.cwd().resolve()


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    mode: str = "demo"
    host: str = "127.0.0.1"
    port: int = 8000
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = field(default="", repr=False)
    llm_model: str = ""
    llm_provider: str = ""
    query_cooldown: float = 30
    mpc_timeout: float = 20

    @classmethod
    def from_env(cls, project_dir=None):
        root = resolve_project_dir(project_dir)
        # Read only this project's .env. Avoid mutating os.environ: two app
        # instances can use separate project directories in the same process.
        values = {key: value for key, value in dotenv_values(root / ".env", encoding="utf-8-sig", interpolate=False).items()
                  if value is not None}
        values.update(os.environ)
        path = Path(values.get("VECTRA_DATA_DIR", "runtime")).expanduser()
        settings = cls(
            data_dir=(path if path.is_absolute() else root / path).resolve(),
            mode=values.get("VECTRA_MODE", "demo"),
            host=values.get("VECTRA_HOST", "127.0.0.1"),
            port=int(values.get("VECTRA_PORT", "8000")),
            llm_base_url=values.get("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
            llm_api_key=values.get("LLM_API_KEY", ""),
            llm_model=values.get("LLM_MODEL", ""),
            llm_provider=values.get("LLM_PROVIDER", ""),
            query_cooldown=float(values.get("VECTRA_QUERY_COOLDOWN", "30")),
            mpc_timeout=float(values.get("VECTRA_MPC_TIMEOUT", "20")),
        )
        # CLI validation and diagnostics must see the same persisted choices
        # as the service, before checking a possibly incomplete old .env.
        from .model_settings import ModelSettingsStore
        return ModelSettingsStore(settings.data_dir).load(settings)

    def validate(self):
        if self.mode not in {"demo", "llm"}:
            raise ValueError("VECTRA_MODE must be demo or llm")
        if self.host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("This classroom version only permits a loopback dashboard")
        if not isinstance(self.port, int) or isinstance(self.port, bool) or not 1 <= self.port <= 65535:
            raise ValueError("VECTRA_PORT must be an integer between 1 and 65535")
        if self.mode == "llm" and not (self.llm_api_key and self.llm_model):
            raise ValueError("LLM mode requires LLM_API_KEY and LLM_MODEL; use demo for offline runs")
        if (not math.isfinite(self.query_cooldown) or self.query_cooldown < 0
                or not math.isfinite(self.mpc_timeout) or not 1 <= self.mpc_timeout <= 120):
            raise ValueError("Invalid query cooldown or MPC timeout")
