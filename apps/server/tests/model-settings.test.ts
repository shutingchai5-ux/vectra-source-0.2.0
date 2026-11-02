import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { modelEndpoint, normalizeModelBaseUrl, resolveThinkingProtocol, type PublicModelSettings } from "@vectra/shared";
import { ModelSettings, runAgent, type ModelConfig } from "../src/model";
import { Security, atomicWrite, canonical, seal } from "../src/security";
import { createModelSettingsEditor } from "../../web/src/model-settings";

test("saved settings require edit mode, cancel restores values, and save locks the complete form", async () => {
  const original = globalThis.fetch, failures: unknown[] = [], writes: any[] = [];
  let failSave = false;
  let current: PublicModelSettings = { mode: "llm", provider: "custom", baseUrl: "https://example.invalid/v1", model: "deepseek-test", hasApiKey: true, ready: true, saved: true, deepThinking: false, thinkingProtocol: "auto", apiFormat: "chat-completions" };
  globalThis.fetch = Object.assign(async (_url: unknown, options?: RequestInit) => {
    if (options?.method === "PUT") {
      const data = JSON.parse(String(options.body)); writes.push(data);
      if (failSave) return Response.json({ code: "invalid_model", message: "模型不支持该设置" }, { status: 422 });
      current = { ...current, model: data.model, deepThinking: data.deepThinking, thinkingProtocol: data.thinkingProtocol, apiFormat: data.apiFormat };
    }
    return Response.json(current);
  }, { preconnect: original.preconnect }) as typeof fetch;
  try {
    const editor = createModelSettingsEditor(() => {}, cause => failures.push(cause));
    await editor.load(); expect(editor.locked.value).toBeTrue(); expect(editor.editing.value).toBeFalse();
    await editor.save(); expect(writes).toHaveLength(0);
    editor.beginEdit(); expect(editor.locked.value).toBeFalse(); editor.form.model = "other"; editor.form.deepThinking = true; editor.form.apiKey = "unsaved-key"; editor.form.apiFormat = "responses";
    editor.cancelEdit(); expect(editor.locked.value).toBeTrue(); expect(editor.form.model).toBe("deepseek-test"); expect(editor.form.deepThinking).toBeFalse(); expect(editor.form.apiKey).toBe(""); expect(String(editor.form.apiFormat)).toBe("chat-completions");
    editor.beginEdit(); editor.form.deepThinking = true; editor.form.apiFormat = "responses"; await editor.save();
    expect(writes[0]).toMatchObject({ deepThinking: true, apiKey: "", clearApiKey: false, apiFormat: "responses" }); expect(editor.locked.value).toBeTrue(); expect(editor.savedNotice.value).toBeTrue(); expect(editor.snapshot.value?.apiFormat).toBe("responses");
    editor.beginEdit(); editor.form.model = "\uFEFF deep\u200Bseek-test \r\n"; editor.form.apiKey = "\n clip\u2060board-key \u200B "; await editor.save();
    expect(writes[1]).toMatchObject({ model: "deepseek-test", apiKey: "clipboard-key" }); expect(editor.locked.value).toBeTrue();
    editor.beginEdit(); editor.form.model = "keep-draft"; failSave = true; await editor.save();
    expect(editor.editing.value).toBeTrue(); expect(editor.form.model).toBe("keep-draft"); expect(failures).toHaveLength(1);
  } finally { globalThis.fetch = original; }
});

test("model settings normalise clipboard residue and report invalid fields without revealing credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-model-input-"));
  try {
    const security = await Security.open(root), settings = new ModelSettings(root, security);
    const input = { provider: "custom", baseUrl: "  https://example.invalid/v1/ \r\n", model: "\uFEFF model\u200B-name \n", apiKey: "\r\n copied\u2060-secret \u200B", apiFormat: "responses" };
    expect(settings.save(input)).toMatchObject({ ready: true, model: "model-name", baseUrl: "https://example.invalid/v1" });
    expect(settings.snapshot().apiKey).toBe("copied-secret"); expect(new ModelSettings(root, security).snapshot().apiKey).toBe("copied-secret");
    settings.save({ ...input, apiKey: " \n", model: "second-model" }); expect(settings.snapshot().apiKey).toBe("copied-secret");
    expect(() => settings.save({ ...input, model: "bad\nmodel" })).toThrow("模型名称中");
    for (const apiKey of ["secret\ninjected", "secret\tinjected", "secret injected"]) {
      try { settings.save({ ...input, apiKey }); throw new Error("Expected invalid key rejection"); }
      catch (cause) { expect((cause as any).code).toBe("invalid_api_key"); expect((cause as Error).message).not.toContain("secret"); }
    }
    expect(settings.snapshot()).toMatchObject({ model: "second-model", apiKey: "copied-secret" });
  } finally { if (resolve(root).startsWith(resolve(tmpdir(), "vectra-model-input-"))) rmSync(root, { recursive: true, force: true }); }
});

