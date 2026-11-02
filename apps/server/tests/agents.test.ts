import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { LLM_AGENT_IDS, type AgentDetail, type Task } from "@vectra/shared";
import { Security, atomicWrite, canonical } from "../src/security";
import { Store } from "../src/store";
import { AgentMemoryStore } from "../src/agent-memory";
import { runAgent } from "../src/model";
import { config } from "../src/config";
import { startServer } from "../src/index";
import { fixtureVisits } from "./fixtures";
const cleanup = (root: string, prefix: string) => { if (!resolve(root).startsWith(resolve(tmpdir(), prefix))) throw new Error("Unexpected test path"); rmSync(root, { recursive: true, force: true }); };
const memory = (title = "东入口分析偏好") => ({ title, content: "优先解释东入口排队和有效车次数。", category: "preference", tags: ["东入口"], enabled: true, pinned: true });

test("agent upgrade adds child identities while retaining existing CA, keys and signatures", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-agent-identities-"));
  try {
    const first = await Security.open(root), before = first.sign("report", { note: "previous signature" }), ca = first.ca(), old = first.nodes().filter(node => !["planner", "analyst"].includes(node.id));
    const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8")); delete registry.nodes.planner; delete registry.nodes.analyst; atomicWrite(join(root, "registry.json"), canonical(registry));
    const upgraded = await Security.open(root); expect(upgraded.nodes().filter(node => node.usesLlm).map(node => node.id)).toEqual([...LLM_AGENT_IDS]); expect(upgraded.ca()).toBe(ca); expect(upgraded.verify(before, "report")).toEqual(before.payload);
    for (const node of old) expect(upgraded.validateNode(node.id)).toEqual(node);
    expect(upgraded.verify(upgraded.sign("planner", { task: "new" }), "planner")).toEqual({ task: "new" });
  } finally { cleanup(root, "vectra-agent-identities-"); }
});

test("primary memory is encrypted, durable, scoped, revisioned and excludes disabled or expired entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-agent-memory-")); let store: Store | undefined;
  try {
    const security = await Security.open(join(root, "pki")); store = new Store(root); let memories = new AgentMemoryStore(store.db, security);
    const one = memories.save(memory()); expect(memories.context("分析东入口排队")[0].id).toBe(one.id); expect(memories.get(one.id).usedCount).toBe(1);
    expect(JSON.stringify(store.db.query("SELECT body FROM agent_memories").all())).not.toContain("优先解释东入口");
    const paused = memories.save({ ...memory(), enabled: false, revision: one.revision }, one.id); expect(memories.recall("东入口")).toEqual([]);
    expect(() => memories.save({ ...memory(), revision: one.revision }, one.id)).toThrow(/已更新/);
    memories.save({ ...memory(), expiresAt: Date.now() - 1000, revision: paused.revision }, one.id); expect(memories.recall("东入口")).toEqual([]);
    const fromTask = memories.save(memory("来源记忆"), undefined, "user_request", { id: "task", conversationId: "conversation" }); memories.remove(fromTask.id, fromTask.revision); expect(() => memories.get(fromTask.id)).toThrow();
    store.close(); store = new Store(root); memories = new AgentMemoryStore(store.db, security); expect(memories.list().total).toBe(1);
    memories.configure({ enabled: false, autoCapture: false, maxRecall: 2 }); expect(memories.context("东入口")).toEqual([]);
    expect(() => memories.save({ ...memory(), content: "私钥: abcdefghijklmnop" })).toThrow(/凭据/);
    const forbidden = await Effect.runPromise(runAgent({ mode: "llm", provider: "custom", model: "test", baseUrl: "https://example.invalid", apiKey: "test" }, "记住", [], { remember_memory: { description: "forbidden", parameters: {}, execute: async () => ({}) } }, () => {}, new AbortController().signal, "planner").pipe(Effect.either));
    expect(forbidden._tag).toBe("Left"); if (forbidden._tag === "Left") expect(forbidden.left.code).toBe("tool_forbidden");
  } finally { store?.close(); cleanup(root, "vectra-agent-memory-"); }
});

