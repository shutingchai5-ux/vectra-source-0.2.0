import { randomUUID } from "node:crypto";
import { Effect, Cause, Exit } from "effect";
import { AppError, error, asError, PARTICIPANTS, VERSION, shanghaiTime, type StatisticsQuery, type Analysis, type AuditEvent, type CreateTask, type ConversationDeletion, type JsonObject, type Overview, type SignedEnvelope, type Task, type Verification, type ProtocolMaterials } from "@vectra/shared";
import { Audit } from "./audit";
import type { Config } from "./config";
import { emptyArgs, emptyParameters, ModelSettings, redact, runAgent, type ModelConfig, type Tool } from "./model";
import { MpcRunner } from "./mpc/runner";
import { authorizeTask, canonical, hash, Security, seal, unseal } from "./security";
import { Store } from "./store";
import { gateway, type Gateway, type Trace } from "./transport";
import { runtimeLock } from "./lock";
import { Diagnostics, type LogLevel } from "./logging";
import { identityPublic, identityPrivate, signingSections } from "./protocol";
import { Telemetry } from "./telemetry";
import { queryParameters, approveStatisticsQuery } from "./statistics";
import { resolveStepPhase, type ConversationPhase } from "@vectra/shared";

const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: run, catch: asError });
const metadataKeys = new Set(["round", "model", "toolResultCount", "toolCallId", "source", "requestDigest", "reportDigest", "mode", "road", "windowSeconds", "participantCount", "threshold", "code", "intent"]);
export class Collaboration {
  readonly audit: Audit;
  readonly settings: ModelSettings;
  readonly mpc: MpcRunner;
  readonly telemetry: Telemetry;
  private queue: { id: string; config: ModelConfig; conversationId: string }[] = [];
  private active = new Map<string, AbortController>();
  private activeConversations = new Set<string>();
  private deletingConversations = new Map<string, Promise<ConversationDeletion>>();
  private closed = false;
  private stopLogging = () => {};
  private readonly computeGate = Effect.runSync(Effect.makeSemaphore(1));
  private constructor(readonly config: Config, readonly security: Security, readonly store: Store, readonly rsu: Gateway, audit: Audit, private unlock: () => void, readonly logs: Diagnostics) {
    this.audit = audit; this.settings = new ModelSettings(config.dataDir, security);
    logs.remember(this.settings.snapshot().apiKey);
    this.stopLogging = logs.follow(store, hash(security.ca()).slice(0, 24)).unsubscribe;
    this.mpc = new MpcRunner(security, config.dataDir, config.mpcTimeout);
    this.telemetry = new Telemetry(security);
  }
  static async open(config: Config) {
    const logs = new Diagnostics(config.logDir);
    let unlock = () => {};
    let store: Store | undefined, rsu: Gateway | undefined;
    try {
      unlock = runtimeLock(config.dataDir);
      const security = await Security.open(config.dataDir + "/pki"); store = new Store(config.dataDir);
      const audit = new Audit(store, security, entry => { logs.operation(`audit.${entry.kind}`, { auditEventId: entry.id, details: entry.details,
        claimedIdentity: entry.claimedIdentity, verifiedIdentity: entry.verifiedIdentity }, /reject|failed/.test(entry.kind) ? "warn" : "info", entry.at); });
      const checked = audit.verify(); if (!checked.valid) throw error("audit_invalid", checked.reason, 500);
      rsu = await gateway(security, store, audit);
      const service = new Collaboration(config, security, store, rsu, audit, unlock, logs);
      audit.append("service_started", { version: VERSION, protocol: "Shamir m=3 t=1 / TLS 1.3" }); return service;
    } catch (cause) { logs.operation("server.initialization_failed", { error: cause }, "error"); rsu?.close(); store?.close(); unlock(); throw cause; }
  }
  overview(): Overview {
    return { version: VERSION, mode: this.settings.public().mode, conversations: this.store.conversations(), tasks: this.store.tasks(), nodes: this.security.nodes(), eventCursor: this.store.cursor(), audit: { count: this.audit.count(), lastVerification: this.audit.lastVerification } };
  }
  submit(input: CreateTask) {
    if (this.closed) throw error("service_stopping", "服务正在停止。", 503);
    if (input.conversationId && this.deletingConversations.has(input.conversationId)) throw error("conversation_deleting", "此对话正在删除，请开始新对话。", 409);
    this.settings.requireReady();
    const snapshot = this.settings.snapshot(); this.logs.remember(snapshot.apiKey);
    const result = this.store.create(input, snapshot.mode, snapshot.mode === "llm" ? snapshot.model : undefined);
    if (result.created) {
      try { this.audit.append("task_created", { taskId: result.task.id, conversationId: result.task.conversationId, intent: result.task.plan.intent }); }
      catch (cause) { this.fail(result.task.id, "audit_invalid", "审计记录写入失败，任务未进入执行。 "); throw cause; }
      this.queue.push({ id: result.task.id, config: snapshot, conversationId: result.task.conversationId }); this.drain();
    }
    return result.task;
  }
  private drain() {
    while (!this.closed && this.active.size < 2 && this.queue.length) {
      const eligible = this.queue.findIndex(job => !this.activeConversations.has(job.conversationId));
      if (eligible < 0) break;
      const [job] = this.queue.splice(eligible, 1), controller = new AbortController(); this.active.set(job.id, controller); this.activeConversations.add(job.conversationId);
      void this.execute(job.id, job.config, controller.signal).finally(() => { this.active.delete(job.id); this.activeConversations.delete(job.conversationId); this.drain(); });
    }
  }
  cancel(id: string) {
    const task = this.store.task(id); if (!task) throw error("task_missing", "任务不存在。", 404);
    if (["completed", "failed", "cancelled"].includes(task.status)) return task;
    this.queue = this.queue.filter(job => job.id !== id);
    const active = this.active.get(id);
    if (active) active.abort(); else this.fail(id, "cancelled", "任务在执行前已取消。", true);
    return this.store.task(id)!;
  }
  deleteConversation(id: string): Promise<ConversationDeletion> {
    const pending = this.deletingConversations.get(id); if (pending) return pending;
    const deletion = (async () => {
      if (this.closed) throw error("service_stopping", "服务正在停止。", 503);
      if (!this.store.conversation(id) && !this.store.conversationDeleted(id)) throw error("conversation_missing", "对话不存在。", 404);
      const ids = this.store.conversationTaskIds(id);
      // Remove queued jobs before aborting active jobs, so draining cannot start another task in this conversation.
      this.queue = this.queue.filter(job => job.conversationId !== id);
      for (const taskId of ids) {
        const task = this.store.task(taskId)!;
        if (!["queued", "running"].includes(task.status)) continue;
        const controller = this.active.get(taskId);
        if (controller) controller.abort(); else this.fail(taskId, "cancelled", "用户删除对话，排队任务已取消。", true);
      }
      while (ids.some(taskId => this.active.has(taskId))) await Bun.sleep(10);
      await Promise.all(ids.map(taskId => this.mpc.waitForTask(taskId)));
      if (this.closed) throw error("service_stopping", "服务正在停止，请稍后重新删除对话。", 503);
      const result = this.store.deleteConversation(id);
      this.logs.operation("conversation.deleted", { conversationId: id, deletedTaskCount: result.deletedTaskCount, alreadyDeleted: result.alreadyDeleted });
      return result;
    })();
    this.deletingConversations.set(id, deletion);
    void deletion.finally(() => this.deletingConversations.delete(id)).catch(() => {});
    return deletion;
  }
  private trace(id: string, key: string): Trace {
    return raw => {
      const task = this.store.task(id);
      if (!task || !["queued", "running"].includes(task.status)) return;
      const metadata: JsonObject = {};
      for (const [name, value] of Object.entries(raw.metadata ?? {})) if (metadataKeys.has(name) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) metadata[name] = typeof value === "string" ? redact(value, key).slice(0, 512) : value;
      const { privateDetails, ...publicStep } = raw;
      const stepId = raw.id || randomUUID();
      const privateBox = privateDetails ? seal(privateDetails, this.security.storageKey(), `protocol:${id}:${stepId}`) : undefined;
      // Private material is committed separately before notification; it is never a public event field.
      const recorded = task.steps.find(step => step.id === stepId);
      const recordedDetails = recorded?.protocolDetails;
      const protocolDetails = JSON.parse(redact(JSON.stringify(raw.protocolDetails ?? recordedDetails ?? { objective: raw.action, operations: [raw.detail] }), key));
      this.store.step(id, { ...publicStep, id: stepId, phase: recorded?.phase ?? raw.phase ?? resolveStepPhase(raw, task.steps), protocolDetails, detail: redact(raw.detail, key).slice(0, 30000),
        ...(privateDetails ? { hasPrivateDetails: true } : {}), ...(raw.metadata ? { metadata } : {}) }, privateBox);
    };
  }
  protocolMaterials(taskId: string, stepId: string): ProtocolMaterials {
    if (!this.store.task(taskId)) throw error("task_missing", "任务不存在。", 404);
    const box = this.store.protocolMaterials(taskId, stepId);
    if (!box) throw error("protocol_materials_missing", "该历史步骤未保存当时的实验材料，不能重建或伪造瞬时密钥与份额。", 404);
    return unseal(box, this.security.storageKey(), `protocol:${taskId}:${stepId}`) as ProtocolMaterials;
  }
  signedTask(task: Task) {
    if (!task.plan.statistics || !task.plan.datasetVersion) throw error("statistics_plan_missing", "统计方案或数据版本未获批准，不能签署任务。", 422);
    const query = task.plan.statistics;
    return this.security.sign("coordinator", { taskId: task.id, requestId: task.requestId, requestDigest: hash(task.request), road: query.roads.join("、"),
      windowSeconds: (query.end - query.start) / 1000, statistics: query, datasetVersion: task.plan.datasetVersion,
      participants: task.plan.participants, metric: "aggregate_vector_v1", createdAt: Date.now(), expiresAt: Date.now() + 90_000 });
  }
  private async prepareStatistics(task: Task, config: ModelConfig, trace: Trace, signal: AbortSignal) {
    trace = withPhase(trace, 2);
    const catalog = this.telemetry.catalog(), now = Date.now();
    if (!catalog.roads.length) throw error("dataset_missing", "尚无可统计的车辆数据，请先在车辆数据页导入带采样时间的记录。", 409);
    let query: StatisticsQuery | undefined;
    {
      const history = this.store.messages(task.conversationId).filter(m => m.taskId !== task.id).slice(-6).map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
      const response = await Effect.runPromise(runAgent(config, `将用户请求转成受控统计方案，必须调用 submit_statistics_plan；不能只给文字。用户请求：${task.request}\n当前 Unix 毫秒：${now}，上海时间：${shanghaiTime(now)}。公开数据目录：${canonical(catalog)}。\n按用户明确指定的路段、时间和指标，不得悄悄改成其他指标。缺省路段 S101、过去60秒、平均速度。所有路段表示目录全部路段，逐路段分别统计。相对时间按当前时刻，明确日期按 Asia/Shanghai。start含、end不含，最多31天。\n可组合字段 speed(km/h)、distanceKm(采样区间增量km)、energyKwh(采样区间增量kWh)；操作count样本数、vehicle_count去重车辆数、sum、mean、variance总体方差、stddev总体标准差、ratio满足filter的样本数/有该字段的样本数×100、ratio_of_sums字段总和/分母字段总和×倍率。filter用于本地比较，不向模型提供原始输入。速度波动用stddev；停车默认speed≤1；用户给阈值时严格采用；百公里能耗用energyKwh/distanceKm×100。\n不支持中位数、分位数、最值、任意公式、交通流量(缺少过车事件)、真实拥堵指数、地图或外部数据查询。无法表达时说明缺少的能力，不能编造或用其他指标替换。不要向模型索取原始记录或密钥。`, history, {
        submit_statistics_plan: { description: "提交经后端校验的路段、时间与指标；今天截止当前时刻，昨天与前天为完整自然日，明确相对时长由后端时钟确定", parameters: queryParameters, execute: async (value, _signal, parentId) => {
          const proposed = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
          try { query = approveStatisticsQuery(task.request, value, catalog, now); }
          catch (cause) {
            const publicTime = (v: unknown) => typeof v === "number" || typeof v === "string" ? v : null;
            this.logs.operation("statistics.plan_rejected", { taskId: task.id, anchor: now, timeZone: "Asia/Shanghai", submittedTime: { start: publicTime(proposed.start), end: publicTime(proposed.end), timeZone: publicTime(proposed.timeZone) }, error: asError(cause) }, "warn");
            throw cause;
          }
          trace({ agent: "安全执行层", parentId, kind: "security", action: "锁定查询时间范围", detail: `按上海时区锁定 ${shanghaiTime(query.start)} 至 ${shanghaiTime(query.end)}，时长 ${(query.end - query.start) / 1000} 秒。`,
            protocolDetails: { objective: "由服务端时钟确定明确的时间窗口，避免模型计算时间戳偏移。", operations: ["先解析明确时间语义：今天为上海零点至本次规划时刻，昨天与前天为完整历史自然日，相对时长按服务端时钟计算。", "保留明确指定的历史日期和子时段，不擅自改写为今天或整天。", "再完整校验路段、指标、时区与时间上限，冻结进入签名计划。"], sections: [{ title: "服务端时间锚点", data: { at: now, timeZone: "Asia/Shanghai" } }, { title: "批准的时间范围", data: { start: query.start, end: query.end, windowSeconds: (query.end - query.start) / 1000, resolvedByServer: query.start !== proposed.start || query.end !== proposed.end || query.timeZone !== proposed.timeZone } }] } });
          return query;
        } },
      }, trace, signal, "统计规划 Agent", this.modelDiagnostic(task.id), { stopAfterTool: "submit_statistics_plan" }), { signal });
      if (!query) throw error("statistics_plan_missing", `模型未提交可执行统计方案：${response.slice(0, 1200)}`, 422);
    }
    const plan = { ...task.plan, road: query.roads.join("、"), windowSeconds: (query.end - query.start) / 1000, statistics: query, datasetVersion: catalog.version };
    this.store.update(task.id, { plan });
    trace({ agent: "任务协调器", kind: "analysis", action: "批准统计方案", detail: `查询 ${query.roads.join("、")}，${shanghaiTime(query.start)} 至 ${shanghaiTime(query.end)}，执行 ${query.metrics.map(m => m.label).join("、")}。`, protocolDetails: { objective: "将灵活语言转换成可校验、可签名的统计契约。", operations: ["校验路段已登记、时间合法、指标及条件属于受控统计语言。", "冻结起止时间、数据快照版本和指标顺序。", "后续模型无法修改批准范围；原始车辆数据仅在节点计算。"], sections: [{ title: "统计方案", data: query }, { title: "数据来源与版本", data: { source: catalog.source, datasetVersion: catalog.version, vehicleCount: catalog.vehicleCount, sampleCount: catalog.sampleCount, note: "本地导入数据；车辆数量由数据决定，三个参与者是计算节点。目录车辆数不等于本次时间区间内的车辆数。均值按样本加权，方差为总体方差。" } }] } });
  }
  private async compute(id: string, trace: Trace, signal: AbortSignal) {
    trace = withPhase(trace, 3);
    const existing = this.store.task(id)!; if (existing.result) return existing.result;
    return Effect.runPromise(this.computeGate.withPermits(1)(attempt(async inner => {
      const current = this.store.task(id)!; if (current.result) return current.result;
      const signed = this.signedTask(current); authorizeTask(this.security, signed);
      trace({ agent: "任务协调器", action: "生成并验证签名任务", kind: "security", protocol: "RFC 8785 JCS / Ed25519", detail: "签署已批准统计计划，验证登记签署者、有效期和允许范围。",
        protocolDetails: { objective: "将本次请求与不可更改的统计任务绑定。", operations: ["对请求计算 SHA-256 摘要。", "将任务负载按 JCS 规范序列化。", "用 coordinator 的 Ed25519 私钥签名，再用登记公钥验证。", "核对路段、起止时间、组合指标、数据版本及三方参与者。"],
          checks: [{ name: "任务签名与策略", status: "passed", actual: "authorizeTask 已通过" }], sections: signingSections(this.security, signed) }, privateDetails: { sections: identityPrivate(this.security, "coordinator") } });
      this.store.reserveBudget(this.config.cooldown);
      trace({ agent: "安全执行层", action: "预留隐私查询预算", kind: "security", detail: "在 SQLite 事务中检查冷却间隔并预留本次查询；随后才允许启动节点协议。", metadata: { participantCount: 3, threshold: 1 },
        protocolDetails: { objective: "限制高频重复统计。", operations: ["串行获取 MPC 执行许可。", "检查持久化查询冷却时间并写入预算。"], sections: [{ title: "本次策略", data: { cooldownSeconds: this.config.cooldown, statistics: current.plan.statistics, participants: PARTICIPANTS, degree: 1, reconstruction: "实现要求三个聚合份额全部到齐" } }], checks: [{ name: "预算预留", status: "passed" }] } });
      await this.rsu.authorize(signed, trace, inner);
      const event = this.audit.append("mpc_started", { taskId: id });
      const stepId = randomUUID();
      trace({ id: stepId, phase: 4, agent: "隐私计算执行器", kind: "mpc", action: "三方秘密分享计算", status: "running", detail: "启动三个独立 Bun 进程；各节点读取自己的车辆快照并建立双向 TLS 连接。", evidenceIds: [event.id] });
      const result = await this.mpc.run(signed, withParent(trace, stepId), inner);
      result.source = this.telemetry.catalog().version === result.datasetVersion ? this.telemetry.catalog().source : "已冻结的数据快照";
      const completed = this.audit.append("statistics_completed", { taskId: id, road: result.road, datasetVersion: result.datasetVersion, groups: result.groups, participantCount: 3 });
      this.store.update(id, { result });
      trace({ id: stepId, agent: "隐私计算执行器", kind: "mpc", action: "三方秘密分享计算", status: "completed", detail: `真实三方协议完成，已生成 ${result.groups?.length} 个路段的批准指标结果。下方逐条展示各节点的真实交互与本机实验材料。`, evidenceIds: [completed.id],
        protocolDetails: { objective: "汇总三个独立节点的真实计算结果。", operations: ["三个工作进程完成输入解密、秘密分享、认证收发、本地聚合及重构。", "协调端验证 vehicle-a 的输出签名和任务绑定。", "持久化批准聚合结果与审计证据。"], sections: [{ title: "批准输出", data: result }] } });
      return result;
    }).pipe(Effect.ensuring(Effect.promise(() => this.mpc.waitForTask(id))))), { signal });
  }
  analyze(eventId?: number, taskId?: string): Analysis {
    const verified = this.audit.verify(); if (!verified.valid) throw error("audit_invalid", "审计校验失败，不能发布证据结论。", 403);
    const events = this.audit.list(200);
    const selected = eventId ? events.find(event => event.id === eventId) : events.find(event => (!taskId || event.details.taskId === taskId) && ["request_rejected", "task_failed", "statistics_completed", "task_authorized", "mpc_started"].includes(event.kind));
    if (eventId && !selected) throw error("evidence_missing", "所选证据不在当前可查询记录中。", 404);
    const facts: string[] = [], possibleCauses: string[] = [], recommendations: string[] = [], evidenceIds: number[] = [];
    if (!selected) { facts.push("当前没有与所选范围关联的执行证据。"); recommendations.push("发起协作任务或选择实际事件后再调查。"); }
    else {
      evidenceIds.push(selected.id);
      if (selected.kind === "request_rejected") {
        facts.push(`证据 #${selected.id}：该次请求在 ${String(selected.details.layer ?? "接入层")} 被拒绝，代码 ${String(selected.details.code ?? "未记录")}。`);
        facts.push(selected.verifiedIdentity ? `实际已验证身份：${selected.verifiedIdentity}。` : "没有已验证身份，不能按自称身份归因。");
        possibleCauses.push("该次消息未通过身份、完整性、授权或防重放检查；需要结合失败代码区分。");
      } else if (selected.kind === "statistics_completed") facts.push(`证据 #${selected.id}：任务 ${String(selected.details.taskId)} 已完成批准的三方聚合。`);
      else if (selected.kind === "mpc_started") facts.push(`证据 #${selected.id}：任务已发起 MPC 调度，调度记录本身不证明计算完成。`);
      else if (selected.kind === "task_authorized") facts.push(`证据 #${selected.id}：任务已通过 RSU 授权，仍需核对后续计算与报告。`);
      else if (selected.kind === "task_failed") facts.push(`证据 #${selected.id}：该任务已停止，失败代码 ${String(selected.details.code)}。`);
      else facts.push(`证据 #${selected.id}：记录的事件类型为 ${selected.kind}，请结合关联任务的后续证据判断执行结果。`);
      recommendations.push("沿同一任务 ID 检查后续计算、报告与签名证据。");
    }
    return { facts, possibleCauses, recommendations, evidenceIds, uncertainties: ["事件不能单独证明攻击意图、传感器真实性或系统不存在其他泄露。", "单个请求的失败不能用于推断其他请求的执行阶段。"] };
  }
  private async investigate(id: string, config: ModelConfig, trace: Trace, signal: AbortSignal) {
    trace = withPhase(trace, 7);
    const current = this.store.task(id)!; if (current.analysis) return current.analysis;
    trace({ agent: "任务协调器", action: "证据调查委托", kind: "exchange", detail: "委托分析角色查询公开审计证据，并先校验完整审计链。", sender: "任务协调器", recipient: "信息安全分析 Agent" });
    let analysis = this.analyze(undefined, current.plan.intent === "statistics" ? id : undefined);
    {
      const events = this.audit.list(200).filter(event => current.plan.intent !== "statistics" || event.details.taskId === id).slice(0, 80); const ids = new Set(events.map(event => event.id));
      let queried = false;
      let submitted: Analysis | undefined;
      const text = await Effect.runPromise(runAgent(config, "调查公开审计证据。必须先调用 query_events，再调用 submit_analysis 提交结构化结论；evidenceIds 只引用实际查询到的事件编号。区分已验证身份和自称身份。不得将历史其他任务的失败归因于本次任务。", [], {
        query_events: { description: "获取已验证审计链中的公开事件摘要", parameters: emptyParameters, execute: async args => { emptyArgs(args); queried = true; return { events, baseline: analysis }; } },
        identity_status: { description: "获取登记身份公开状态", parameters: emptyParameters, execute: async args => { emptyArgs(args); return this.security.nodes(); } },
        submit_analysis: { description: "在查询真实证据后提交分析结论；提交成功即结束分析", parameters: analysisParameters, execute: async value => { submitted = validateAnalysis(value, queried, ids); return submitted; } },
      }, trace, signal, "信息安全分析 Agent", this.modelDiagnostic(id), { stopAfterTool: "submit_analysis" }), { signal });
      try {
        // Compatibility for providers returning a final JSON document instead of the submit tool.
        analysis = submitted ?? validateAnalysis(JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1")), queried, ids);
      } catch (cause) {
        const reason = cause instanceof AppError ? cause.message : "最终回复不是有效 JSON 对象。";
        this.logs.operation("analysis.validation_failed", { taskId: id, queried, allowedEvidenceIds: [...ids], reason }, "error");
        throw error("analysis_invalid", `分析提交失败：${reason}`, 422);
      }
    }
    this.store.update(id, { analysis });
    trace({ agent: "信息安全分析 Agent", action: "证据分析完成", kind: "analysis", detail: "确认事实、可能原因、建议和不确定性已分别记录；证据编号均来自实际查询。", evidenceIds: analysis.evidenceIds,
      protocolDetails: { objective: "生成有真实证据约束的分析产物。", operations: ["验证审计链。", "查询当前范围的公开证据。", "校验结构化字段及每个证据编号的成员关系。", "保存分析产物。"], sections: [{ title: "实际分析结论", data: analysis }], checks: [{ name: "分析结构及证据引用", status: "passed" }] } });
    return analysis;
  }
  report(id: string): SignedEnvelope {
    const box = this.store.report(id); if (!box) throw error("report_missing", "尚无可下载报告。", 404);
    return unseal(box, this.security.storageKey(), `report:${id}`) as SignedEnvelope;
  }
  verifyReport(value: unknown): Verification {
    try {
      const payload = this.security.verify(value, "report"), task = typeof payload.taskId === "string" ? this.store.task(payload.taskId) : undefined;
      if (!task || payload.type !== "collaboration-report-v2" || payload.requestId !== task.requestId || payload.requestDigest !== hash(task.request) || hash(payload.plan) !== hash(task.plan)) throw error("report_binding", "报告与登记任务的绑定无效。", 403);
      return { valid: true, reason: "登记签署者、Ed25519 签名、请求摘要和任务计划绑定均通过。", taskId: task.id };
    } catch { return { valid: false, reason: "报告格式、登记身份、签名或任务绑定验证失败。" }; }
  }
  private latestReport(conversationId?: string) {
    const tasks = this.store.tasks(conversationId).filter(task => task.hasReport).sort((a, b) => b.createdAt - a.createdAt);
    if (!tasks.length) throw error("report_missing", "当前范围尚无可验证报告。", 404);
    return this.report(tasks[0].id);
  }
  private async execute(id: string, config: ModelConfig, signal: AbortSignal) {
    const persistTrace = this.trace(id, config.apiKey), service = this;
    const execution = { phase: 2 as ConversationPhase };
    const trace: Trace = step => persistTrace({ ...step, phase: step.phase ?? execution.phase });
    const program = Effect.gen(function* () {
      yield* Effect.try({ try: () => service.store.update(id, { status: "running" }, "task.started"), catch: asError });
      let task = service.store.task(id)!;
      if (task.plan.intent === "statistics") { yield* attempt(abort => service.prepareStatistics(task, config, trace, abort)); task = service.store.task(id)!; }
      trace({ agent: "任务协调器", action: "锁定任务计划", kind: "analysis", detail: `任务类型：${task.plan.intent}；完成前必须获得：${task.plan.requires.join("、")}。本次使用已锁定的模型配置。`, metadata: { intent: task.plan.intent, mode: config.mode, requestDigest: hash(task.request) },
        protocolDetails: { objective: "将用户请求转成确定性执行契约。", operations: ["登记请求 ID、会话 ID 和任务 ID。", "锁定允许工具、参与者、统计范围及必需产物。", "同一会话串行执行，等待已有任务释放会话。"], sections: [{ title: "请求与执行契约", data: { request: task.request, requestId: task.requestId, taskId: id, conversationId: task.conversationId, plan: task.plan, mode: config.mode, model: config.model } }] } });
      let summary: string;
      execution.phase = task.plan.intent === "statistics" ? 3 : task.plan.intent === "verification" ? 8 : 7;
      {
        const tools: Record<string, Tool> = {
          compute_statistics: { description: "执行已批准的秘密分享统计，随后自动完成计划要求的证据分析；返回真实统计与分析产物，不能修改方案", parameters: emptyParameters, execute: async (args, abort, parentId) => {
            emptyArgs(args);
            const scoped = withParent(trace, parentId), result = await service.compute(id, scoped, abort);
            if (!task.plan.requires.includes("analysis")) return result;
            execution.phase = 7;
            trace({ agent: "任务协调器", parentId, kind: "analysis", action: "执行统计任务必需分析", detail: "统计已完成；按任务计划继续委托分析角色，分析产物完成后才向协调模型返回工具结果。",
              protocolDetails: { objective: "保证统计任务的必需分析不会因模型提前总结而遗漏。", operations: ["复用当前任务已有统计结果，不重复运行 MPC 或预留查询预算。", "检查当前任务是否已有分析；没有则委托真实分析角色。", "等待审计查询和结构化分析提交通过校验，再返回统计与分析。"], sections: [{ title: "执行契约", data: { taskId: id, requires: task.plan.requires, aggregate: true, analysisAlreadyPresent: Boolean(service.store.task(id)?.analysis) } }] } });
            const analysis = await service.investigate(id, config, scoped, abort);
            return { ...result, analysis };
          } },
          investigate: { description: "委托分析角色调查当前任务公开审计证据；统计任务自动先完成必要计算", parameters: emptyParameters, execute: async (args, abort, parentId) => { emptyArgs(args); if (task.plan.intent === "statistics") await service.compute(id, withParent(trace, parentId), abort); execution.phase = 7; return service.investigate(id, config, withParent(trace, parentId), abort); } },
          verify_latest_report: { description: "验证当前会话最近签名报告", parameters: emptyParameters, execute: async args => { emptyArgs(args); const result = service.verifyReport(service.latestReport(task.conversationId)); service.store.update(id, { verification: result }); return result; } },
          identity_status: { description: "读取公开登记身份状态", parameters: emptyParameters, execute: async args => { emptyArgs(args); return service.security.nodes(); } },
        };
        const allowed = task.plan.intent === "statistics" ? ["compute_statistics", "investigate", "identity_status"] : task.plan.intent === "investigation" ? ["investigate", "identity_status"] : task.plan.intent === "verification" ? ["verify_latest_report", "identity_status"] : ["identity_status"];
        for (const name of Object.keys(tools)) if (!allowed.includes(name)) delete tools[name];
        // Only completed public messages enter cross-turn context; no tool internals or credentials.
        const history = service.store.messages(task.conversationId).filter(message => message.taskId !== id).map(message => ({ role: message.role, content: redact(message.content, config.apiKey).slice(0, 4000) }));
        summary = yield* runAgent(config, `${task.request}\n\n固定任务计划：${canonical(task.plan)}\n统计任务调用 compute_statistics 后，后端会按计划自动完成真实统计和必需证据分析，工具同时返回两类产物；无需为了完成契约再次调用 investigate。请结合返回的统计和分析作出总结。必需工具产物完成后，系统自动签名、加密并发布本次报告。统计任务无需验证旧报告。`, history, tools, trace, signal, "任务协调 Agent", service.modelDiagnostic(id));
      }
      yield* Effect.try({ try: () => {
        execution.phase = 8;
        if (signal.aborted) throw error("cancelled", "任务已取消。", 409);
        const current = service.store.task(id)!;
        for (const required of current.plan.requires) {
          if (required === "aggregate" && !current.result || required === "analysis" && !current.analysis || required === "verification" && !current.verification || required === "explanation" && !summary.trim()) throw error("contract_incomplete", `任务缺少计划要求的产物：${required}。`, 422);
        }
        const auditState = service.audit.verify(); if (!auditState.valid) throw error("audit_invalid", "发布前审计验证失败。", 403);
        trace({ agent: "安全执行层", action: "任务产物与审计链校验", kind: "security", protocol: "执行契约 / SHA-256 审计链", detail: "所有必需产物已到齐，审计链验证通过，进入报告发布。",
          protocolDetails: { objective: "防止只有模型文字而没有真实产物的成功报告。", operations: ["逐项核对计划 requires。", "验证审计事件顺序、前驱摘要、哈希及签名。"], sections: [{ title: "发布前状态", data: { requires: current.plan.requires, aggregate: Boolean(current.result), analysis: Boolean(current.analysis), verification: Boolean(current.verification), audit: auditState } }], checks: [{ name: "必需产物", status: "passed" }, { name: "审计链", status: "passed" }] } });
        const payload: JsonObject = { type: "collaboration-report-v2", taskId: id, requestId: current.requestId, requestDigest: hash(current.request), plan: current.plan, mode: current.mode,
          summary, result: current.result ?? null, analysis: current.analysis ?? null, verification: current.verification ?? null, at: Date.now(), explanationSource: "model-generated interpretation" };
        const report = service.security.sign("report", payload);
        trace({ agent: "报告服务", action: "报告规范化与签名", kind: "report", protocol: "RFC 8785 JCS / Ed25519", detail: "使用 report 身份的 Ed25519 私钥对规范化报告负载签名。",
          protocolDetails: { objective: "让报告内容、任务和请求摘要可以独立验证。", operations: ["组装包含真实聚合结果与分析结论的报告。", "JCS 序列化负载。", "Ed25519 签署规范化原文。"], sections: signingSections(service.security, report) }, privateDetails: { sections: identityPrivate(service.security, "report") } });
        const verification = service.verifyReport(report); if (!verification.valid) throw error("report_invalid", verification.reason, 403);
        trace({ agent: "报告服务", action: "报告签名与任务绑定复核", kind: "security", protocol: "Ed25519 / SHA-256", detail: verification.reason,
          protocolDetails: { objective: "在发布前独立复核报告。", operations: ["核对登记 report 公钥并验签。", "比较 taskId、requestId、requestDigest 及 plan 摘要。"], sections: [{ title: "校验结果", data: verification }, { title: "任务绑定", data: { taskId: id, requestId: current.requestId, requestDigest: hash(current.request), planDigest: hash(current.plan), signature: report.signature } }], checks: [{ name: "签名与任务绑定", status: "passed" }] } });
        const reportBox = seal(report, service.security.storageKey(), `report:${id}`);
        if (canonical(unseal(reportBox, service.security.storageKey(), `report:${id}`)) !== canonical(report)) throw error("report_storage", "报告认证加密校验失败。", 500);
        trace({ agent: "报告服务", action: "报告认证加密与回读", kind: "report", protocol: "AES-256-GCM", detail: "以任务专属 AAD 加密完整签名报告，实际解密回读与原报告完全一致。",
          protocolDetails: { objective: "保护报告在本机持久化时的机密性及完整性。", operations: ["生成 12 字节随机 nonce。", "使用本机 256 位存储密钥及 report:taskId 作为 AAD。", "生成密文和 16 字节认证标签。", "验证标签、解密并比较规范化报告。"], sections: [{ title: "加密参数", data: { algorithm: "AES-256-GCM", aad: `report:${id}`, nonce: reportBox.nonce, tag: reportBox.tag, encoding: "base64url" } }], checks: [{ name: "认证解密与原文一致", status: "passed" }] },
          privateDetails: { sections: [{ title: "AES-256 存储密钥（hex）", data: service.security.storageKey().toString("hex") }, { title: "完整报告密文封装", data: reportBox }, { title: "加密前签名报告", data: report }] } });
        const event = service.audit.append("report_published", { taskId: id, reportDigest: hash(report.payload) });
        trace({ agent: "报告服务", action: "发布报告与完成对话", kind: "report", detail: "审计已记录发布事件，随后在同一 SQLite 事务中保存加密报告和任务完成状态，向页面推送完成事件。", evidenceIds: [event.id], metadata: { reportDigest: hash(report.payload) },
          protocolDetails: { objective: "交付可下载和复验的签名报告。", operations: ["追加 report_published 审计事件。", "原子保存任务完成状态与加密报告。", "经 SSE 推送公开步骤和总结，页面单独加载本机实验材料。"], sections: [{ title: "交付位置", data: { taskId: id, report: `/api/reports/${id}/download`, evidenceId: event.id, reportDigest: hash(report.payload) } }] } });
        service.store.update(id, { status: "completed", summary: redact(summary, config.apiKey) }, "task.completed", reportBox);
      }, catch: asError });
    }).pipe(Effect.timeoutFail({ duration: this.config.taskTimeout, onTimeout: () => error("task_timeout", "任务超过执行时限，已停止。", 504) }));
    const exit = await Effect.runPromiseExit(program, { signal });
    if (Exit.isFailure(exit)) {
      const cause = Cause.squash(exit.cause);
      this.logs.operation("task.execution_failed", { taskId: id, conversationId: this.store.task(id)?.conversationId, error: cause }, signal.aborted ? "info" : "error");
      const failure = signal.aborted ? error("cancelled", "任务已取消。", 409) : asError(cause);
      this.fail(id, failure.code, failure.message, signal.aborted, execution.phase === 8 ? 8 : this.store.task(id)?.steps.at(-1)?.phase ?? execution.phase);
    }
  }
  private modelDiagnostic(id: string) {
    return (event: string, detail: JsonObject, level: LogLevel = "info") => {
      this.logs.operation(event, { ...detail, taskId: id, conversationId: this.store.task(id)?.conversationId }, level);
    };
  }
  private fail(id: string, code: string, message: string, cancelled = false, phase: ConversationPhase = 1) {
    const task = this.store.task(id); if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return;
    for (const step of task.steps.filter(step => ["running", "queued"].includes(step.status))) this.store.step(id, { ...step, status: cancelled ? "cancelled" : "failed", detail: `${step.detail}\n任务停止，此步骤未完成。` });
    try { this.audit.append("task_failed", { taskId: id, code }); } catch { /* Damaged audit never changes a failed task into success. */ }
    this.store.update(id, { status: cancelled ? "cancelled" : "failed", error: { code, message, phase } }, cancelled ? "task.cancelled" : "task.failed");
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.logs.operation("server.stopping");
    for (const job of this.queue) this.fail(job.id, "service_stopping", "服务停止，排队任务未执行。"); this.queue = [];
    for (const controller of this.active.values()) controller.abort();
    while (this.active.size) await Bun.sleep(20);
    await this.mpc.close(); this.rsu.close(); this.stopLogging(); this.store.close(); this.unlock();
    this.logs.operation("server.stopped");
  }
}
function withParent(trace: Trace, parentId: string): Trace { return step => trace({ ...step, parentId: step.parentId ?? parentId }); }
function withPhase(trace: Trace, phase: ConversationPhase): Trace { return step => trace({ ...step, phase: step.phase ?? phase }); }
const analysisTextFields = ["facts", "possibleCauses", "recommendations", "uncertainties"];
export const analysisParameters: JsonObject = { type: "object", properties: Object.fromEntries([
  ...analysisTextFields.map(name => [name, { type: "array", maxItems: 30, items: { type: "string", maxLength: 1500 } }]),
  ["evidenceIds", { type: "array", minItems: 1, maxItems: 80, uniqueItems: true, items: { type: "integer" } }],
]), required: [...analysisTextFields, "evidenceIds"], additionalProperties: false };
export function validateAnalysis(value: unknown, queried: boolean, ids: Set<number>): Analysis {
  const invalid = (message: string): never => { throw error("analysis_invalid", message, 422); };
  if (!queried) invalid("必须先调用 query_events 查询真实证据。");
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("分析必须是 JSON 对象。");
  const data = value as Record<string, unknown>;
  if (canonical(Object.keys(data).sort()) !== canonical([...analysisTextFields, "evidenceIds"].sort())) invalid("字段必须为 facts、possibleCauses、recommendations、uncertainties、evidenceIds。");
  for (const name of analysisTextFields) if (!Array.isArray(data[name]) || (data[name] as unknown[]).length > 30 || !(data[name] as unknown[]).every(s => typeof s === "string" && s.length <= 1500)) invalid(`${name} 必须是最多 30 项、每项不超过 1500 字符的字符串数组。`);
  if (!Array.isArray(data.evidenceIds) || !data.evidenceIds.length || data.evidenceIds.length > 80 || !data.evidenceIds.every(n => Number.isSafeInteger(n) && ids.has(n)) || new Set(data.evidenceIds).size !== data.evidenceIds.length) invalid("evidenceIds 必须是本次查询所得的非空、不重复整数编号数组。");
  return data as unknown as Analysis;
}
