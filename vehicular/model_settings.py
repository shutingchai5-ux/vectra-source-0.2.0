"""Validated dashboard model choices with encrypted local credential storage."""
from dataclasses import replace
from pathlib import Path
import unicodedata
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .security import SecurityError, _atomic_write, secure_read, secure_write


PROVIDERS = (
    {"id": "openai", "name": "OpenAI", "base_url": "https://api.openai.com/v1", "default_model": ""},
    {"id": "deepseek", "name": "DeepSeek", "base_url": "https://api.deepseek.com", "default_model": "deepseek-flash"},
    {"id": "qwen", "name": "通义千问 · 北京", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "default_model": "qwen-plus"},
    {"id": "custom", "name": "自定义兼容服务", "base_url": "", "default_model": ""},
)
_PRESETS = {provider["id"]: provider for provider in PROVIDERS}


class ModelSettingsError(ValueError):
    """Only constant, credential-free messages may reach a browser."""

    def __init__(self, message, status_code=422):
        super().__init__(message)
        self.status_code = status_code


def _text(value, maximum, message, *, empty=False):
    if (not isinstance(value, str) or len(value) > maximum or (not empty and not value)
            or any(unicodedata.category(char) in {"Cc", "Cf"} for char in value)):
        raise ModelSettingsError(message)
    return value


def _base_url(value):
    value = _text(value, 2048, "API 地址无效。")
    if value != value.strip() or any(char.isspace() for char in value) or "\\" in value:
        raise ModelSettingsError("API 地址无效。")
    try:
        parts = urlsplit(value)
        parts.port  # Validate malformed port numbers without echoing the address.
        local = parts.hostname in {"localhost", "127.0.0.1", "::1"}
        if (not parts.hostname or parts.username is not None or parts.password is not None
                or parts.query or parts.fragment or "?" in value or "#" in value
                or (parts.scheme != "https" and not (parts.scheme == "http" and local))):
            raise ValueError
    except ValueError:
        raise ModelSettingsError("API 地址须使用 HTTPS，本机服务可使用 HTTP；不能包含账号、查询参数或片段。") from None
    return value.rstrip("/")


def _inferred_provider(base_url):
    return next((item["id"] for item in PROVIDERS if item["id"] != "custom"
                 and item["base_url"] == base_url), "custom")


def initial_settings(settings):
    """Retain environment credentials until a dashboard setting is persisted."""
    provider = settings.llm_provider or _inferred_provider(settings.llm_base_url.rstrip("/"))
    if provider not in _PRESETS:
        raise ModelSettingsError("模型提供商无效。")
    base_url = _base_url(settings.llm_base_url)
    if provider != "custom" and base_url != _PRESETS[provider]["base_url"]:
        raise ModelSettingsError("预设提供商的 API 地址不匹配。")
    _text(settings.llm_api_key, 4096, "API Key 格式无效。", empty=True)
    model = settings.llm_model or _PRESETS[provider]["default_model"]
    _text(model, 200, "模型名称无效。", empty=settings.mode == "demo")
    return replace(settings, llm_provider=provider, llm_base_url=base_url, llm_model=model)


def updated_settings(current, body):
    if (not isinstance(body, dict) or not set(body) <= {
            "mode", "provider", "base_url", "model", "api_key", "clear_api_key"}):
        raise ModelSettingsError("模型设置结构无效。")
    mode = body.get("mode")
    if not isinstance(mode, str) or mode not in {"demo", "llm"}:
        raise ModelSettingsError("请选择 Demo 或 API Token 模式。")
    provider = body.get("provider", current.llm_provider)
    if not isinstance(provider, str) or provider not in _PRESETS:
        raise ModelSettingsError("请选择有效的模型提供商。")
    preset = _PRESETS[provider]
    changed_provider = provider != current.llm_provider
    default_url = preset["base_url"] if provider != "custom" else ("" if changed_provider else current.llm_base_url)
    base_url = _base_url(body.get("base_url", default_url))
    if provider != "custom" and base_url != preset["base_url"]:
        raise ModelSettingsError("预设提供商的 API 地址不能修改；请使用自定义兼容服务。")
    changed_destination = changed_provider or base_url != current.llm_base_url
    default_model = preset["default_model"] if changed_destination else current.llm_model
    model = _text(body.get("model", default_model), 200, "请填写有效的模型名称。", empty=mode == "demo")
    if model != model.strip():
        raise ModelSettingsError("模型名称不能包含首尾空格。")
    clear_key = body.get("clear_api_key", False)
    if type(clear_key) is not bool:
        raise ModelSettingsError("清除 API Key 选项无效。")
    supplied_key = body.get("api_key")
    if supplied_key is not None:
        supplied_key = _text(supplied_key, 4096, "API Key 格式无效。", empty=True)
        if any(char.isspace() for char in supplied_key) or not supplied_key.isascii():
            raise ModelSettingsError("API Key 必须是没有空白字符的 ASCII Token。")
    if clear_key and supplied_key:
        raise ModelSettingsError("不能同时填写和清除 API Key。")
    api_key = supplied_key or ("" if clear_key or changed_destination else current.llm_api_key)
    if mode == "llm" and (not api_key or not model):
        raise ModelSettingsError("API Token 模式需要模型名称和 API Key；切换提供商或地址时请重新填写 Key。")
    result = replace(current, mode=mode, llm_provider=provider, llm_base_url=base_url,
                     llm_model=model, llm_api_key=api_key)
    result.validate()
    return result


def public_settings(settings):
    return {"mode": settings.mode, "provider": settings.llm_provider,
            "base_url": settings.llm_base_url, "model": settings.llm_model,
            "api_key_configured": bool(settings.llm_api_key),
            "providers": [dict(provider) for provider in PROVIDERS]}


class ModelSettingsStore:
    def __init__(self, data_dir):
        self.root = Path(data_dir) / "settings"
        self.key_path = self.root / "model-storage.key"
        self.path = self.root / "model-settings.enc"

    def load(self, settings):
        if not self.path.exists():
            return initial_settings(settings)
        try:
            key = self.key_path.read_bytes()
            if len(key) != 32:
                raise ValueError
            saved = secure_read(self.path, key, context="dashboard-model-settings")
            # Persisted values take precedence over .env, including empty keys.
            baseline = replace(settings, mode="demo", llm_provider="openai",
                               llm_base_url=_PRESETS["openai"]["base_url"],
                               llm_model=_PRESETS["openai"]["default_model"], llm_api_key="")
            return updated_settings(baseline, saved)
        except (OSError, ValueError, TypeError, KeyError, SecurityError):
            raise ModelSettingsError("本地模型设置无法解密或格式无效，请检查 settings 目录和本机密钥。", 503) from None

    def save(self, settings):
        try:
            if self.key_path.exists():
                key = self.key_path.read_bytes()
                if len(key) != 32:
                    raise ValueError
            else:
                key = AESGCM.generate_key(bit_length=256)
                _atomic_write(self.key_path, key, private=True)
            secure_write(self.path, key, {"mode": settings.mode, "provider": settings.llm_provider,
                         "base_url": settings.llm_base_url, "model": settings.llm_model,
                         "api_key": settings.llm_api_key}, context="dashboard-model-settings")
        except (OSError, ValueError, SecurityError):
            raise ModelSettingsError("本地模型设置保存失败，请检查数据目录权限。", 503) from None