test("main agent delegates to separately configured models, verifies signed results and owns all durable memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-agents-api-")), original = globalThis.fetch;
  const options = { ...config(), dataDir: root, logDir: join(root, "logs"), port: 0, cooldown: 0, mpcTimeout: 25000, modelTimeout: 42_000 };
  let live = await startServer(options), base = "http://127.0.0.1:" + live.server.port;
  const seen: Array<{ model: string; names: string[]; memory: boolean; format: string }> = [];
  try {
    expect((await original(base + "/api/agents")).status).toBe(401);
    const cookie = (await original(base + "/api/session")).headers.get("set-cookie")!.split(";")[0];
    const send = (path: string, method = "GET", value?: unknown, headers = {}) => original(base + path, { method, headers: { Cookie: cookie, "Content-Type": "application/json", ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    expect((await send("/api/agents/coordinator/model-settings", "PUT", { provider: "custom", baseUrl: "https://example.invalid/v1", model: "coordinator-model", apiKey: "coordinator-secret-key" })).status).toBe(200);
    for (const id of ["planner", "analyst"] as const) {
      const model = await (await send("/api/agents/" + id + "/model-settings")).json();
      expect(model).toMatchObject({ agentId: id, sourceAgentId: id, inherited: false, saved: false, ready: false, hasApiKey: false, model: "" });
      expect(live.app.agents.models()[id].apiKey).toBe("");
    }
    const missing = await send("/api/tasks", "POST", { request: "统计东入口平均排队时长", requestId: randomUUID(), intent: "statistics" });
    expect(missing.status).toBe(409); const failure = await missing.json(); expect(failure.code).toBe("agent_model_not_configured"); expect(failure.message).toContain("统计规划 Agent"); expect(failure.message).toContain("运营分析 Agent"); expect(live.app.store.tasks()).toHaveLength(0);
    expect((await send("/api/agents/planner/model-settings", "PUT", { inherit: true })).status).toBe(422);
    const ownKeyRequired = await (await send("/api/agents/planner/model-settings", "PUT", { provider: "custom", baseUrl: "https://example.invalid/v1", model: "planner-model" })).json();
    expect(ownKeyRequired).toMatchObject({ saved: true, ready: false, hasApiKey: false }); expect(live.app.agents.models().planner.apiKey).toBe("");
    for (const id of LLM_AGENT_IDS) { const response = await send("/api/agents/" + id + "/model-settings", "PUT", { provider: "custom", baseUrl: "https://example.invalid/v1", model: id + "-model", apiKey: id + "-secret-key", apiFormat: id === "planner" ? "chat-completions" : "responses" }); expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toContain("secret-key"); }
    const list = await (await send("/api/agents")).json() as AgentDetail[]; expect(list).toHaveLength(3); expect(list.filter(item => item.definition.hasLongTermMemory).map(item => item.identity.id)).toEqual(["coordinator"]); expect(list.every(item => !item.model.inherited)).toBeTrue();
    for (const item of list) expect(item.model.apiFormat).toBe(item.identity.id === "planner" ? "chat-completions" : "responses");
    expect((await send("/api/agents/planner/model-settings", "PUT", { inherit: true })).status).toBe(422); expect(live.app.agents.model("planner").ready).toBeTrue();
    expect((await send("/api/agents/planner/memories")).status).toBe(403); expect((await send("/api/agents/coordinator/memories", "GET", undefined, { Origin: "https://other.invalid" })).status).toBe(403);
    const sentinel = "memory-only-sentinel-business", savedMemory = await send("/api/agents/coordinator/memories", "POST", { ...memory(), content: sentinel + "，东入口排队优先" }); expect(savedMemory.status).toBe(201);
    live.app.park.import(fixtureVisits(), live.app.park.catalog().version);
    const now = Date.now(), query = { dataset: "park_visits", cohort: "arrivals", roads: ["东入口"], start: now - 86400000, end: now - 1000, timeZone: "Asia/Shanghai", metrics: [{ label: "平均排队", operation: "mean", field: "queueMinutes" }] };
    let changed = false, analysisSubmissions = 0, computationRequests = 0, evidenceRequests = 0;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!String(input).startsWith("https://example.invalid/")) return original(input, init);
      const payload = JSON.parse(String(init?.body)), responses = Array.isArray(payload.input), history = responses ? payload.input : payload.messages, names = payload.tools.map((tool: any) => responses ? tool.name : tool.function.name), lastItem = history.at(-1), last = lastItem.type === "function_call_output" ? { role: "tool", content: lastItem.output } : lastItem;
      seen.push({ model: payload.model, names, memory: JSON.stringify(history).includes(sentinel), format: responses ? "responses" : "chat-completions" });
      expect(String(input)).toEndWith(responses ? "/responses" : "/chat/completions");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer " + payload.model.replace("-model", "-secret-key"));
      const call = (name: string, args = {}, rawArguments?: string) => {
        if (name === "compute_statistics") computationRequests++;
        if (name === "query_events") evidenceRequests++;
        return Response.json(responses ? { status: "completed", output: [{ type: "function_call", id: randomUUID(), call_id: randomUUID(), name, arguments: rawArguments ?? JSON.stringify(args) }] } : { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: rawArguments ?? JSON.stringify(args) } }] } }] });
      };
      const answer = (text: string) => Response.json(responses ? { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] } : { choices: [{ message: { role: "assistant", content: text } }] });
      if (payload.model === "planner-model") { expect(names).not.toContain("search_memory"); return call("submit_statistics_plan", query); }
      if (payload.model === "analyst-model") {
        expect(names).not.toContain("compute_statistics");
        if (last.role === "user") return call("query_events");
        analysisSubmissions++;
        if (analysisSubmissions === 1) return call("submit_analysis", {}, '{"facts":["真实统计已返回"]</fact_chain_placeholder><｜｜DSML｜｜ parameter name="recommendations" string="false">[]</parameter>}');
        expect(JSON.parse(last.content)).toMatchObject({ executed: false, error: { code: "invalid_tool" }, tool: "submit_analysis" });
        const evidence = history.filter((item: any) => item.type === "function_call_output").map((item: any) => JSON.parse(item.output)).find((result: any) => Array.isArray(result.events));
        return call("submit_analysis", { facts: ["真实统计已返回"], possibleCauses: [], recommendations: [], uncertainties: ["历史数据不代表实时状态"], evidenceIds: [evidence.events[0].id] });
      }
      expect(payload.model).toBe("coordinator-model");
      if (names.includes("remember_memory")) {
        if (last.role === "user") return call("remember_memory", { title: "园区分析偏好", content: "以后优先解释东入口排队时长", category: "preference", tags: ["东入口"] });
        return answer("已按你的明确要求保存记忆。");
      }
      if (!changed) { changed = true; live.app.agents.configureModel("analyst", { provider: "custom", baseUrl: "https://example.invalid/v1", model: "next-model", apiKey: "next-secret-key" }); }
      const called = (name: string) => history.some((message: any) => responses ? message.type === "function_call" && message.name === name : message.tool_calls?.some((tool: any) => tool.function.name === name));
      if (!called("delegate_statistics_planning")) return call("delegate_statistics_planning");
      if (!called("compute_statistics")) return call("compute_statistics");
      return answer("规划与运营分析子任务已返回，联合统计平均排队为40分钟。");
    }, { preconnect: original.preconnect }) as typeof fetch;
    const task = live.app.submit({ request: "统计过去24小时东入口的平均排队时长，保护输入并生成报告", requestId: randomUUID(), intent: "statistics" });
    const deadline = Date.now() + 30000; while (["running", "queued"].includes(live.app.store.task(task.id)!.status) && Date.now() < deadline) await Bun.sleep(20);
    const completed = live.app.store.task(task.id)!; expect(completed.error, JSON.stringify(completed.error)).toBeUndefined(); expect(completed.status).toBe("completed"); expect(completed.result?.groups?.[0].metrics[0].value).toBe(40);
    const admission = completed.steps.find(step => step.action === "锁定任务计划")!.protocolDetails!.sections!.find(section => section.title === "请求与执行契约")!.data as { plan: Record<string, unknown> };
    expect(admission.plan).not.toHaveProperty("road"); expect(admission.plan).not.toHaveProperty("windowSeconds");
    expect(completed.plan.road).toBe("东入口"); expect(completed.plan.statistics?.roads).toEqual(["东入口"]);
    expect({ computationRequests, evidenceRequests, analysisSubmissions }).toEqual({ computationRequests: 1, evidenceRequests: 1, analysisSubmissions: 2 });
    expect(completed.steps.filter(step => step.action === "校验服务请求格式").map(step => step.status)).toEqual(["failed", "completed"]);
    expect(completed.steps.find(step => step.action === "校验服务请求格式" && step.status === "failed")?.metadata).toMatchObject({ retryScheduled: true, errorCode: "invalid_tool" });
    const modelRequests = completed.steps.filter(step => step.action === "模型请求");
    expect(new Set(modelRequests.map(step => step.agent))).toEqual(new Set(["coordinator", "planner", "analyst"]));
    expect(modelRequests.every(step => step.metadata?.requestTimeoutMs === 42_000)).toBeTrue();
    expect(new Set(seen.map(row => row.model))).toEqual(new Set(["coordinator-model", "planner-model", "analyst-model"])); expect(seen.every(row => row.memory)).toBeTrue();
    expect(new Set(seen.map(row => row.format))).toEqual(new Set(["responses", "chat-completions"]));
    for (const id of LLM_AGENT_IDS) { const detail = live.app.agents.detail(id); expect(detail.stats.completed).toBe(1); expect(detail.runs[0].agentId).toBe(id); if (id !== "coordinator") expect(detail.runs[0].parentAgentId).toBe("coordinator"); }
    const returns = completed.steps.filter(step => step.action === "子智能体交回产物"); expect(returns).toHaveLength(2);
    for (const step of returns) { const envelope = step.protocolDetails?.sections?.find(section => section.title === "签名产物回执")?.data; expect(envelope).toBeDefined(); expect(live.app.security.verify(envelope, step.agent).taskId).toBe(task.id); }
    expect(completed.steps.filter(step => step.status === "running")).toHaveLength(0); expect(live.app.agents.memory.list().items.some(item => item.sourceTaskId === task.id)).toBeTrue();
    const logText = ["operations", "conversations"].flatMap(channel => readdirSync(join(root, "logs", channel)).filter(file => file.endsWith(".jsonl")).map(file => readFileSync(join(root, "logs", channel, file), "utf8"))).join(""); expect(logText).not.toContain(sentinel); expect(logText).not.toContain("coordinator-secret-key");
    expect(logText).toContain("model.tool_arguments_invalid"); expect(logText).toContain("model.tool_arguments_corrected");
    const remembered = live.app.submit({ request: "请记住，以后优先解释东入口排队时长", requestId: randomUUID(), intent: "explain" });
    const rememberDeadline = Date.now() + 5000; while (["running", "queued"].includes(live.app.store.task(remembered.id)!.status) && Date.now() < rememberDeadline) await Bun.sleep(10);
    expect(live.app.store.task(remembered.id)?.status).toBe("completed"); expect(live.app.agents.memory.list().items.find(item => item.sourceTaskId === remembered.id)?.source).toBe("user_request");
    await live.close(); live = await startServer(options); base = "http://127.0.0.1:" + live.server.port;
    expect(live.app.agents.detail("analyst").model.model).toBe("next-model"); expect(live.app.agents.memory.list().total).toBe(3); expect(live.app.agents.detail("planner").runs[0].status).toBe("completed");
    const memoryBeforeDeletion = live.app.agents.memory.list(), encryptedBeforeDeletion = live.app.store.db.query("SELECT * FROM agent_memories ORDER BY id").all();
    await live.app.deleteConversation(task.conversationId); expect(live.app.agents.memory.list()).toEqual(memoryBeforeDeletion); expect(live.app.agents.detail("planner").runs).toHaveLength(0);
    await live.app.deleteConversation(remembered.conversationId); expect(live.app.agents.memory.list()).toEqual(memoryBeforeDeletion);
    expect(live.app.store.db.query("SELECT * FROM agent_memories ORDER BY id").all()).toEqual(encryptedBeforeDeletion);
    expect(live.app.agents.memory.recall("东入口", false).some(item => item.sourceTaskId === remembered.id)).toBeTrue();
    await live.close(); live = await startServer(options); expect(live.app.agents.memory.list()).toEqual(memoryBeforeDeletion);
  } finally { globalThis.fetch = original; await live.close(); cleanup(root, "vectra-agents-api-"); }
});
