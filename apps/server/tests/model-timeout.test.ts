import { expect, test } from "bun:test";
import { Effect } from "effect";
import { config as runtimeConfig, DEFAULT_MODEL_TIMEOUT_MS, DEFAULT_TASK_TIMEOUT_MS } from "../src/config";
import { runAgent, type ModelConfig } from "../src/model";
import { taskRecovery } from "../../web/src/step-explanations";

const model: ModelConfig = { mode: "llm", provider: "custom", baseUrl: "https://example.invalid/v1", model: "test-model", apiKey: "private-timeout-key", thinkingProtocol: "openai" };
const waitForAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

test("single-response and task deadlines have separate defaults, second-based overrides and bounded validation", () => {
  const saved = { model: process.env.VECTRA_MODEL_TIMEOUT, task: process.env.VECTRA_TASK_TIMEOUT };
  try {
    delete process.env.VECTRA_MODEL_TIMEOUT; delete process.env.VECTRA_TASK_TIMEOUT;
    expect(runtimeConfig()).toMatchObject({ modelTimeout: 120_000, taskTimeout: 600_000 });
    expect(DEFAULT_MODEL_TIMEOUT_MS).toBe(120_000); expect(DEFAULT_TASK_TIMEOUT_MS).toBe(600_000);
    process.env.VECTRA_MODEL_TIMEOUT = "45"; process.env.VECTRA_TASK_TIMEOUT = "300";
    expect(runtimeConfig()).toMatchObject({ modelTimeout: 45_000, taskTimeout: 300_000 });
    for (const value of ["0", "-1", "601", "1.5", "invalid", ""]) {
      process.env.VECTRA_MODEL_TIMEOUT = value;
      expect(() => runtimeConfig()).toThrow("运行配置");
    }
    process.env.VECTRA_MODEL_TIMEOUT = "120";
    for (const value of ["9", "901"]) { process.env.VECTRA_TASK_TIMEOUT = value; expect(() => runtimeConfig()).toThrow("运行配置"); }
  } finally {
    if (saved.model === undefined) delete process.env.VECTRA_MODEL_TIMEOUT; else process.env.VECTRA_MODEL_TIMEOUT = saved.model;
    if (saved.task === undefined) delete process.env.VECTRA_TASK_TIMEOUT; else process.env.VECTRA_TASK_TIMEOUT = saved.task;
  }
});

test("both API formats use the full configurable response deadline regardless of the thinking switch", async () => {
  const original = globalThis.fetch, progress: any[] = [], diagnostics: any[] = [];
  globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return Response.json(body.input ? { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "完成" }] }] } : { choices: [{ message: { role: "assistant", content: "完成" } }] });
  }, { preconnect: original.preconnect }) as typeof fetch;
  try {
    for (const apiFormat of ["chat-completions", "responses"] as const) {
      for (const deepThinking of [false, true]) {
        for (const requestTimeoutMs of [undefined, 42_000]) {
          await Effect.runPromise(runAgent({ ...model, apiFormat, deepThinking }, "说明", [], {}, step => progress.push(step), new AbortController().signal, "analyst",
            (event, detail) => diagnostics.push({ event, ...detail }), { requestTimeoutMs }));
          expect(progress.findLast(step => step.action === "模型请求" && step.status === "running").metadata.requestTimeoutMs).toBe(requestTimeoutMs ?? 120_000);
          expect(diagnostics.findLast(item => item.event === "model.request").requestTimeoutMs).toBe(requestTimeoutMs ?? 120_000);
        }
      }
    }
  } finally { globalThis.fetch = original; }
});

test("waiting for headers and stalled HTTP 200 bodies both stop as model_timeout with precise safe diagnostics", async () => {
  const original = globalThis.fetch;
  try {
    for (const apiFormat of ["chat-completions", "responses"] as const) {
      for (const headersReceived of [false, true]) {
        const diagnostics: any[] = [], progress: any[] = [];
        let requests = 0;
        globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
          requests++;
          const signal = init!.signal!;
          if (!headersReceived) return waitForAbort(signal);
          return new Response(new ReadableStream({
            start(controller) { signal.addEventListener("abort", () => controller.error(signal.reason), { once: true }); },
          }));
        }, { preconnect: original.preconnect }) as typeof fetch;
        const result = await Effect.runPromise(runAgent({ ...model, apiFormat }, "分析本轮结果", [], {}, step => progress.push(step), new AbortController().signal, "analyst",
          (event, detail) => diagnostics.push({ event, ...detail }), { requestTimeoutMs: 20 }).pipe(Effect.either));
        expect(requests).toBe(1); expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left).toMatchObject({ code: "model_timeout", status: 504 });
          expect(result.left.message).toContain("运营分析 Agent 的第 1 轮");
          expect(result.left.message).toContain("0.02 秒"); expect(result.left.message).toContain("test-model");
          expect(result.left.message).toContain(apiFormat === "responses" ? "/responses" : "/chat/completions");
          expect(result.left.message).not.toContain("凭据");
        }
        expect(diagnostics.find(item => item.event === "model.request_failed")).toMatchObject({
          agent: "analyst", round: 1, failureKind: "timeout", requestTimeoutMs: 20,
          responseStage: headersReceived ? "reading_body" : "waiting_for_headers", httpStatus: headersReceived ? 200 : null,
        });
        expect(progress.findLast(step => step.action === "模型请求")).toMatchObject({ status: "failed", metadata: { code: "model_timeout", requestTimeoutMs: 20 } });
        expect(JSON.stringify({ diagnostics, progress })).not.toContain(model.apiKey);
      }
    }
    expect(taskRecovery("model_timeout")).toContain("响应等待超时");
    expect(taskRecovery("model_timeout")).not.toContain("凭据");
    expect(taskRecovery("task_timeout")).toContain("整轮执行时限");
  } finally { globalThis.fetch = original; }
});

test("cancelling before the response deadline remains a cancellation and does not retry the provider", async () => {
  const original = globalThis.fetch, parent = new AbortController(), diagnostics: any[] = [], progress: any[] = [];
  let requests = 0;
  globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
    requests++;
    queueMicrotask(() => parent.abort());
    return waitForAbort(init!.signal!);
  }, { preconnect: original.preconnect }) as typeof fetch;
  try {
    const result = await Effect.runPromise(runAgent(model, "说明", [], {}, step => progress.push(step), parent.signal, "coordinator",
      (event, detail) => diagnostics.push({ event, ...detail }), { requestTimeoutMs: 1000 }).pipe(Effect.either));
    expect(requests).toBe(1); expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toMatchObject({ code: "cancelled", status: 409 });
    expect(diagnostics.find(item => item.event === "model.request_failed").failureKind).toBe("cancelled");
    expect(progress.findLast(step => step.action === "模型请求").status).toBe("cancelled");
  } finally { globalThis.fetch = original; }
});
