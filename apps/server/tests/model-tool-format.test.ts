import { expect, test } from "bun:test";
import { Effect } from "effect";
import { error } from "@vectra/shared";
import { runAgent, emptyArgs, emptyParameters, type ModelConfig } from "../src/model";
import { explainStep } from "../../web/src/step-explanations";

const config: ModelConfig = { mode: "llm", provider: "custom", baseUrl: "https://example.invalid/v1", model: "test", apiKey: "model-key" };
const broken = '{"facts":["真实统计已返回"]</fact_chain_placeholder><｜｜DSML｜｜ parameter name="recommendations" string="false">[]</parameter>}';
type Call = { id: string; name: string; arguments: string };
function reply(responses: boolean, calls: Call[] = [], text = "") {
  return Response.json(responses ? { status: "completed", output: calls.length
    ? calls.map(call => ({ type: "function_call", id: "item-" + call.id, call_id: call.id, name: call.name, arguments: call.arguments }))
    : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] }
    : { choices: [{ message: { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}) } }] });
}

test("both API formats reject an entire malformed batch, return matching errors and execute corrected tools once", async () => {
  const original = globalThis.fetch;
  try {
    for (const responses of [false, true]) {
      let requests = 0, executed = 0;
      const progress: any[] = [], diagnostics: any[] = [];
      globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
        requests++;
        const body = JSON.parse(String(init?.body)), history = responses ? body.input : body.messages;
        if (requests === 1) return reply(responses, [
          { id: "valid-but-not-executed", name: "identity_status", arguments: "{}" },
          { id: "malformed", name: "get_park_overview", arguments: broken },
        ]);
        if (requests === 2) {
          expect(executed).toBe(0);
          const outputs = history.filter((item: any) => responses ? item.type === "function_call_output" : item.role === "tool");
          expect(outputs.map((item: any) => responses ? item.call_id : item.tool_call_id)).toEqual(["valid-but-not-executed", "malformed"]);
          expect(outputs.map((item: any) => JSON.parse(responses ? item.output : item.content))).toMatchObject([
            { executed: false, error: { code: "tool_batch_not_executed" } },
            { executed: false, error: { code: "invalid_tool" }, tool: "get_park_overview" },
          ]);
          expect(JSON.stringify(history)).toContain("DSML");
          return reply(responses, [
            { id: "corrected-identity", name: "identity_status", arguments: "{}" },
            { id: "corrected-overview", name: "get_park_overview", arguments: "{}" },
          ]);
        }
        expect(requests).toBe(3); expect(executed).toBe(2);
        return reply(responses, [], "已取得真实公开结果。");
      }, { preconnect: original.preconnect }) as typeof fetch;
      const tool = { description: "公开查询", parameters: emptyParameters, execute: async (args: unknown) => { emptyArgs(args); executed++; return { verified: true }; } };
      const result = await Effect.runPromise(runAgent({ ...config, apiFormat: responses ? "responses" : "chat-completions" }, "查询", [], { identity_status: tool, get_park_overview: tool },
        step => progress.push(step), new AbortController().signal, "coordinator", (event, detail) => diagnostics.push({ event, ...detail })));
      expect(result).toBe("已取得真实公开结果。");
      expect(progress.filter(step => step.action === "校验服务请求格式").map(step => step.status)).toEqual(["failed", "completed"]);
      const retryStep = progress.find(step => step.action === "校验服务请求格式" && step.status === "failed");
      expect(explainStep(retryStep).next).toContain("无需在此时重复发送");
      expect(diagnostics.filter(item => item.event === "model.tool_arguments_invalid")).toHaveLength(1);
      expect(diagnostics.filter(item => item.event === "model.tool_arguments_corrected")).toHaveLength(1);
      expect(JSON.stringify(diagnostics)).not.toContain(broken); expect(JSON.stringify(diagnostics)).not.toContain("DSML");
    }
  } finally { globalThis.fetch = original; }
});

