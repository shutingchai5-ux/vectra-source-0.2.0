import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { resolveThinkingProtocol, type PublicModelSettings } from "@vectra/shared";
import { ModelSettings, runAgent, type ModelConfig } from "../src/model";
import { Security, atomicWrite, canonical, seal } from "../src/security";
import { createModelSettingsEditor } from "../../web/src/model-settings";

test("saved settings require edit mode, cancel restores values, and save locks the complete form", async () => {
  const original = globalThis.fetch, failures: unknown[] = [], writes: any[] = [];
  let failSave = false;
  let current: PublicModelSettings = { mode: "llm", provider: "custom", baseUrl: "https://example.invalid/v1", model: "deepseek-test", hasApiKey: true, ready: true, saved: true, deepThinking: false, thinkingProtocol: "auto" };
  globalThis.fetch = Object.assign(async (_url: unknown, options?: RequestInit) => {
    if (options?.method === "PUT") {
      const data = JSON.parse(String(options.body)); writes.push(data);
      if (failSave) return Response.json({ code: "invalid_model", message: "模型不支持该设置" }, { status: 422 });
      current = { ...current, model: data.model, deepThinking: data.deepThinking, thinkingProtocol: data.thinkingProtocol };
    }
    return Response.json(current);
  }, { preconnect: original.preconnect }) as typeof fetch;
  try {
    const editor = createModelSettingsEditor(() => {}, cause => failures.push(cause));
    await editor.load(); expect(editor.locked.value).toBeTrue(); expect(editor.editing.value).toBeFalse();
    await editor.save(); expect(writes).toHaveLength(0);
    editor.beginEdit(); expect(editor.locked.value).toBeFalse(); editor.form.model = "other"; editor.form.deepThinking = true; editor.form.apiKey = "unsaved-key";
    editor.cancelEdit(); expect(editor.locked.value).toBeTrue(); expect(editor.form.model).toBe("deepseek-test"); expect(editor.form.deepThinking).toBeFalse(); expect(editor.form.apiKey).toBe("");
    editor.beginEdit(); editor.form.deepThinking = true; await editor.save();
    expect(writes[0]).toMatchObject({ deepThinking: true, apiKey: "", clearApiKey: false }); expect(editor.locked.value).toBeTrue(); expect(editor.savedNotice.value).toBeTrue();
    editor.beginEdit(); editor.form.model = "keep-draft"; failSave = true; await editor.save();
    expect(editor.editing.value).toBeTrue(); expect(editor.form.model).toBe("keep-draft"); expect(failures).toHaveLength(1);
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
    atomicWrite(join(root, "model-settings.enc.json"), canonical(seal({ mode: "llm", provider: "custom", baseUrl: "https://gateway.invalid/v1", model: "test", apiKey: "old-secret" }, security.storageKey(), "model-settings")));
    const migrated = new ModelSettings(root, security); expect(migrated.public()).toMatchObject({ saved: true, deepThinking: false, thinkingProtocol: "auto" });
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
    }, step => progress.push(step), new AbortController().signal, "任务协调 Agent", (_event, detail) => diagnostics.push(detail)));
    expect(result).toBe("身份检查完成"); expect(round).toBe(2);
    const publicText = JSON.stringify({ progress, diagnostics });
    expect(publicText).not.toContain("private-thinking-must-not-persist"); expect(publicText).not.toContain("private-final-thinking"); expect(publicText).not.toContain("reasoning_content");
  } finally { globalThis.fetch = original; }
});
