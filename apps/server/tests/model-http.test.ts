import { expect, test } from "bun:test";
import { Effect } from "effect";
import { emptyParameters, runAgent, type ModelConfig } from "../src/model";
import { readModelHttpError } from "../src/model-http";
import { taskRecovery, explainStep } from "../../web/src/step-explanations";
import { userFacingError } from "../../web/src/conversation";
import type { Step } from "@vectra/shared";

const model: ModelConfig = { mode: "llm", provider: "custom", baseUrl: "https://example.invalid/v1", model: "http-test-model", apiKey: "private-model-http-key" };
const complete = (responses: boolean) => Response.json(responses
  ? { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "核对完成。" }] }] }
  : { choices: [{ message: { role: "assistant", content: "核对完成。" } }] });
const unavailable = (status = 500, retryAfter = "0") => Response.json({ error: {
  code: "InternalServiceError", type: "InternalServerError", message: "provider-message-must-stay-private " + model.apiKey,
  request_id: "body-request-id", private_field: "provider-private-field",
} }, { status, headers: { "x-request-id": "provider-request-id", "retry-after": retryAfter } });

test("both formats retry only the failed model round and execute an already completed tool once", async () => {
  const original = globalThis.fetch;
  try {
    for (const apiFormat of ["chat-completions", "responses"] as const) {
      const bodies: string[] = [], progress: any[] = [], diagnostics: any[] = [];
      let executed = 0;
      const responses = apiFormat === "responses";
      globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        if (bodies.length === 1) return Response.json(responses
          ? { status: "completed", output: [{ type: "function_call", id: "item-1", call_id: "call-1", name: "identity_status", arguments: "{}" }] }
          : { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "identity_status", arguments: "{}" } }] } }] });
        return bodies.length === 2 ? unavailable() : complete(responses);
      }, { preconnect: original.preconnect }) as typeof fetch;
      const result = await Effect.runPromise(runAgent({ ...model, apiFormat }, "查询身份", [], {
        identity_status: { description: "核对登记身份", parameters: emptyParameters, execute: async () => { executed++; return { verified: true }; } },
      }, step => progress.push(step), new AbortController().signal, "coordinator", (event, detail) => diagnostics.push({ event, ...detail })));
      expect(result).toBe("核对完成。"); expect(executed).toBe(1); expect(bodies).toHaveLength(3);
      expect(bodies[1]).toBe(bodies[2]);
      expect(diagnostics.filter(row => row.event === "model.http_response").map(row => [row.round, row.attempt, row.status])).toEqual([[1, 1, 200], [2, 1, 500], [2, 2, 200]]);
      expect(diagnostics.find(row => row.event === "model.retry_scheduled")).toMatchObject({ round: 2, providerCode: "InternalServiceError", providerRequestId: "provider-request-id" });
      expect(progress.findLast(step => step.action === "模型请求")).toMatchObject({ status: "completed", metadata: { attempts: 2, httpStatus: 200, retryScheduled: false } });
      expect(explainStep(progress.find(step => step.metadata?.retryScheduled === true) as Step).current).toContain("本轮模型请求");
      const visible = JSON.stringify({ progress, diagnostics });
      for (const hidden of [model.apiKey, "provider-message-must-stay-private", "provider-private-field"]) expect(visible).not.toContain(hidden);
    }
  } finally { globalThis.fetch = original; }
});