test("full endpoint addresses normalise on save and legacy load without losing the current Agent credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-model-url-"));
  try {
    const security = await Security.open(root), settings = new ModelSettings(root, security);
    const input = { provider: "custom", baseUrl: "https://example.invalid/api/v3/chat/completions/", model: "test", apiKey: "url-fixture-key", apiFormat: "chat-completions" };
    expect(settings.save(input).baseUrl).toBe("https://example.invalid/api/v3");
    settings.save({ ...input, apiKey: "" }); expect(settings.snapshot().apiKey).toBe("url-fixture-key");
    const saved = { ...settings.snapshot(), baseUrl: "https://example.invalid/api/v3/chat/completions/chat/completions" };
    atomicWrite(join(root, "model-settings.enc.json"), canonical(seal(saved, security.storageKey(), "model-settings")));
    const reopened = new ModelSettings(root, security); expect(reopened.snapshot()).toMatchObject({ baseUrl: "https://example.invalid/api/v3", model: "test", apiKey: "url-fixture-key", apiFormat: "chat-completions" });
    expect(modelEndpoint(reopened.snapshot().baseUrl, "responses")).toBe("https://example.invalid/api/v3/responses");
    expect(normalizeModelBaseUrl("https://responses")).toBe("https://responses");
    for (const baseUrl of ["https://example.invalid/api/v3?key=private/responses", "https://user:private@example.invalid/api/v3/responses", "https://example.invalid/api/\\v3/responses"]) expect(() => settings.save({ ...input, baseUrl })).toThrow();
  } finally { if (resolve(root).startsWith(resolve(tmpdir(), "vectra-model-url-"))) rmSync(root, { recursive: true, force: true }); }
});

test("both model formats append the selected endpoint exactly once and HTTP errors identify the actual request", async () => {
  const original = globalThis.fetch, seen: unknown[] = [];
  try {
    for (const apiFormat of ["chat-completions", "responses"] as const) {
      const suffix = apiFormat === "responses" ? "/responses" : "/chat/completions", endpoint = "https://example.invalid/api/v3" + suffix;
      globalThis.fetch = Object.assign(async (url: unknown) => { expect(String(url)).toBe(endpoint); return Response.json(apiFormat === "responses" ? { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "完成" }] }] } : { choices: [{ message: { role: "assistant", content: "完成" } }] }); }, { preconnect: original.preconnect }) as typeof fetch;
      const config: ModelConfig = { mode: "llm", provider: "custom", baseUrl: endpoint, apiFormat, model: "test", apiKey: "private-fixture-key" };
      expect(await Effect.runPromise(runAgent(config, "说明系统", [], {}, () => {}, new AbortController().signal))).toBe("完成");
      globalThis.fetch = Object.assign(async (url: unknown) => { expect(String(url)).toBe(endpoint); return new Response("provider-private-body", { status: 404 }); }, { preconnect: original.preconnect }) as typeof fetch;
      const failure = await Effect.runPromise(runAgent(config, "说明系统", [], {}, value => seen.push(value), new AbortController().signal, "coordinator", (_event, detail) => seen.push(detail)).pipe(Effect.either));
      expect(failure._tag).toBe("Left");
      if (failure._tag === "Left") { expect(failure.left.code).toBe("model_unavailable"); expect(failure.left.message).toContain("HTTP 404"); expect(failure.left.message).toContain(endpoint); }
    }
    expect(JSON.stringify(seen)).not.toContain("private-fixture-key"); expect(JSON.stringify(seen)).not.toContain("provider-private-body");
  } finally { globalThis.fetch = original; }
});