test("a second malformed submission stops with the actual Agent and service, without executing or leaking parser excerpts", async () => {
  const original = globalThis.fetch, diagnostics: any[] = [];
  let requests = 0, executed = 0;
  globalThis.fetch = Object.assign(async () => { requests++; return reply(true, [{ id: "bad-" + requests, name: "submit_analysis", arguments: broken + "private-argument-sentinel" }]); }, { preconnect: original.preconnect }) as typeof fetch;
  try {
    const result = await Effect.runPromise(runAgent({ ...config, apiFormat: "responses" }, "提交本轮分析", [], {
      submit_analysis: { description: "分析", parameters: { type: "object" }, execute: async () => { executed++; return {}; } },
    }, () => {}, new AbortController().signal, "analyst", (event, detail) => diagnostics.push({ event, ...detail })).pipe(Effect.either));
    expect(requests).toBe(2); expect(executed).toBe(0); expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.code).toBe("invalid_tool"); expect(result.left.message).toContain("运营分析 Agent");
      expect(result.left.message).toContain("提交分析结论"); expect(result.left.message).toContain("一次更正后");
      expect(result.left.message).not.toContain("private-argument-sentinel");
    }
    expect(diagnostics.filter(item => item.event === "model.tool_arguments_invalid").map(item => item.retryScheduled)).toEqual([true, false]);
    expect(JSON.stringify(diagnostics)).not.toContain("private-argument-sentinel");
  } finally { globalThis.fetch = original; }
});

test("format correction cannot switch tools or replace the required resubmission with prose", async () => {
  const original = globalThis.fetch;
  try {
    for (const switchTool of [true, false]) {
      let requests = 0, executed = 0;
      globalThis.fetch = Object.assign(async () => {
        requests++;
        if (requests === 1) return reply(false, [{ id: "bad", name: "identity_status", arguments: broken }]);
        return switchTool ? reply(false, [{ id: "switched", name: "get_park_overview", arguments: "{}" }]) : reply(false, [], "请求已完成");
      }, { preconnect: original.preconnect }) as typeof fetch;
      const tool = { description: "公开查询", parameters: emptyParameters, execute: async () => { executed++; return {}; } };
      const result = await Effect.runPromise(runAgent(config, "查询", [], { identity_status: tool, get_park_overview: tool }, () => {}, new AbortController().signal).pipe(Effect.either));
      expect(requests).toBe(2); expect(executed).toBe(0); expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left.code).toBe("invalid_tool");
    }
  } finally { globalThis.fetch = original; }
});

test("forbidden siblings and valid JSON that fails business validation are rejected without format retries", async () => {
  const original = globalThis.fetch;
  try {
    for (const forbidden of [true, false]) {
      let requests = 0, executed = 0;
      globalThis.fetch = Object.assign(async () => {
        requests++;
        return reply(false, forbidden
          ? [{ id: "allowed", name: "identity_status", arguments: "{}" }, { id: "forbidden", name: "toString", arguments: "{}" }]
          : [{ id: "business-invalid", name: "identity_status", arguments: '{"expandedScope":true}' }]);
      }, { preconnect: original.preconnect }) as typeof fetch;
      const result = await Effect.runPromise(runAgent(config, "查询", [], {
        identity_status: { description: "公开身份", parameters: emptyParameters, execute: async args => { emptyArgs(args); executed++; throw error("unexpected_execution", "不得执行", 500); } },
      }, () => {}, new AbortController().signal).pipe(Effect.either));
      expect(requests).toBe(1); expect(executed).toBe(0); expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left.code).toBe(forbidden ? "tool_forbidden" : "invalid_tool_args");
    }
  } finally { globalThis.fetch = original; }
});

test("rejected argument submissions still consume the existing tool budget", async () => {
  const original = globalThis.fetch;
  let requests = 0, executed = 0;
  globalThis.fetch = Object.assign(async () => { requests++; return reply(true, [{ id: "call-" + requests, name: "identity_status", arguments: requests === 6 ? broken : "{}" }]); }, { preconnect: original.preconnect }) as typeof fetch;
  try {
    const result = await Effect.runPromise(runAgent({ ...config, apiFormat: "responses" }, "查询", [], {
      identity_status: { description: "公开身份", parameters: emptyParameters, execute: async () => { executed++; return {}; } },
    }, () => {}, new AbortController().signal).pipe(Effect.either));
    expect(requests).toBe(6); expect(executed).toBe(5); expect(result._tag).toBe("Left");
    if (result._tag === "Left") { expect(result.left.code).toBe("invalid_tool"); expect(result.left.message).toContain("预算不足"); }
  } finally { globalThis.fetch = original; }
});
