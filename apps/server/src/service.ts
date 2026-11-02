import { randomUUID } from "node:crypto";
import { Effect, Cause, Exit } from "effect";
import { AppError, error, asError, PARTICIPANTS, VERSION, shanghaiTime, registeredIdentityFor, planTask, type StatisticsQuery, type Analysis, type AuditEvent, type CreateTask, type ConversationDeletion, type JsonObject, type Overview, type SignedEnvelope, type Task, type Verification, type ProtocolMaterials } from "@vectra/shared";
import { Audit } from "./audit";
import type { Config } from "./config";
import { emptyArgs, emptyParameters, ModelSettings, redact, runAgent, type ModelConfig, type Tool } from "./model";
import { MpcRunner } from "./mpc/runner";
import { authorizeTask, canonical, hash, Security, seal, unseal } from "./security";
import { Store } from "./store";
import { createAuthorizationService, type AuthorizationService, type Trace } from "./transport";
import { runtimeLock } from "./lock";
import { requireCurrentIdentities } from "./identity-migration";
import { Diagnostics, type LogLevel } from "./logging";
import { identityPublic, identityPrivate, signingSections } from "./protocol";
import { Telemetry } from "./telemetry";
import { ParkData, PARK_PLANNING_GUIDE } from "./park";
import { FleetData } from "./fleet";
import { operationsQueryParameters, approveStatisticsQuery } from "./statistics";
import { ReservationData, RESERVATION_PLANNING_GUIDE } from "./reservations";
import { reservationContextFor, coordinateReservations, summarizeBottleneck, type ParkCatalog, type ReservationCatalog } from "@vectra/shared";
import { resolveStepPhase, type ConversationPhase } from "@vectra/shared";
import { AgentRuntime, type AgentModelSnapshots } from "./agent-runtime";
import { explicitMemoryRequest } from "./agent-memory";
import { FederatedPark } from "./federation-park";
import { FederationTransport } from "./federation-transport";
import { BUSINESS_GUIDE, BUSINESS_FIELD_LABELS, BUSINESS_DOMAINS, plateNumberError, normalizePlateNumber, type BusinessCatalog, type BusinessDomain } from "@vectra/shared";

