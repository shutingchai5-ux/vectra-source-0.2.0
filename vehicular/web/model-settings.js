"use strict";

(() => {
  const find = (id) => document.getElementById(id);
  const form = find("model-settings-form");
  const fields = find("model-settings-fields");
  const apiFields = find("api-model-fields");
  const providerInput = find("model-provider");
  const baseURLInput = find("model-base-url");
  const modelInput = find("model-name");
  const keyInput = find("model-api-key");
  const saveButton = find("save-model-settings");
  const clearButton = find("clear-model-key");
  const feedback = find("model-settings-feedback");
  const retryButton = find("retry-model-settings");
  const visibilityButton = find("toggle-model-key");
  let saved = null;
  let providers = [];
  let busy = false;
  let dirty = false;

  const selectedMode = () => find("settings-mode-llm").checked ? "llm" : "demo";
  const normalizedURL = (value) => String(value ?? "").trim().replace(/\/+$/, "");
  const canKeepCredential = () => saved?.api_key_configured === true && saved.provider === providerInput.value && normalizedURL(saved.base_url) === normalizedURL(baseURLInput.value);

  function showFeedback(message, style = "") {
    feedback.className = `model-settings-feedback${style ? ` ${style}` : ""}`;
    feedback.textContent = message;
  }

  function concealKey() {
    keyInput.type = "password";
    visibilityButton.textContent = "显示";
    visibilityButton.setAttribute("aria-pressed", "false");
  }

  function setDirty(value) {
    dirty = value;
    find("model-settings-draft").hidden = !value;
  }

  function updateFields() {
    const usesAPI = selectedMode() === "llm";
    const custom = providerInput.value === "custom";
    const keep = canKeepCredential();
    fields.disabled = busy || !saved;
    apiFields.hidden = !usesAPI;
    apiFields.disabled = busy || !saved || !usesAPI;
    find("demo-mode-note").hidden = usesAPI;
    find("custom-model-endpoint").hidden = !custom;
    baseURLInput.disabled = !custom || !usesAPI || busy;
    baseURLInput.required = custom && usesAPI;
    keyInput.required = usesAPI && !keep;
    keyInput.placeholder = keep ? "留空以保留已配置的 API Key" : "输入此提供商的 API Key";
    const credentialStatus = find("model-credential-status");
    credentialStatus.textContent = keep ? "凭据已配置" : "需要 API Key";
    credentialStatus.classList.toggle("configured", keep);
    find("model-key-hint").textContent = keep ? "已配置凭据，留空保留；输入新的 API Key 即可更换。保存后不会回显。" : saved?.api_key_configured ? "提供商或服务地址已变化，请输入对应的新 API Key。" : "请输入此提供商的 API Key。保存后不会回显。";
    const endpointNote = find("model-endpoint-note");
    endpointNote.textContent = custom ? "自定义兼容服务：请确认地址、模型与凭据属于同一服务。" : `${baseURLInput.value || "使用提供商默认地址"}${providerInput.value === "qwen" ? " · 其他地域或工作区地址请选择自定义。" : ""}`;
    saveButton.textContent = busy ? "正在保存…" : usesAPI ? "保存并启用 API Token ↗" : "保存并启用 Demo ↗";
    clearButton.hidden = saved?.api_key_configured !== true;
    clearButton.disabled = busy;
    retryButton.disabled = busy;
  }

  function applySettings(settings) {
    if (!settings || !["demo", "llm"].includes(settings.mode) || !Array.isArray(settings.providers)) throw new Error("模型配置格式无效，请更新服务后重试。");
    saved = {
      mode: settings.mode,
      provider: settings.provider,
      base_url: settings.base_url ?? "",
      model: settings.model ?? "",
      api_key_configured: settings.api_key_configured === true,
    };
    providers = settings.providers;
    providerInput.replaceChildren(...providers.map((provider) => {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.name;
      return option;
    }));
    providerInput.value = saved.provider;
    if (!providerInput.value && providers.length) providerInput.value = providers[0].id;
    baseURLInput.value = saved.base_url;
    modelInput.value = saved.model;
    keyInput.value = "";
    concealKey();
    find("settings-mode-demo").checked = saved.mode === "demo";
    find("settings-mode-llm").checked = saved.mode === "llm";
    find("saved-model-mode").textContent = saved.mode === "llm" ? "当前：API Token 模式" : "当前：Demo 模式";
    setDirty(false);
    updateFields();
  }

  async function settingsRequest(method = "GET", payload = undefined) {
    const response = await fetch("/api/model-settings", {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(payload ? { "Content-Type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (!response.ok) {
      let message = `请求失败（HTTP ${response.status}），请检查配置后重试。`;
      // Validation inputs may contain credentials. Only copy human-readable messages.
      if (typeof result?.detail === "string") message = result.detail;
      else if (Array.isArray(result?.detail)) {
        const fieldNames = { mode: "执行模式", provider: "提供商", base_url: "服务地址", model: "模型名称", api_key: "API Key" };
        const names = [...new Set(result.detail.map((item) => fieldNames[item?.loc?.at(-1)]).filter(Boolean))];
        message = names.length ? `${names.join("、")}未通过校验，请检查填写内容。` : "配置未通过校验，请检查填写内容。";
      }
      if (payload?.api_key) message = message.split(payload.api_key).join("[凭据已隐藏]");
      throw new Error(message);
    }
    return result;
  }

  async function loadSettings() {
    if (busy || dirty) return;
    busy = true;
    updateFields();
    showFeedback("正在读取当前模型配置…");
    retryButton.hidden = true;
    try {
      applySettings(await settingsRequest());
      showFeedback("选择模式并保存，设置将用于随后发起的协作任务。");
    } catch (error) {
      showFeedback(`无法读取模型配置：${error.message}`, "error");
      retryButton.hidden = false;
    } finally {
      busy = false;
      updateFields();
    }
  }

  form.addEventListener("input", () => { if (!busy) setDirty(true); });
  form.addEventListener("change", (event) => {
    if (busy) return;
    if (event.target === providerInput) {
      const provider = providers.find((entry) => entry.id === providerInput.value);
      baseURLInput.value = provider?.base_url ?? "";
      modelInput.value = provider?.default_model ?? "";
      keyInput.value = "";
      concealKey();
    }
    setDirty(true);
    updateFields();
    showFeedback("有未保存的更改，点击保存后启用。");
  });
  baseURLInput.addEventListener("input", updateFields);
  visibilityButton.addEventListener("click", () => {
    const reveal = keyInput.type === "password";
    keyInput.type = reveal ? "text" : "password";
    visibilityButton.textContent = reveal ? "隐藏" : "显示";
    visibilityButton.setAttribute("aria-pressed", String(reveal));
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !saved) return;
    const mode = selectedMode();
    const payload = { mode };
    if (mode === "llm") {
      payload.provider = providerInput.value;
      payload.base_url = baseURLInput.value.trim();
      payload.model = modelInput.value.trim();
      if (!payload.model) { showFeedback("请填写此服务可使用的模型名称。", "error"); modelInput.focus(); return; }
      if (providerInput.value === "custom" && !payload.base_url) { showFeedback("请填写自定义服务的 API Base URL。", "error"); baseURLInput.focus(); return; }
      const enteredKey = keyInput.value.trim();
      if (enteredKey) payload.api_key = enteredKey;
      else if (!canKeepCredential()) { showFeedback("请输入当前提供商与服务地址对应的 API Key。", "error"); keyInput.focus(); return; }
    }
    busy = true;
    updateFields();
    showFeedback("正在保存模型配置…");
    try {
      applySettings(await settingsRequest("PUT", payload));
      showFeedback(saved.mode === "llm" ? "API Token 模式已启用。下一次任务将使用所选模型；保存未触发远程调用。" : "Demo 模式已启用，随后发起的任务将在本地演示环境中执行。", "success");
      toast(saved.mode === "llm" ? "已启用 API Token 模式。" : "已启用 Demo 模式。");
      await refreshState();
    } catch (error) {
      showFeedback(`保存失败：${error.message}`, "error");
    } finally {
      busy = false;
      updateFields();
    }
  });

  clearButton.addEventListener("click", async () => {
    if (busy || saved?.api_key_configured !== true) return;
    busy = true;
    updateFields();
    showFeedback("正在清除已保存的 API Key…");
    try {
      applySettings(await settingsRequest("PUT", { mode: "demo", clear_api_key: true }));
      showFeedback("已清除保存的 API Key，并启用 Demo 模式。", "success");
      toast("API Key 已清除，当前使用 Demo 模式。");
      await refreshState();
    } catch (error) {
      showFeedback(`清除失败：${error.message}`, "error");
    } finally {
      busy = false;
      updateFields();
    }
  });

  retryButton.addEventListener("click", loadSettings);
  document.addEventListener("click", (event) => {
    if (event.target.closest('[data-view="model-settings"]') && !dirty) loadSettings();
  });
  loadSettings();
})();