test("thinking settings persist encrypted, preserve credentials and snapshots, and migrate old settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-thinking-settings-"));
  try {
    const security = await Security.open(root), settings = new ModelSettings(root, security);
    expect(settings.public().saved).toBeFalse();
    settings.save({ provider: "custom", baseUrl: "https://gateway.invalid/v1", model: "deepseek-test", apiKey: "settings-secret", deepThinking: true, thinkingProtocol: "deepseek" });
    const snapshot = settings.snapshot();
    const reopened = new ModelSettings(root, security);
    expect(reopened.public()).toMatchObject({ saved: true, ready: true, deepThinking: true, thinkingProtocol: "deepseek" });
    expect(reopened.public()).not.toHaveProperty("apiKey");
    reopened.save({ provider: "custom", baseUrl: "https://gateway.invalid/v1", model: "deepseek-test", deepThinking: false, thinkingProtocol: "deepseek" });
    expect(reopened.snapshot().apiKey).toBe("settings-secret"); expect(reopened.snapshot().deepThinking).toBeFalse(); expect(snapshot.deepThinking).toBeTrue();
    reopened.save({ provider: "custom", baseUrl: "https://gateway.invalid/v1", model: "test", apiFormat: "responses", deepThinking: true });
    expect(new ModelSettings(root, security).public().apiFormat).toBe("responses"); expect(reopened.snapshot().apiKey).toBe("settings-secret"); expect(snapshot.apiFormat).toBe("chat-completions");
    expect(() => reopened.save({ provider: "custom", baseUrl: "https://gateway.invalid/v1", model: "test", apiFormat: "unknown" })).toThrow();
    atomicWrite(join(root, "model-settings.enc.json"), canonical(seal({ mode: "llm", provider: "custom", baseUrl: "https://gateway.invalid/v1", model: "test", apiKey: "old-secret" }, security.storageKey(), "model-settings")));
    const migrated = new ModelSettings(root, security); expect(migrated.public()).toMatchObject({ saved: true, deepThinking: false, thinkingProtocol: "auto", apiFormat: "chat-completions" });
    expect(() => migrated.save({ provider: "custom", baseUrl: "https://gateway.invalid/v1", model: "unknown", deepThinking: true })).toThrow("兼容方式");
  } finally { if (resolve(root).startsWith(resolve(tmpdir(), "vectra-thinking-settings-"))) rmSync(root, { recursive: true, force: true }); }
});

test("thinking controls map to provider parameters and default OpenAI chat models remain compatible", async () => {
  const original = globalThis.fetch;
  let payload: any;
  globalThis.fetch = Object.assign(async (_url: unknown, options?: RequestInit) => { payload = JSON.parse(String(options?.body)); return Response.json({ choices: [{ message: { role: "assistant", content: "完成" } }] }); }, { preconnect: original.preconnect }) as typeof fetch;
  try {
    const base: ModelConfig = { mode: "llm", provider: "deepseek", baseUrl: "https://example.invalid/v1", model: "test", apiKey: "key" };
    for (const enabled of [false, true]) {
      for (const provider of ["deepseek", "qwen", "openai"]) {
        await Effect.runPromise(runAgent({ ...base, provider, model: provider === "openai" ? "gpt-6-sol" : "test", deepThinking: enabled }, "说明系统", [], {}, () => {}, new AbortController().signal));
        if (provider === "deepseek") expect(payload.thinking).toEqual({ type: enabled ? "enabled" : "disabled" });
        if (provider === "qwen") expect(payload.enable_thinking).toBe(enabled);
        if (provider === "openai") expect(payload.reasoning_effort).toBe(enabled ? "high" : "none");
      }
    }
    await Effect.runPromise(runAgent({ ...base, provider: "openai", model: "gpt-4.1", deepThinking: false }, "说明系统", [], {}, () => {}, new AbortController().signal));
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(resolveThinkingProtocol({ ...base, provider: "custom", model: "deepseek-v4-test" })).toBe("deepseek");
    expect(resolveThinkingProtocol({ ...base, provider: "custom", model: "unregistered", thinkingProtocol: "qwen" })).toBe("qwen");
    expect(resolveThinkingProtocol({ ...base, provider: "custom", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "deepseek-v4-test" })).toBe("qwen");
  } finally { globalThis.fetch = original; }
});

test("DeepSeek tool continuation replays reasoning only in memory and excludes it from every public trace", async () => {
  const original = globalThis.fetch, progress: unknown[] = [], diagnostics: unknown[] = [];
  let round = 0;
  globalThis.fetch = Object.assign(async (_url: unknown, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body)); round++;
    expect(body.thinking).toEqual({ type: "enabled" });
    if (round === 1) return Response.json({ choices: [{ message: { role: "assistant", content: "", reasoning_content: "private-thinking-must-not-persist", tool_calls: [{ id: "identity-1", type: "function", function: { name: "identity_status", arguments: "{}" } }] } }] });
    expect(body.messages.find((message: any) => message.role === "assistant").reasoning_content).toBe("private-thinking-must-not-persist");
    return Response.json({ choices: [{ message: { role: "assistant", content: "身份检查完成", reasoning_content: "private-final-thinking" } }] });
  }, { preconnect: original.preconnect }) as typeof fetch;
  try {
    const result = await Effect.runPromise(runAgent({ mode: "llm", provider: "deepseek", baseUrl: "https://example.invalid/v1", model: "deepseek-test", apiKey: "test-key", deepThinking: true }, "查询身份", [], {
      identity_status: { description: "公开身份", parameters: { type: "object" }, execute: async () => ({ verified: true }) },
    }, step => progress.push(step), new AbortController().signal, "coordinator", (_event, detail) => diagnostics.push(detail)));
    expect(result).toBe("身份检查完成"); expect(round).toBe(2);
    const publicText = JSON.stringify({ progress, diagnostics });
    expect(publicText).not.toContain("private-thinking-must-not-persist"); expect(publicText).not.toContain("private-final-thinking"); expect(publicText).not.toContain("reasoning_content");
  } finally { globalThis.fetch = original; }
});