test("persistent provider failures stop after three attempts with safe identifiers and status-specific recovery", async () => {
  const original = globalThis.fetch, diagnostics: any[] = [], progress: any[] = [];
  let requests = 0;
  globalThis.fetch = Object.assign(async () => { requests++; return unavailable(); }, { preconnect: original.preconnect }) as typeof fetch;
  try {
    const result = await Effect.runPromise(runAgent(model, "说明", [], {}, step => progress.push(step), new AbortController().signal, "analyst",
      (event, detail) => diagnostics.push({ event, ...detail })).pipe(Effect.either));
    expect(requests).toBe(3); expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({ code: "model_service_error", status: 502 });
      for (const text of ["运营分析 Agent", "HTTP 500", "已尝试 3 次", "InternalServiceError", "provider-request-id"]) expect(result.left.message).toContain(text);
      expect(result.left.message).not.toContain("请检查接口格式、地址、模型能力和凭据");
    }
    expect(diagnostics.filter(row => row.event === "model.retry_scheduled")).toHaveLength(2);
    expect(diagnostics.find(row => row.event === "model.request_failed")).toMatchObject({ attempts: 3, httpStatus: 500, providerCode: "InternalServiceError", providerRequestId: "provider-request-id" });
    expect(progress.at(-1)).toMatchObject({ status: "failed", metadata: { attempts: 3, retryScheduled: false } });
    expect(taskRecovery("model_service_error")).toContain("服务商请求编号");
    expect(taskRecovery("model_unavailable", "模型服务返回 HTTP 500。")).toContain("服务商本次未能完成请求");
    expect(taskRecovery("model_unavailable", "模型服务返回 HTTP 401。")).toContain("底层模型");
    expect(userFacingError("模型服务返回 HTTP 500。请检查接口格式、地址、模型能力和凭据。")).toContain("模型服务商暂时无法完成请求");
  } finally { globalThis.fetch = original; }
});

test("authorization, invalid parameters, rate limits, unsupported operations and long server backoffs are not retried", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [400, 401, 403, 404, 422, 429, 501, 503]) {
      let requests = 0;
      globalThis.fetch = Object.assign(async () => { requests++; return unavailable(status, status === 503 ? "60" : "0"); }, { preconnect: original.preconnect }) as typeof fetch;
      const result = await Effect.runPromise(runAgent(model, "说明", [], {}, () => {}, new AbortController().signal).pipe(Effect.either));
      expect(requests).toBe(1); expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left.code).toBe(status >= 500 ? "model_service_error" : "model_unavailable");
    }
  } finally { globalThis.fetch = original; }
});

test("error bodies are bounded, never published verbatim and cannot smuggle credentials into identifiers", async () => {
  let cancelled = false;
  const oversized = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("private-raw-body".repeat(2000))); },
    cancel() { cancelled = true; },
  }), { status: 500, headers: { "x-request-id": "bounded-request-id" } });
  const bounded = await readModelHttpError(oversized, model.apiKey);
  expect(cancelled).toBe(true); expect(bounded.details).toEqual({ providerRequestId: "bounded-request-id" });
  const malicious = await readModelHttpError(Response.json({ error: { code: model.apiKey, type: "safe-type", param: "messages[0].content", message: "private-echo", request_id: "body-id" } },
    { status: 400, headers: { "x-request-id": "Bearer " + model.apiKey } }), model.apiKey);
  expect(malicious.details).toEqual({ providerType: "safe-type", providerParam: "messages[0].content", providerRequestId: "body-id" });
  const plain = await readModelHttpError(new Response("private-plain-error", { status: 502 }), model.apiKey);
  expect(plain.details).toEqual({});
});

test("cancellation and the original response deadline stop retry waits and stalled error bodies", async () => {
  const original = globalThis.fetch;
  try {
    for (const mode of ["cancel", "retry-timeout", "body-timeout"] as const) {
      const parent = new AbortController(), diagnostics: any[] = [], progress: any[] = [];
      let requests = 0;
      globalThis.fetch = Object.assign(async () => {
        requests++;
        return mode === "body-timeout" ? new Response(new ReadableStream({ start() {} }), { status: 500 }) : unavailable(503, "1");
      }, { preconnect: original.preconnect }) as typeof fetch;
      const result = await Effect.runPromise(runAgent(model, "说明", [], {}, step => progress.push(step), parent.signal, "coordinator",
        (event, detail) => { diagnostics.push({ event, ...detail }); if (mode === "cancel" && event === "model.retry_scheduled") parent.abort(); },
        { requestTimeoutMs: 20 }).pipe(Effect.either));
      expect(requests).toBe(1); expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left.code).toBe(mode === "cancel" ? "cancelled" : "model_timeout");
      expect(progress.at(-1).metadata.retryScheduled).toBe(false);
      expect(diagnostics.find(row => row.event === "model.request_failed").responseStage).toBe(mode === "body-timeout" ? "reading_error_body" : "waiting_to_retry");
    }
  } finally { globalThis.fetch = original; }
});
