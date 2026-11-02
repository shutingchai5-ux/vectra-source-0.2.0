import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_DEFINITIONS, AGENT_TOOL_CATALOG, LLM_AGENT_IDS, ROLE_NAMES, error, asError, type AgentDetail, type AgentModelSettings, type AgentRun, type LlmAgentId, type Task, type JsonObject } from "@vectra/shared";
import { ModelSettings, type ModelConfig } from "./model";
import { AgentMemoryStore } from "./agent-memory";
import { canonical, hash, seal, unseal, type Security } from "./security";
import type { Store } from "./store";
import type { Trace } from "./transport";

export type AgentModelSnapshots = Record<LlmAgentId, ModelConfig>;
export class AgentRuntime {
  readonly memory: AgentMemoryStore;
  private children: Record<"planner" | "analyst", ModelSettings>;
  constructor(private root: string, private security: Security, private store: Store, readonly primary: ModelSettings) {
    this.children = { planner: this.childSettings("planner"), analyst: this.childSettings("analyst") };
    this.memory = new AgentMemoryStore(store.db, security);
    store.db.exec(`CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,task_id TEXT NOT NULL,conversation_id TEXT NOT NULL,status TEXT NOT NULL,started_at INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_runs_agent ON agent_runs(agent_id,started_at);
      CREATE INDEX IF NOT EXISTS agent_runs_conversation ON agent_runs(conversation_id);`);
    for (const row of store.db.query<{ id: string; body: string }, []>("SELECT id,body FROM agent_runs WHERE status='running'").all()) {
      const value = this.decodeRun(row); this.saveRun({ ...value, status: "failed", finishedAt: Date.now(), errorCode: "service_restarted" });
    }
  }
  private childSettings(id: "planner" | "analyst") { return new ModelSettings(join(this.root, "agents", id), this.security, "agent-model:" + id, { mode: "llm", provider: "custom", baseUrl: "https://api.openai.com/v1", model: "", apiKey: "", deepThinking: false, thinkingProtocol: "auto", apiFormat: "chat-completions" }); }
  models(): AgentModelSnapshots { return Object.fromEntries(LLM_AGENT_IDS.map(id => [id, (id === "coordinator" ? this.primary : this.children[id]).snapshot()])) as AgentModelSnapshots; }
  model(id: LlmAgentId): AgentModelSettings {
    return { ...(id === "coordinator" ? this.primary : this.children[id]).public(), agentId: id, inherited: false, sourceAgentId: id };
  }
  configureModel(id: LlmAgentId, input: unknown) {
    if (input && typeof input === "object" && !Array.isArray(input) && "inherit" in input) {
      throw error("invalid_agent_model", "每个子智能体需要单独填写并保存 LLM 配置，不能沿用主智能体配置。", 422);
    }
    (id === "coordinator" ? this.primary : this.children[id]).save(input);
    return this.model(id);
  }
  requireModels(intent: Task["plan"]["intent"], models: AgentModelSnapshots) {
    const required: LlmAgentId[] = intent === "statistics" ? [...LLM_AGENT_IDS] : intent === "investigation" ? ["coordinator", "analyst"] : ["coordinator"];
    const missing = required.filter(id => (id !== "coordinator" && !this.children[id].public().saved) || !models[id].model.trim() || !models[id].apiKey.trim());
    if (missing.length) throw error("agent_model_not_configured", missing.map(id => ROLE_NAMES[id]).join("、") + "尚未配置可用模型，请分别进入 Agent 详情的底层模型，填写并保存各自的配置。", 409);
  }
  private decodeRun(row: { id: string; body: string }) { return unseal(JSON.parse(row.body), this.security.storageKey(), "agent-run:" + row.id) as AgentRun; }
  private saveRun(run: AgentRun) { this.store.db.query("INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body").run(run.id, run.agentId, run.taskId, run.conversationId, run.status, run.startedAt, canonical(seal(run, this.security.storageKey(), "agent-run:" + run.id))); }
  private runs(id: LlmAgentId) { return this.store.db.query<{ id: string; body: string }, [string]>("SELECT id,body FROM agent_runs WHERE agent_id=? ORDER BY started_at DESC LIMIT 30").all(id).map(row => this.decodeRun(row)); }
  detail(id: LlmAgentId): AgentDetail {
    const definition = AGENT_DEFINITIONS[id], rows = this.store.db.query<{ status: string; n: number }, [string]>("SELECT status,COUNT(*) n FROM agent_runs WHERE agent_id=? GROUP BY status").all(id), n = (status: string) => rows.find(row => row.status === status)?.n ?? 0;
    return { identity: this.security.validateNode(id), definition, model: this.model(id), tools: definition.tools.map(name => ({ name, ...AGENT_TOOL_CATALOG[name] })), ...(id === "coordinator" ? { memory: { total: this.memory.list().total, settings: this.memory.settings() } } : {}), runs: this.runs(id), stats: { total: rows.reduce((sum, row) => sum + row.n, 0), completed: n("completed"), failed: n("failed") + n("cancelled"), running: n("running") }, allowedIntents: id === "planner" ? ["statistics"] : id === "analyst" ? ["statistics", "investigation"] : ["statistics", "investigation", "verification", "explain"] };
  }
  list() { return LLM_AGENT_IDS.map(id => this.detail(id)); }
  clearConversationRuns(id: string) { this.store.db.query("DELETE FROM agent_runs WHERE conversation_id=?").run(id); }
  async execute<T>(task: Task, agent: LlmAgentId, config: ModelConfig, purpose: string, input: JsonObject, trace: Trace, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const id = randomUUID(), startedAt = Date.now(), child = agent !== "coordinator", parentAgentId = child ? "coordinator" as const : undefined;
    const record: AgentRun = { id, taskId: task.id, conversationId: task.conversationId, agentId: agent, ...(parentAgentId ? { parentAgentId } : {}), purpose, status: "running", startedAt, model: config.model, provider: config.provider };
    this.saveRun(record);
    const phase = agent === "planner" ? 2 : agent === "analyst" ? 7 : undefined;
    try {
    const signed = child ? this.security.sign("coordinator", { type: "agent-delegation-v1", delegationId: id, taskId: task.id, recipient: agent, requestDigest: hash(task.request), inputDigest: hash(input), purpose, createdAt: startedAt }) : undefined;
    if (signed) {
      const verified = this.security.verify(signed, "coordinator");
      if (verified.recipient !== agent || verified.taskId !== task.id || verified.inputDigest !== hash(input)) throw error("delegation_invalid", "子智能体委派的任务或输入绑定不一致。", 403);
      trace({ agent: "coordinator", sender: "coordinator", recipient: agent, kind: "exchange", phase, action: "委派子智能体任务", detail: `将${purpose}交给${ROLE_NAMES[agent]}。子智能体使用本轮锁定的模型 ${config.model}，只能调用登记工具，完成后交回可核对的产物。`, protocol: "Ed25519 / JSON", metadata: { delegationId: id, model: config.model }, protocolDetails: { objective: "明确任务责任、输入范围和交付要求。", operations: ["主智能体签署委派消息。", "核对接收身份、任务编号和输入摘要。", "在独立上下文中调用子智能体配置的模型。"], sections: [{ title: "实际签名委派", data: signed }, { title: "委派上下文", data: input }] } });
    }
      if (signal.aborted) throw error("cancelled", "任务已取消。", 409);
      const result = await run(); if (signal.aborted) throw error("cancelled", "任务已取消，未接纳子智能体结果。", 409);
      const resultDigest = hash(result), receipt = child ? this.security.sign(agent, { type: "agent-result-v1", delegationId: id, taskId: task.id, inputDigest: hash(input), resultDigest, completedAt: Date.now() }) : undefined;
      if (receipt) {
        const verified = this.security.verify(receipt, agent); if (verified.resultDigest !== hash(result) || verified.delegationId !== id) throw error("delegation_invalid", "子智能体产物的签名或任务绑定不一致。", 403);
        trace({ agent, sender: agent, recipient: "coordinator", kind: "exchange", phase, action: "子智能体交回产物", detail: `${ROLE_NAMES[agent]}已完成${purpose}，主智能体已核对产物签名、委派编号和输入绑定，继续执行本轮任务。`, protocol: "Ed25519 / JSON", metadata: { delegationId: id }, protocolDetails: { objective: "把子智能体实际产物与本次委派对应起来。", operations: ["子智能体对产物摘要和委派编号签名。", "主智能体验签并核对任务与输入绑定。", "接纳通过结构及范围校验的实际产物。"], sections: [{ title: "签名产物回执", data: receipt }, { title: "实际返回产物", data: result }], checks: [{ name: "子智能体签名与任务绑定", status: "passed" }] } });
      }
      this.saveRun({ ...record, status: "completed", finishedAt: Date.now(), resultDigest }); return result;
    } catch (cause) { const failure = asError(cause); this.saveRun({ ...record, status: signal.aborted ? "cancelled" : "failed", finishedAt: Date.now(), errorCode: failure.code }); if (child) trace({ agent, recipient: "coordinator", phase, kind: "exchange", action: "子智能体任务未完成", status: signal.aborted ? "cancelled" : "failed", detail: "本次委派未产生可接纳的产物：" + failure.message, metadata: { delegationId: id } }); throw cause; }
  }
}