test("Responses uses call_id for tools, replays opaque reasoning and assistant phase only in memory", async () => {
  const original = globalThis.fetch, progress: unknown[] = [], diagnostics: unknown[] = [];
  let round = 0;
  const reasoning = { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "private-summary-sentinel" }], encrypted_content: "opaque-reasoning-sentinel" };
  const assistant = { type: "message", id: "msg-1", role: "assistant", phase: "commentary", status: "completed", content: [{ type: "output_text", text: "先核对登记身份。", annotations: [] }], private_provider_field: "private-provider-sentinel" };
  globalThis.fetch = Object.assign(async (url: unknown, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body)); round++;
    expect(String(url)).toBe("https://example.invalid/v1/responses"); expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer test-key");
    expect(body).toMatchObject({ store: false, reasoning: { effort: "high" }, parallel_tool_calls: false });
    expect(body.tools[0]).toMatchObject({ type: "function", name: "identity_status", strict: false });
    for (const key of ["messages", "reasoning_effort", "thinking", "enable_thinking"]) expect(body).not.toHaveProperty(key);
    if (round === 1) return Response.json({ id: "resp-1", status: "completed", output: [reasoning, assistant, { type: "function_call", id: "item-1", call_id: "actual-call-1", name: "identity_status", arguments: "{}" }] });
    expect(body.input).toContainEqual(reasoning); expect(body.input).toContainEqual(assistant);
    expect(body.input.at(-1)).toEqual({ type: "function_call_output", call_id: "actual-call-1", output: '{"verified":true}' });
    return Response.json({ id: "resp-2", status: "completed", output: [{ type: "message", id: "msg-2", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "身份检查完成。" }] }], usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } });
  }, { preconnect: original.preconnect }) as typeof fetch;
  try {
    const result = await Effect.runPromise(runAgent({ mode: "llm", provider: "custom", apiFormat: "responses", thinkingProtocol: "deepseek", baseUrl: "https://example.invalid/v1/", model: "test", apiKey: "test-key", deepThinking: true }, "查询身份", [{ role: "assistant", content: "历史公开回答" }], {
      identity_status: { description: "公开身份", parameters: { type: "object" }, execute: async () => ({ verified: true }) },
    }, step => progress.push(step), new AbortController().signal, "coordinator", (_event, detail) => diagnostics.push(detail)));
    expect(result).toBe("身份检查完成。"); expect(round).toBe(2);
    const publicText = JSON.stringify({ progress, diagnostics });
    for (const secret of ["private-summary-sentinel", "opaque-reasoning-sentinel", "private-provider-sentinel", "test-key"]) expect(publicText).not.toContain(secret);
    expect(publicText).toContain("OpenAI Responses"); expect(publicText).toContain("actual-call-1");
  } finally { globalThis.fetch = original; }
});

test("Responses rejects incomplete output, forbidden tools and invalid arguments before executing tools", async () => {
  const original = globalThis.fetch;
  let executed = 0, requestBody: any;
  const invocation = { type: "function_call", call_id: "call-1", name: "identity_status", arguments: "{}" };
  try {
    for (const [response, code] of [
      [{ status: "incomplete", output: [invocation] }, "model_unavailable"],
      [{ status: "completed", output: [{ ...invocation, name: "unapproved_tool" }] }, "tool_forbidden"],
      [{ status: "completed", output: [{ ...invocation, arguments: "invalid-json" }] }, "invalid_tool"],
      [{ status: "completed", output: [] }, "empty_model_reply"],
    ] as const) {
      globalThis.fetch = Object.assign(async (_url: unknown, options?: RequestInit) => { requestBody = JSON.parse(String(options?.body)); return Response.json(response); }, { preconnect: original.preconnect }) as typeof fetch;
      const result = await Effect.runPromise(runAgent({ mode: "llm", provider: "openai", apiFormat: "responses", baseUrl: "https://example.invalid/v1", model: "test", apiKey: "test-key" }, "查询身份", [], {
        identity_status: { description: "公开身份", parameters: { type: "object" }, execute: async () => { executed++; return {}; } },
      }, () => {}, new AbortController().signal).pipe(Effect.either));
      expect(result._tag).toBe("Left"); if (result._tag === "Left") expect(result.left.code).toBe(code);
      expect(requestBody).not.toHaveProperty("reasoning"); expect(requestBody).not.toHaveProperty("reasoning_effort");
    }
    expect(executed).toBe(0);
  } finally { globalThis.fetch = original; }
});