const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: run, catch: asError });
const metadataKeys = new Set(["round", "model", "toolResultCount", "toolCallId", "source", "requestDigest", "reportDigest", "mode", "road", "windowSeconds", "participantCount", "threshold", "code", "intent", "delegationId", "requestTimeoutMs", "errorCode", "retryScheduled", "formatCorrections", "httpStatus", "attempts", "retryCount", "providerCode", "providerType", "providerParam", "providerRequestId", "receivedShares"]);
export class Collaboration {
  readonly audit: Audit;
  readonly settings: ModelSettings;
  readonly mpc: MpcRunner | FederatedPark;
  readonly federation?: FederatedPark;
  readonly telemetry: Telemetry;
  readonly park: ParkData;
  readonly fleet: FleetData;
  readonly reservations: ReservationData;
  readonly agents: AgentRuntime;
  private queue: { id: string; models: AgentModelSnapshots; conversationId: string }[] = [];
  private active = new Map<string, AbortController>();
  private activeConversations = new Set<string>();
  private deletingConversations = new Map<string, Promise<ConversationDeletion>>();
  private closed = false;
  private stopLogging = () => {};
  private readonly computeGate = Effect.runSync(Effect.makeSemaphore(1));
  private constructor(readonly config: Config, readonly security: Security, readonly store: Store, readonly authorizationService: AuthorizationService, audit: Audit, private unlock: () => void, readonly logs: Diagnostics) {
    this.audit = audit; this.settings = new ModelSettings(config.dataDir, security);
    this.agents = new AgentRuntime(config.dataDir, security, store, this.settings);
    logs.remember(this.settings.snapshot().apiKey);
    this.stopLogging = logs.follow(store, hash(security.ca()).slice(0, 24)).unsubscribe;
    const owners=config.deployment ? [] : [...PARTICIPANTS];
    this.telemetry = new Telemetry(security,owners);
    this.park = new ParkData(security,owners);
    this.reservations = new ReservationData(security, () => this.park.catalog().settings,owners);
    this.fleet = new FleetData(security, this.park,owners);
    if(config.deployment){
      if(config.deployment.role!=="park")throw error("invalid_deployment","园区服务不能使用企业端部署配置。",500);
      this.federation=new FederatedPark(security,this.park,this.reservations,config.mpcTimeout);
      store.db.exec("CREATE TABLE IF NOT EXISTS federation_vehicle_owners(plate_hash TEXT PRIMARY KEY,owner TEXT NOT NULL)");
      this.federation.transport=new FederationTransport(security,config.deployment,(peer,kind,data)=>{
        if(!PARTICIPANTS.includes(peer as typeof PARTICIPANTS[number]))throw error("federation_forbidden","只接受登记企业的协作消息。",403);
        if(kind==="public-settings")return {settings:this.park.catalog().settings};
        if(kind==="claim-plates"){
          if(!Array.isArray(data.plates)||data.plates.length>6000)throw error("invalid_vehicle","车辆归属登记格式无效。",422);
          const plates=data.plates.map(value=>{const problem=plateNumberError(value);if(problem)throw error("invalid_vehicle",problem,422);return normalizePlateNumber(value as string);});
          store.db.transaction(()=>{for(const plate of plates){const digest=hash(plate),current=store.db.query<{owner:string},[string]>("SELECT owner FROM federation_vehicle_owners WHERE plate_hash=?").get(digest);
            if(current&&current.owner!==peer)throw error("carrier_scope_forbidden","该车牌已登记在另一家公司。",409);
            store.db.query("INSERT OR IGNORE INTO federation_vehicle_owners VALUES(?,?)").run(digest,peer);}}).immediate();return {accepted:true};
        }
        throw error("federation_forbidden","园区不接受该企业协作操作。",403);
      },cause=>logs.operation("federation.rpc_failed",{error:cause},"error"));
    }
    this.mpc = this.federation ?? new MpcRunner(security, config.dataDir, config.mpcTimeout);
    security.configureIdentities(this.park.catalog().settings);
  }
  static async open(config: Config) {
    const logs = new Diagnostics(config.logDir);
    let unlock = () => {};
    let store: Store | undefined, authorizationService: AuthorizationService | undefined;
    try {
      unlock = runtimeLock(config.dataDir);
      requireCurrentIdentities(config.dataDir);
      const security = await Security.open(config.dataDir + "/pki"); store = new Store(config.dataDir);
      const audit = new Audit(store, security, entry => { logs.operation(`audit.${entry.kind}`, { auditEventId: entry.id, details: entry.details,
        claimedIdentity: entry.claimedIdentity, verifiedIdentity: entry.verifiedIdentity }, /reject|failed/.test(entry.kind) ? "warn" : "info", entry.at); });
      const checked = audit.verify(); if (!checked.valid) throw error("audit_invalid", checked.reason, 500);
      authorizationService = await createAuthorizationService(security, store, audit);
      const service = new Collaboration(config, security, store, authorizationService, audit, unlock, logs);
      if(service.federation)await service.federation.transport.start();
      audit.append("service_started", { version: VERSION, protocol: "Shamir m=3 t=1 / TLS 1.3" }); return service;
    } catch (cause) { logs.operation("server.initialization_failed", { error: cause }, "error"); authorizationService?.close(); store?.close(); unlock(); throw cause; }
  }
  overview(): Overview {
    return { version: VERSION, mode: this.settings.public().mode, park: this.park.catalog().settings, conversations: this.store.conversations(), tasks: this.store.tasks(), nodes: this.security.nodes(), eventCursor: this.store.cursor(), audit: { count: this.audit.count(), lastVerification: this.audit.lastVerification } };
  }
  publicCatalogs() {
    if(this.federation?.catalogs){const catalogs=this.federation.catalogs;const {capacitySlots,...reservations}=catalogs.reservations;return {...catalogs.park,reservationPlans:{...reservations,configuredCapacitySlots:capacitySlots.length},businessCatalogs:catalogs.business};}
    const { capacitySlots, ...reservationPlans } = this.reservations.catalog();
    return { ...this.park.catalog(), reservationPlans: { ...reservationPlans, configuredCapacitySlots: capacitySlots.length } };
  }
  submit(input: CreateTask) {
    if (this.closed) throw error("service_stopping", "服务正在停止。", 503);
    if (input.conversationId && this.deletingConversations.has(input.conversationId)) throw error("conversation_deleting", "此对话正在删除，请开始新对话。", 409);
    this.settings.requireReady();
    const models = this.agents.models(), snapshot = models.coordinator; for (const config of Object.values(models)) this.logs.remember(config.apiKey);
    this.agents.requireModels(planTask(input.request, input.intent).intent, models);
    const result = this.store.create(input, snapshot.mode, snapshot.mode === "llm" ? snapshot.model : undefined);
    if (result.created) {
      try { this.audit.append("task_created", { taskId: result.task.id, conversationId: result.task.conversationId, intent: result.task.plan.intent }); }
      catch (cause) { this.fail(result.task.id, "audit_invalid", "审计记录写入失败，任务未进入执行。 "); throw cause; }
      this.queue.push({ id: result.task.id, models, conversationId: result.task.conversationId }); this.drain();
    }
    return result.task;
  }
  private drain() {
    while (!this.closed && this.active.size < 2 && this.queue.length) {
      const eligible = this.queue.findIndex(job => !this.activeConversations.has(job.conversationId));
      if (eligible < 0) break;
      const [job] = this.queue.splice(eligible, 1), controller = new AbortController(); this.active.set(job.id, controller); this.activeConversations.add(job.conversationId);
      void this.execute(job.id, job.models, controller.signal).finally(() => { this.active.delete(job.id); this.activeConversations.delete(job.conversationId); this.drain(); });
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
      const result = this.store.db.transaction(() => { this.agents.clearConversationRuns(id); return this.store.deleteConversation(id); }).immediate();
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
      const { privateDetails: sourcePrivate, ...publicStep } = raw;
      const privateDetails=this.config.deployment?undefined:sourcePrivate;
      const principal = registeredIdentityFor(raw.agent);
      if (!principal || !this.security.registry.nodes[principal]) throw error("identity_unknown", "执行消息的负责身份未登记，不能作为对话角色发布。", 403);
      const ownerOf = (value?: string) => value === "模型服务" && raw.kind === "model" ? principal : value ? registeredIdentityFor(value) : undefined;
      const stepId = raw.id || randomUUID();
      const privateBox = privateDetails ? seal(privateDetails, this.security.storageKey(), `protocol:${id}:${stepId}`) : undefined;
      // Private material is committed separately before notification; it is never a public event field.
      const recorded = task.steps.find(step => step.id === stepId);
      const recordedDetails = recorded?.protocolDetails;
      const protocolDetails = JSON.parse(redact(JSON.stringify(raw.protocolDetails ?? recordedDetails ?? { objective: raw.action, operations: [raw.detail] }), key));
      this.store.step(id, { ...publicStep, agent: principal, ...(raw.sender ? { sender: ownerOf(raw.sender) } : {}), ...(raw.recipient ? { recipient: ownerOf(raw.recipient) } : {}), id: stepId, phase: recorded?.phase ?? raw.phase ?? resolveStepPhase(raw, task.steps), protocolDetails, detail: redact(raw.detail, key).slice(0, 30000),
        ...(privateDetails ? { hasPrivateDetails: true } : {}), ...(raw.metadata ? { metadata } : {}) }, privateBox);
    };
  }
  protocolMaterials(taskId: string, stepId: string): ProtocolMaterials {
    if(this.config.deployment)throw error("portal_forbidden","独立园区部署不提供企业原始数据、私钥或完整份额材料。",403);
    if (!this.store.task(taskId)) throw error("task_missing", "任务不存在。", 404);
    const box = this.store.protocolMaterials(taskId, stepId);
    if (!box) throw error("protocol_materials_missing", "该历史步骤未保存当时的完整协议材料，不能重建或伪造瞬时密钥与份额。", 404);
    return unseal(box, this.security.storageKey(), `protocol:${taskId}:${stepId}`) as ProtocolMaterials;
  }
  signedTask(task: Task) {
    if (!task.plan.statistics || !task.plan.datasetVersion) throw error("statistics_plan_missing", "统计方案或数据版本未获批准，不能签署任务。", 422);
    const query = task.plan.statistics;
    return this.security.sign("coordinator", { taskId: task.id, requestId: task.requestId, requestDigest: hash(task.request), road: query.roads.join("、"),
      windowSeconds: (query.end - query.start) / 1000, statistics: query, datasetVersion: task.plan.datasetVersion,
      ...(task.plan.parkContext ? { parkContext: task.plan.parkContext } : {}),
      ...(task.plan.reservationContext ? { reservationContext: task.plan.reservationContext } : {}),
      ...(task.plan.businessContext ? { businessContext: task.plan.businessContext } : {}),
      ...(task.plan.federationManifest ? { federationManifest: task.plan.federationManifest } : {}),
      participants: task.plan.participants, metric: "aggregate_vector_v1", createdAt: Date.now(), expiresAt: Date.now() + 90_000 });
  }
  private async prepareStatistics(task: Task, config: ModelConfig, trace: Trace, signal: AbortSignal, memoryContext: string) {
    trace = withPhase(trace, 2);
    if(this.federation)await this.federation.refresh(signal);
    const actualCatalog = this.federation?.catalogs?.park ?? this.park.catalog(), reservationCatalog = this.federation?.catalogs?.reservations ?? this.reservations.catalog(), now = Date.now();
    if(!this.federation&&!actualCatalog.roads.length&&!/预约|需求|运力|计划/.test(task.request))throw error("dataset_missing","尚无实际车次，请先在企业端登记或导入车次，再发起实绩统计。",409);
    let catalog: ParkCatalog | ReservationCatalog | BusinessCatalog = actualCatalog;
    let query: StatisticsQuery | undefined;
    {
      const history = this.store.messages(task.conversationId).filter(m => m.taskId !== task.id).slice(-6).map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
      const response = await Effect.runPromise(runAgent(config, BUSINESS_GUIDE + "\n经营字段说明：" + canonical(BUSINESS_FIELD_LABELS) + "\n" + `先选择数据类型：以下车次指南仅适用于park_visits；预约协同指南仅适用于reservation_plans，禁止混用。\n${PARK_PLANNING_GUIDE}\n${RESERVATION_PLANNING_GUIDE}\n跨企业瓶颈分析设置analysis=bottleneck，后端补齐20项各环节观察值和共同完整链路统计；不能用不同车次样本的观察均值直接排名。预约需求、预计到园和运力协同选择reservation_plans；历史实绩选择park_visits。\n用户请求：${task.request}\n当前 Unix 毫秒：${now}，上海时间：${shanghaiTime(now)}。公开数据目录：${canonical(this.publicCatalogs())}。`, history, {
        get_park_overview: { description: "查看实际车次与预约计划的公开目录，不返回本方申报值或车辆明细", parameters: emptyParameters, execute: async args => { emptyArgs(args); return this.publicCatalogs(); } },
        submit_statistics_plan: { description: "提交实际车次瓶颈分析或未来预约运力协同方案，选择正确的数据类型、入口、时间和指标", parameters: operationsQueryParameters, execute: async (value, _signal, parentId) => {
          const proposed = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
          if(proposed.dataset==="carrier_business"){
            if(!this.federation?.catalogs)throw error("deployment_required","经营台账统计需要已配置的独立企业服务。",409);
            catalog=this.federation.catalogs.business[proposed.domain as BusinessDomain]??this.federation.catalogs.business.demand;
          }else catalog = proposed.dataset === "reservation_plans" ? reservationCatalog : actualCatalog;
          if (catalog.dataset === "park_visits" && !catalog.roads.length) throw error("dataset_missing", "尚无实际车次，请先在承运商工作台登记或导入车次。预约协同须选择预约计划数据。", 409);
          try { query = approveStatisticsQuery(task.request, value, catalog, now); }
          catch (cause) {
            const publicTime = (v: unknown) => typeof v === "number" || typeof v === "string" ? v : null;
            this.logs.operation("statistics.plan_rejected", { taskId: task.id, anchor: now, timeZone: "Asia/Shanghai", submittedTime: { start: publicTime(proposed.start), end: publicTime(proposed.end), timeZone: publicTime(proposed.timeZone) }, error: asError(cause) }, "warn");
            throw cause;
          }
          trace({ agent: "planner", parentId, kind: "security", action: "锁定查询时间范围", detail: `按上海时区锁定 ${shanghaiTime(query.start)} 至 ${shanghaiTime(query.end)}，时长 ${(query.end - query.start) / 1000} 秒。`,
            protocolDetails: { objective: "由服务端时钟确定明确的时间窗口，避免模型计算时间戳偏移。", operations: [query.dataset === "carrier_business" && query.domain !== "haulage" ? "按独立经营申报解析未来范围，计划不代表已发生业务。" : query.dataset === "reservation_plans" ? "按独立预约计划解析未来相对时段、明天或今天剩余时段；不把计划当作已发生事件。" : "今天为上海零点至本次规划时刻，昨天与前天为完整历史自然日；实际事件不能在未来。", "保留明确指定的日期和子时段，不擅自改写为整天。", "完整校验入口、指标、时区和31天上限，冻结进入签名计划。"], sections: [{ title: "服务端时间锚点", data: { at: now, timeZone: "Asia/Shanghai" } }, { title: "批准的时间范围", data: { start: query.start, end: query.end, windowSeconds: (query.end - query.start) / 1000, resolvedByServer: query.start !== proposed.start || query.end !== proposed.end || query.timeZone !== proposed.timeZone } }] } });
          return query;
        } },
      }, trace, signal, "planner", this.modelDiagnostic(task.id), { stopAfterTool: "submit_statistics_plan", memoryContext, requestTimeoutMs: this.config.modelTimeout }), { signal });
      if (!query) throw error("statistics_plan_missing", `模型未提交可执行统计方案：${response.slice(0, 1200)}`, 422);
    }
    const federationManifest=this.federation?.manifest(catalog.version);
    const plan = { ...task.plan, road: query.roads.join("、"), windowSeconds: (query.end - query.start) / 1000, statistics: query, datasetVersion: catalog.version, parkContext: { settings: catalog.settings, dataUpdatedAt: catalog.updatedAt }, ...(query.dataset === "reservation_plans" ? { reservationContext: reservationContextFor(reservationCatalog.capacitySlots, query) } : {}),
      ...(federationManifest?{federationManifest}:{}),...(query.dataset==="carrier_business"&&federationManifest?{businessContext:this.federation!.businessContext(query,federationManifest)}:{}) };
    trace({ agent: "planner", kind: "analysis", action: "批准统计方案", detail: `联合分析 ${catalog.settings.carriers.map(c => c.name).join("、")} 的 ${query.roads.join("、")} ${query.dataset === "carrier_business" ? BUSINESS_DOMAINS[query.domain!] : query.dataset === "reservation_plans" ? "预约计划与运力" : query.analysis === "bottleneck" ? "跨企业完整链路瓶颈" : "实际车次"}。`, protocolDetails: { objective: "让三家承运商按相同业务口径完成联合统计。", operations: ["明确统计资料类型，冻结各企业来源版本、入口与时间；原始明细在各企业保管。", query.dataset === "carrier_business" ? "核对本方资料完整声明，区分缺报、明确为零及可选字段缺失；冻结充电容量等批准上下文。" : query.dataset === "reservation_plans" ? "冻结各时段园区入口和作业容量；计划不作为已发生事件。" : "观察值分别说明有效样本，瓶颈排名仅使用同一批完整链路车次。", "各方在本地计算，缺失字段不补零；公开结果注明申报覆盖。"], sections: [{ title: "统计方案", data: query }, { title: "本次园区与承运商", data: plan.parkContext }, ...(plan.reservationContext ? [{ title: "本次冻结的园区容量", data: plan.reservationContext }] : []), { title: "数据范围说明", data: { datasetVersion: catalog.version, records: catalog.sampleCount, note: query.dataset === "carrier_business" ? BUSINESS_GUIDE : query.dataset === "reservation_plans" ? "每半小时分别申报需求、运力和预计作业量，按计划时段起点选择；零需求也须明确申报。协调建议不修改预约。" : "每次进园为一个车次，车次不等于车辆；缺失环节不推算，完整链路均值按同一批有效车次计算。" } }] } });
    return plan;
  }
  private async planStatistics(id: string, models: AgentModelSnapshots, trace: Trace, signal: AbortSignal, memoryContext: string) {
    const task = this.store.task(id)!; if (task.plan.statistics) return task.plan;
    const scoped = withPhase(trace, 2), plan = await this.agents.execute(task, "planner", models.planner, "统计查询规划", { request: task.request, publicCatalog: this.publicCatalogs(), memoryContext }, scoped, signal,
      () => this.prepareStatistics(task, models.planner, scoped, signal, memoryContext));
    this.store.update(id, { plan }); return plan;
  }
  private async compute(id: string, trace: Trace, signal: AbortSignal) {
    trace = withPhase(trace, 3);
    const existing = this.store.task(id)!; if (existing.result) return existing.result;
    return Effect.runPromise(this.computeGate.withPermits(1)(attempt(async inner => {
      const current = this.store.task(id)!; if (current.result) return current.result;
      const signed = this.signedTask(current); authorizeTask(this.security, signed);
      trace({ agent: "coordinator", action: "生成并验证签名任务", kind: "security", protocol: "RFC 8785 JCS / Ed25519", detail: "签署已批准统计计划，验证登记签署者、有效期和允许范围。",
        protocolDetails: { objective: "将本次请求与不可更改的统计任务绑定。", operations: ["对请求计算 SHA-256 摘要。", "将任务负载按 JCS 规范序列化。", "用 coordinator 的 Ed25519 私钥签名，再用登记公钥验证。", "核对路段、起止时间、组合指标、数据版本及三方参与者。"],
          checks: [{ name: "任务签名与策略", status: "passed", actual: "authorizeTask 已通过" }], sections: signingSections(this.security, signed) }, privateDetails: { sections: identityPrivate(this.security, "coordinator") } });
      this.store.reserveBudget(this.config.cooldown);
      trace({ agent: "coordinator", action: "预留隐私查询预算", kind: "security", detail: "在 SQLite 事务中检查冷却间隔并预留本次查询；随后才允许启动节点协议。", metadata: { participantCount: 3, threshold: 1 },
        protocolDetails: { objective: "限制高频重复统计。", operations: ["串行获取 MPC 执行许可。", "检查持久化查询冷却时间并写入预算。"], sections: [{ title: "本次策略", data: { cooldownSeconds: this.config.cooldown, statistics: current.plan.statistics, participants: PARTICIPANTS, degree: 1, reconstruction: "实现要求三个聚合份额全部到齐" } }], checks: [{ name: "预算预留", status: "passed" }] } });
      await this.authorizationService.authorize(signed, trace, inner);
      const event = this.audit.append("mpc_started", { taskId: id });
      const stepId = randomUUID();
      trace({ id: stepId, phase: 4, agent: "coordinator", kind: "mpc", action: "三方秘密分享计算", status: "running", detail: "各企业计算节点校验冻结任务，读取本企业数据，并建立双向认证的加密连接；独立部署的企业服务不向园区发送原始明细。", evidenceIds: [event.id] });
      const result = await this.mpc.run(signed, withParent(trace, stepId), inner);
      result.source = result.query?.dataset === "carrier_business" ? "企业独立经营台账冻结快照" : result.query?.dataset === "reservation_plans" ? "预约需求与运力申报快照" : "园区车次导入快照";
      if (result.reservationContext && result.groups) result.coordination = coordinateReservations(result.groups, result.reservationContext);
      if (result.coordination) trace({ phase: 6, agent: "coordinator", kind: "analysis", action: "核对预约需求与园区容量",
        detail: "按已签名的联合申报结果比较运输运力、入口额度和作业资源；仅在每个基础时段三家都已申报且容量完整时给出建议安排数，不修改预约。",
        protocolDetails: { objective: "把联合申报量转换为可人工复核的协调建议。", operations: ["逐时段核对三家申报覆盖，零申报与缺报分别处理。", "比较运输额度、入口容量及按平均作业量估算的资源约束。", "为同入口后续时段计算错峰建议，每份目标额度只使用一次。", "建议单独交付人工确认，不生成实际车次或改写预约台账。"], sections: [{ title: "预约协同结果", data: result.coordination }] } });
      if (result.query?.analysis === "bottleneck" && result.groups) trace({ phase: 6, agent: "coordinator", kind: "analysis", action: "比较完整链路环节耗时",
        detail: "分别列出各环节观察均值，再用同一批完整链路车次比较耗时和占比；没有完整共同样本时不给出瓶颈排名。",
        protocolDetails: { objective: "避免将不同样本范围的均值直接比较为业务瓶颈。", operations: ["保留每个环节实际有效样本数。", "使用备车至离园全部端点齐全的共同车次，计算九个环节的均值和占比。", "将最长耗时作为人工复核线索，不推断责任或因果。"], sections: [{ title: "跨企业瓶颈结果", data: result.groups.map(group => ({ road: group.road, ...summarizeBottleneck(group) })) }] } });
      const completed = this.audit.append("statistics_completed", { taskId: id, road: result.road, datasetVersion: result.datasetVersion, groups: result.groups, participantCount: 3 });
      this.store.update(id, { result });
      trace({ id: stepId, agent: "coordinator", kind: "mpc", action: "三方秘密分享计算", status: "completed", detail: `真实三方协议完成，已生成 ${result.groups?.length} 个路段的批准指标结果。下方逐条展示节点实际返回的进度、公钥与签名等可核验材料；私有数据、私钥和输入份额由各企业保管。`, evidenceIds: [completed.id],
        protocolDetails: { objective: "汇总三个独立节点的真实计算结果。", operations: ["三个工作进程完成输入解密、秘密分享、认证收发、本地聚合及重构。", "园区协调 Agent 验证 carrier-a 的输出签名和任务绑定。", "持久化批准聚合结果与审计证据。"], sections: [{ title: "批准输出", data: result }] } });
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
      else if (selected.kind === "task_authorized") facts.push(`证据 #${selected.id}：任务已通过 安全授权服务 授权，仍需核对后续计算与报告。`);
      else if (selected.kind === "task_failed") facts.push(`证据 #${selected.id}：该任务已停止，失败代码 ${String(selected.details.code)}。`);
      else facts.push(`证据 #${selected.id}：记录的事件类型为 ${selected.kind}，请结合关联任务的后续证据判断执行结果。`);
      recommendations.push("沿同一任务 ID 检查后续计算、报告与签名证据。");
    }
    return { facts, possibleCauses, recommendations, evidenceIds, uncertainties: ["事件不能单独证明攻击意图、传感器真实性或系统不存在其他泄露。", "单个请求的失败不能用于推断其他请求的执行阶段。"] };
  }
  private async investigate(id: string, config: ModelConfig, trace: Trace, signal: AbortSignal, memoryContext = "") {
    trace = withPhase(trace, 7);
    const current = this.store.task(id)!; if (current.analysis) return current.analysis;
    return this.agents.execute(current, "analyst", config, "运营与证据分析", { taskId: id, approvedPlan: current.plan, approvedResult: current.result ?? null, memoryContext }, trace, signal, async () => {
    trace({ agent: "coordinator", action: "证据调查委托", kind: "analysis", detail: "开始核对本轮运营结果。先验证审计记录的完整性，再调用模型分析批准的统计与证据。" });
    let analysis = this.analyze(undefined, current.plan.intent === "statistics" ? id : undefined);
    const parkFacts = current.result?.query?.dataset === "park_visits" ? (current.result.groups ?? []).map(group => `${group.road}：${current.result!.query!.cohort === "departures" ? "按离园时间" : "按到达时间"}选取 ${group.coverage?.visits ?? 0} 个车次，已离园 ${group.coverage?.completed ?? 0} 个、未离园 ${group.coverage?.unfinished ?? 0} 个，实际有数据 ${group.coverage?.contributingCarriers ?? 0}/3 家承运商。`) : [];
    if (parkFacts.length) analysis = { ...analysis, facts: [...parkFacts, ...analysis.facts], uncertainties: ["时长及用电仅基于导入快照中的完整字段，缺失记录未补零；到达与离园口径不能混用。", "运营建议由模型解释批准结果，尚未自动调整预约或作业资源，也不证明改善的因果关系。"] };
    if (current.result?.query?.analysis === "bottleneck") {
      const facts = (current.result.groups ?? []).map(group => {
        const result = summarizeBottleneck(group);
        return group.road + "完整链路共同样本" + result.complete + "车次；" + (result.ranking.length ? "平均耗时最长环节：" + result.leaders.join("、") + "，" + result.ranking[0].comparable + "分钟。" : result.complete ? "各环节时长均为零，需核对时间精度。" : "尚不足以比较完整链路瓶颈，需补齐缺失时间。");
      });
      analysis = { ...analysis, facts: [...facts, ...analysis.facts], uncertainties: [...analysis.uncertainties, "各环节观察值可能来自不同样本，排名仅使用完整链路共同样本；耗时最长不等于已经证明责任或因果。"] };
    }
    if (current.result?.coordination) analysis = { ...analysis,
      facts: [...current.result.coordination.rows.map(row => row.road + "时段" + shanghaiTime(row.start) + "：申报需求" + row.expectedTrips + "车次，可投入" + row.availableTrips + "车次，" + (row.recommendedTrips === null ? "申报或容量不完整，不能确认安排额度。" : "按当前申报与平均作业量建议安排" + row.recommendedTrips + "车次。")), ...analysis.facts],
      uncertainties: ["结果来自各方申报计划，不代表实际到园或已完成运输；运力按入口时段分配，不是去重车辆数。", "缺报和容量未配置不视为零；时段边界按计划开始时间选择。", "错峰建议需要相关承运商和园区确认，没有自动改写任何预约；按平均作业量估算的额度不能代替逐车资源排程。"] };
    {
      const events = this.audit.list(200).filter(event => current.plan.intent !== "statistics" || event.details.taskId === id).slice(0, 80); const ids = new Set(events.map(event => event.id));
      let queried = false;
      let submitted: Analysis | undefined;
      const scene = current.result?.query?.dataset === "carrier_business" ? BUSINESS_GUIDE + "各businessCoverage.declaredCarriers不足3时，确定性结论必须限定为已收到资料；不能编造未申报量。每项validSamples只表示该指标有效记录。引用已有批准数值，需求弹性不自动改预约，回程额度不自动撮合。充电容量上下文是冻结版本；只有完整声明和完整容量下才解释电量缺口，不承诺逐车可行。" : current.result?.query?.dataset === "reservation_plans" ? "这是预约需求与运力计划。依据operationsResult.coordination解释需求、可投入运输额度、入口容量、作业分钟缺口和建议安排数。缺报或容量未配置时不能给出确定安排数；只引用系统生成的可行错峰建议，不自行重复分配目标额度。计划不是实际到园，建议没有自动执行；平均作业量不能代替逐车排程。" : current.result?.query?.analysis === "bottleneck" ? "这是跨企业等待与周转瓶颈分析。只用完整链路共同样本均值排名、计算占比；观察值有不同有效车次，不能直接比较成瓶颈。没有共同样本时明确补齐环节，不能给出确定排名。运输在途包含必要行程，最长耗时不等于责任或因果。" : "根据实际批准结果解释有效车次、覆盖与未完成记录；缺少时间端点或能耗不补零，缺失指标不能编造。区分到达与离园口径，覆盖不足三家不能称数据齐全。";
      const text = await Effect.runPromise(runAgent(config, "你是运营分析 Agent，接受主智能体委派。先调用query_events，再调用submit_analysis，证据编号仅来自真实返回。facts只引用批准结果与审计；possibleCauses为待核实假设；recommendations为人工建议，不能声称已调度或证明因果。区分已验证身份和自称身份，不将历史其他任务失败归因于本次任务。" + scene, [], {
        query_events: { description: "获取已验证审计链中的公开事件摘要", parameters: emptyParameters, execute: async args => { emptyArgs(args); queried = true; return { events, baseline: analysis, ...(current.result ? { operationsResult: current.result } : {}) }; } },
        identity_status: { description: "获取登记身份公开状态", parameters: emptyParameters, execute: async args => { emptyArgs(args); return this.security.nodes(); } },
        submit_analysis: { description: "在查询真实证据后提交分析结论；提交成功即结束分析", parameters: analysisParameters, execute: async value => { submitted = validateAnalysis(value, queried, ids); return submitted; } },
      }, trace, signal, "analyst", this.modelDiagnostic(id), { stopAfterTool: "submit_analysis", memoryContext, requestTimeoutMs: this.config.modelTimeout }), { signal });
      try {
        // Compatibility for providers returning a final JSON document instead of the submit tool.
        analysis = submitted ?? validateAnalysis(JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1")), queried, ids);
      } catch (cause) {
        const reason = cause instanceof AppError ? cause.message : "最终回复不是有效 JSON 对象。";
        this.logs.operation("analysis.validation_failed", { taskId: id, queried, allowedEvidenceIds: [...ids], reason }, "error");
        throw error("analysis_invalid", `分析提交失败：${reason}`, 422);
      }
    }
    if (parkFacts.length) analysis = { ...analysis, facts: [...new Set([...parkFacts, ...analysis.facts])], uncertainties: [...new Set([...analysis.uncertainties, "缺失时间端点不补零，未离园车次不进入完整周转均值；到达和离园口径不能直接比较。", "签名与证据编号检查不证明原始事件真实，模型建议需由园区人工评估，未执行预约或资源调度。"])] };
    if(current.result?.query?.dataset === "carrier_business")analysis={...analysis,facts:[...analysis.facts,...(current.result.groups??[]).map(group=>group.road+"资料完整声明"+(group.businessCoverage?.declaredCarriers??0)+"/3家，有记录"+(group.businessCoverage?.contributingCarriers??0)+"家；申报计划与已发生事实分开阅读。")],uncertainties:[...analysis.uncertainties,"联合聚合基于企业已登记的本地资料；加密与签名不证明输入真实。资料不足三家时不能推断完整需求，模型建议尚未执行。"]};
    this.store.update(id, { analysis });
    trace({ agent: "analyst", action: "证据分析完成", kind: "analysis", detail: "确认事实、可能原因、建议和不确定性已分别记录；证据编号均来自实际查询。", evidenceIds: analysis.evidenceIds,
      protocolDetails: { objective: "生成有真实证据约束的分析产物。", operations: ["验证审计链。", "查询当前范围的公开证据。", "校验结构化字段及每个证据编号的成员关系。", "保存分析产物。"], sections: [{ title: "实际分析结论", data: analysis }], checks: [{ name: "分析结构及证据引用", status: "passed" }] } });
    return analysis;
    });
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
  private memoryAndHistoryTools(task: Task): Record<string, Tool> {
    const parameters: JsonObject = { type: "object", properties: { query: { type: "string", maxLength: 200 } }, required: ["query"], additionalProperties: false };
    const query = (raw: unknown) => { if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1 || !("query" in raw) || typeof raw.query !== "string" || raw.query.length > 200) throw error("invalid_tool_args", "请输入最多200字的检索内容。", 422); return raw.query; };
    return {
      get_park_overview: { description: "查看实际车次及预约计划公开目录，不返回各方明细与申报值", parameters: emptyParameters, execute: async raw => { emptyArgs(raw); return this.publicCatalogs(); } },
      search_memory: { description: "检索主智能体的相关长期记忆；记忆是带日期与来源的参考，不代表当前事实", parameters, execute: async raw => ({ memories: this.agents.memory.context(query(raw)) }) },
      search_task_history: { description: "检索已完成任务的公开批准结果，历史结果不能代替本轮统计", parameters, execute: async raw => {
        const term = query(raw).trim().toLowerCase(), rows = this.store.db.query<{ body: string }, []>("SELECT body FROM tasks WHERE status='completed' ORDER BY created_at DESC LIMIT 200").all();
        return { note: "以下为历史任务，须核对日期、口径与数据版本。", tasks: rows.map(row => JSON.parse(row.body) as Task).filter(item => !term || [item.summary, item.plan.road].join(" ").toLowerCase().includes(term)).slice(0, 5).map(item => ({ taskId: item.id, conversationId: item.conversationId, recordedAt: item.updatedAt, summary: item.summary.slice(0, 800), result: item.result ?? null })) };
      } },
      remember_memory: { description: "用户在本轮明确要求记住时保存用户偏好、业务说明或操作经验，不保存密钥与原始车辆记录", parameters: { type: "object", properties: { title: { type: "string", maxLength: 80 }, content: { type: "string", maxLength: 2000 }, category: { type: "string", enum: ["preference", "business", "procedure"] }, tags: { type: "array", maxItems: 8, items: { type: "string", maxLength: 24 } } }, required: ["title", "content", "category", "tags"], additionalProperties: false }, execute: async raw => {
        if (!explicitMemoryRequest(task.request)) throw error("memory_not_requested", "本轮用户没有明确要求记住信息，不能写入长期记忆。", 403);
        if (!this.agents.memory.settings().enabled) return { saved: false, reason: "长期记忆已停用，请在主智能体详情页启用。" };
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !["title", "content", "category", "tags"].includes(key))) throw error("invalid_tool_args", "记忆字段无效。", 422);
        const item = this.agents.memory.save({ ...raw, enabled: true, pinned: false }, undefined, "user_request", task); this.logs.operation("agent.memory_saved", { agent: "coordinator", memoryId: item.id, taskId: task.id });
        return { saved: true, memory: item };
      } },
    };
  }
  private async execute(id: string, models: AgentModelSnapshots, signal: AbortSignal) {
    const config = models.coordinator;
    const persistTrace = this.trace(id, config.apiKey), service = this;
    const execution = { phase: 2 as ConversationPhase };
    const actionPhase: Record<string, ConversationPhase> = { delegate_statistics_planning: 2, compute_statistics: 3, delegate_analysis: 7, verify_latest_report: 8 };
    const trace: Trace = step => persistTrace({ ...step, phase: step.phase ?? actionPhase[step.action] ?? execution.phase });
    const program = Effect.gen(function* () {
      yield* Effect.try({ try: () => service.store.update(id, { status: "running" }, "task.started"), catch: asError });
      let task = service.store.task(id)!;
      if(!service.federation&&task.plan.intent==="statistics"&&!service.park.catalog().roads.length&&!/预约|需求|运力|计划/.test(task.request))throw error("dataset_missing","尚无实际车次，请先在企业端登记或导入，再发起实绩统计。",409);
      if(service.federation&&task.plan.intent==="statistics")yield* attempt(abort=>service.federation!.refresh(abort));
      const recalled = service.agents.memory.context(task.request), memoryContext = recalled.length ? canonical(recalled) : "";
      if (recalled.length) trace({ agent: "coordinator", phase: 2, kind: "analysis", action: "读取相关长期记忆", detail: `找到${recalled.length}条已启用且未过期的参考记忆。它们帮助理解偏好和历史经验；本轮明确要求与真实计算结果优先。`, protocolDetails: { objective: "跨对话延续用户明确要求，同时保留来源和时效。", operations: ["按问题与标签检索主智能体记忆。", "排除停用和过期内容。", "仅把相关内容随本次委派交给子智能体。"], sections: [{ title: "本轮引用的记忆", data: { memories: recalled } }] } });
      trace({ agent: "coordinator", action: "锁定任务计划", kind: "analysis", detail: `任务类型：${task.plan.intent}；完成前必须获得：${task.plan.requires.join("、")}。本次使用已锁定的模型配置。`, metadata: { intent: task.plan.intent, mode: config.mode, requestDigest: hash(task.request) },
        protocolDetails: { objective: "将用户请求转成确定性执行契约。", operations: ["登记请求 ID、会话 ID 和任务 ID。", "锁定允许工具、参与者和必需产物；统计入口、时间与指标等待专项规划并校验。", "同一会话串行执行，等待已有任务释放会话。"], sections: [{ title: "请求与执行契约", data: { request: task.request, requestId: task.requestId, taskId: id, conversationId: task.conversationId, plan: task.plan, mode: config.mode, model: config.model } }] } });
      let summary: string;
      execution.phase = task.plan.intent === "statistics" ? 2 : task.plan.intent === "verification" ? 8 : 7;
      {
        const tools: Record<string, Tool> = {
          delegate_statistics_planning: { description: "将统计规划委派给独立的统计规划 Agent，接收已校验的统计方案", parameters: emptyParameters, execute: async (args, abort, parentId) => { emptyArgs(args); return service.planStatistics(id, models, withParent(trace, parentId), abort, memoryContext); } },
          compute_statistics: { description: "执行已批准的秘密分享统计，随后自动完成计划要求的证据分析；返回真实统计与分析产物，不能修改方案", parameters: emptyParameters, execute: async (args, abort, parentId) => {
            emptyArgs(args);
            await service.planStatistics(id, models, withParent(trace, parentId), abort, memoryContext);
            execution.phase = 3;
            const scoped = withParent(trace, parentId), result = await service.compute(id, scoped, abort);
            if (!task.plan.requires.includes("analysis")) return result;
            execution.phase = 7;
            trace({ agent: "coordinator", parentId, kind: "analysis", action: "执行统计任务必需分析", detail: "统计已完成；继续核对审计证据并调用模型解释结果，分析通过检查后才返回完整的统计和分析。",
              protocolDetails: { objective: "保证统计任务的必需分析不会因模型提前总结而遗漏。", operations: ["复用当前任务已有统计结果，不重复运行 MPC 或预留查询预算。", "检查当前任务是否已有分析；没有则由园区协调 Agent 调用模型分析。", "等待审计查询和结构化分析提交通过校验，再返回统计与分析。"], sections: [{ title: "执行契约", data: { taskId: id, requires: task.plan.requires, aggregate: true, analysisAlreadyPresent: Boolean(service.store.task(id)?.analysis) } }] } });
            const analysis = await service.investigate(id, models.analyst, scoped, abort, memoryContext);
            return { ...result, analysis };
          } },
          delegate_analysis: { description: "将本轮证据和批准结果委派给独立的运营分析 Agent；统计任务先完成规划与计算", parameters: emptyParameters, execute: async (args, abort, parentId) => { emptyArgs(args); if (task.plan.intent === "statistics") { await service.planStatistics(id, models, withParent(trace, parentId), abort, memoryContext); await service.compute(id, withParent(trace, parentId), abort); } execution.phase = 7; return service.investigate(id, models.analyst, withParent(trace, parentId), abort, memoryContext); } },
          verify_latest_report: { description: "验证当前会话最近签名报告", parameters: emptyParameters, execute: async args => { emptyArgs(args); const result = service.verifyReport(service.latestReport(task.conversationId)); service.store.update(id, { verification: result }); return result; } },
          identity_status: { description: "读取公开登记身份状态", parameters: emptyParameters, execute: async args => { emptyArgs(args); return service.security.nodes(); } },
        };
        Object.assign(tools, service.memoryAndHistoryTools(task));
        const common = ["identity_status", "get_park_overview", "search_memory", "search_task_history", ...(explicitMemoryRequest(task.request) ? ["remember_memory"] : [])];
        const allowed = [...common, ...(task.plan.intent === "statistics" ? ["delegate_statistics_planning", "compute_statistics", "delegate_analysis"] : task.plan.intent === "investigation" ? ["delegate_analysis"] : task.plan.intent === "verification" ? ["verify_latest_report"] : [])];
        for (const name of Object.keys(tools)) if (!allowed.includes(name)) delete tools[name];
        // Only completed public messages enter cross-turn context; no tool internals or credentials.
        const history = service.store.messages(task.conversationId).filter(message => message.taskId !== id).map(message => ({ role: message.role, content: redact(message.content, config.apiKey).slice(0, 4000) }));
        summary = yield* attempt(abort => service.agents.execute(task, "coordinator", config, "协调任务与最终总结", { taskId: id, intent: task.plan.intent }, trace, abort,
          () => Effect.runPromise(runAgent(config, `${task.request}\n\n固定任务类型：${task.plan.intent}。统计任务先调用 delegate_statistics_planning 委派规划，再调用 compute_statistics；后者执行真实计算并委派运营分析 Agent 完成必需分析，一并返回两类产物。直接调用 compute_statistics 也会先完成必要规划。仅做调查时使用 delegate_analysis。子智能体各自使用独立上下文、工具权限及本轮锁定的模型。不要重复委派已有产物。请根据实际返回结果总结；产物齐全后系统自动签名发布报告，无需验证旧报告。用户明确要求记住信息时可调用 remember_memory，其他情况不能自行写入用户偏好。`, history, tools, trace, abort, "coordinator", service.modelDiagnostic(id), { memoryContext, requestTimeoutMs: service.config.modelTimeout }), { signal: abort })));
      }
      yield* Effect.try({ try: () => {
        execution.phase = 8;
        if (signal.aborted) throw error("cancelled", "任务已取消。", 409);
        const current = service.store.task(id)!;
        for (const required of current.plan.requires) {
          if (required === "aggregate" && !current.result || required === "analysis" && !current.analysis || required === "verification" && !current.verification || required === "explanation" && !summary.trim()) throw error("contract_incomplete", `任务缺少计划要求的产物：${required}。`, 422);
        }
        if (explicitMemoryRequest(current.request) && service.agents.memory.settings().enabled && !service.agents.memory.list().items.some(item => item.sourceTaskId === id && item.source === "user_request")) throw error("memory_not_saved", "本轮明确要求记住的信息尚未实际保存，不能仅凭模型回答确认完成。", 422);
        const auditState = service.audit.verify(); if (!auditState.valid) throw error("audit_invalid", "发布前审计验证失败。", 403);
        trace({ agent: "coordinator", action: "任务产物与审计链校验", kind: "security", protocol: "执行契约 / SHA-256 审计链", detail: "所有必需产物已到齐，审计链验证通过，进入报告发布。",
          protocolDetails: { objective: "防止只有模型文字而没有真实产物的成功报告。", operations: ["逐项核对计划 requires。", "验证审计事件顺序、前驱摘要、哈希及签名。"], sections: [{ title: "发布前状态", data: { requires: current.plan.requires, aggregate: Boolean(current.result), analysis: Boolean(current.analysis), verification: Boolean(current.verification), audit: auditState } }], checks: [{ name: "必需产物", status: "passed" }, { name: "审计链", status: "passed" }] } });
        const payload: JsonObject = { type: "collaboration-report-v2", taskId: id, requestId: current.requestId, requestDigest: hash(current.request), plan: current.plan, mode: current.mode,
          summary, result: current.result ?? null, analysis: current.analysis ?? null, verification: current.verification ?? null, at: Date.now(), explanationSource: "model-generated interpretation" };
        const report = service.security.sign("report", payload);
        trace({ agent: "report", action: "报告规范化与签名", kind: "report", protocol: "RFC 8785 JCS / Ed25519", detail: "使用 report 身份的 Ed25519 私钥对规范化报告负载签名。",
          protocolDetails: { objective: "让报告内容、任务和请求摘要可以独立验证。", operations: ["组装包含真实聚合结果与分析结论的报告。", "JCS 序列化负载。", "Ed25519 签署规范化原文。"], sections: signingSections(service.security, report) }, privateDetails: { sections: identityPrivate(service.security, "report") } });
        const verification = service.verifyReport(report); if (!verification.valid) throw error("report_invalid", verification.reason, 403);
        trace({ agent: "report", action: "报告签名与任务绑定复核", kind: "security", protocol: "Ed25519 / SHA-256", detail: verification.reason,
          protocolDetails: { objective: "在发布前独立复核报告。", operations: ["核对登记 report 公钥并验签。", "比较 taskId、requestId、requestDigest 及 plan 摘要。"], sections: [{ title: "校验结果", data: verification }, { title: "任务绑定", data: { taskId: id, requestId: current.requestId, requestDigest: hash(current.request), planDigest: hash(current.plan), signature: report.signature } }], checks: [{ name: "签名与任务绑定", status: "passed" }] } });
        const reportBox = seal(report, service.security.storageKey(), `report:${id}`);
        if (canonical(unseal(reportBox, service.security.storageKey(), `report:${id}`)) !== canonical(report)) throw error("report_storage", "报告认证加密校验失败。", 500);
        trace({ agent: "report", action: "报告认证加密与回读", kind: "report", protocol: "AES-256-GCM", detail: "以任务专属 AAD 加密完整签名报告，实际解密回读与原报告完全一致。",
          protocolDetails: { objective: "保护报告在本机持久化时的机密性及完整性。", operations: ["生成 12 字节随机 nonce。", "使用本机 256 位存储密钥及 report:taskId 作为 AAD。", "生成密文和 16 字节认证标签。", "验证标签、解密并比较规范化报告。"], sections: [{ title: "加密参数", data: { algorithm: "AES-256-GCM", aad: `report:${id}`, nonce: reportBox.nonce, tag: reportBox.tag, encoding: "base64url" } }], checks: [{ name: "认证解密与原文一致", status: "passed" }] },
          privateDetails: { sections: [{ title: "AES-256 存储密钥（hex）", data: service.security.storageKey().toString("hex") }, { title: "完整报告密文封装", data: reportBox }, { title: "加密前签名报告", data: report }] } });
        const event = service.audit.append("report_published", { taskId: id, reportDigest: hash(report.payload) });
        trace({ agent: "report", action: "发布报告与完成对话", kind: "report", detail: "审计已记录发布事件，随后在同一 SQLite 事务中保存加密报告和任务完成状态，向页面推送完成事件。", evidenceIds: [event.id], metadata: { reportDigest: hash(report.payload) },
          protocolDetails: { objective: "交付可下载和复验的签名报告。", operations: ["追加 report_published 审计事件。", "原子保存任务完成状态与加密报告。", "经 SSE 推送公开步骤和总结，页面单独加载完整协议材料。"], sections: [{ title: "交付位置", data: { taskId: id, report: `/api/reports/${id}/download`, evidenceId: event.id, reportDigest: hash(report.payload) } }] } });
        const completed = service.store.update(id, { status: "completed", summary: redact(summary, config.apiKey) }, "task.completed", reportBox);
        try { const memory = service.agents.memory.capture(completed); if (memory) service.logs.operation("agent.memory_captured", { agent: "coordinator", taskId: id, memoryId: memory.id }); } catch (cause) { service.logs.operation("agent.memory_capture_failed", { taskId: id, code: asError(cause).code }, "warn"); }
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
    await this.mpc.close(); this.authorizationService.close(); this.stopLogging(); this.store.close(); this.unlock();
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
