import type { ProtocolMaterials, ProtocolSection, Step } from "@vectra/shared";
import { shanghaiTime, PARK_ENTRANCES, PARK_FIELD_LABELS, PARK_TIME_LABELS, type ParkSettings } from "@vectra/shared";
import { currentParkSettings, registeredIdentities } from "./park-state";
import { IDENTITY_LEVELS, registeredIdentityFor, normalizeSystemTerms } from "@vectra/shared";
import { expandSecurityNames } from "./security-language";
import { explainStep } from "./step-explanations";

export interface Actor {
  id: string; name: string; role: string; icon: "car" | "compass" | "search" | "tower" | "shield" | "compute" | "report" | "model";
  tone: string; badge?: string; level: 1 | 2 | 3; registered: boolean; usesLlm: boolean; code: string;
}
export const ACTOR_LEVELS = IDENTITY_LEVELS;
const appearances: Record<string, { icon: Actor["icon"]; tone: string; badge?: string }> = {
  coordinator: { icon: "compass", tone: "teal" }, rsu: { icon: "shield", tone: "rose" }, report: { icon: "report", tone: "amber" },
  planner: { icon: "compass", tone: "blue", badge: "规" }, analyst: { icon: "search", tone: "purple", badge: "析" },
  "carrier-a": { icon: "compute", tone: "blue", badge: "A" }, "carrier-b": { icon: "compute", tone: "orange", badge: "B" }, "carrier-c": { icon: "compute", tone: "purple", badge: "C" },
};
export function actorFor(value: string, _settings?: ParkSettings): Actor {
  const id = registeredIdentityFor(value), node = registeredIdentities.value.find(node => node.id === id);
  if (!node || !id) return { id: value, name: "\u672A\u767B\u8BB0\u8EAB\u4EFD", role: "\u6765\u6E90\u5F85\u6838\u5BF9", icon: "model", tone: "slate", level: 2, registered: false, usesLlm: false, code: "" };
  return { id, name: node.displayName!, role: node.role, level: node.level!, registered: true, usesLlm: !!node.usesLlm, code: id, ...appearances[id] };
}
export function stepActor(step: Step, settings?: ParkSettings): Actor { return actorFor(step.agent, settings); }
export const actorLabel = (value: string, settings?: ParkSettings) => actorFor(value, settings).name;
export function participantGroups(steps: readonly Step[], settings?: ParkSettings) {
  const participants = new Map<string, Actor>();
  for (const step of steps) { const actor = stepActor(step, settings); if (actor.registered) participants.set(actor.id, actor); }
  return ACTOR_LEVELS.map(level => ({ ...level, actors: [...participants.values()].filter(actor => actor.level === level.level) })).filter(group => group.actors.length);
}
export function friendlyText(value: string, settings?: ParkSettings): string {
  const park = settings ?? currentParkSettings.value;
  const names = [...registeredIdentities.value.map(node => node.displayName ?? ""), park.name, ...park.carriers.map(carrier => carrier.name)].filter(Boolean);
  const protectedNames = new Set(names), escape = (name: string) => name.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  const pattern = new RegExp("(?<![A-Za-z0-9_/-])(?:" + [...names.map(escape), "carrier-[abc]", "coordinator", "rsu", "report", "analyst", "security", "mpc"].sort((a, b) => b.length - a.length).join("|") + ")(?![A-Za-z0-9_/-])", "g");
  const opaque = /(\u0060{3}[\s\S]*?\u0060{3}|\u0060[^\u0060\n]*\u0060|!?\[[^\]]*\]\([^)]+\)|https?:\/\/[^\s<>]+|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g;
  return value.split(opaque).map((part, index) => index % 2 ? part : normalizeSystemTerms(part, names).replace(pattern, match => protectedNames.has(match) ? match : actorLabel(match, settings))).join("");
}

export const intentLabels: Record<string, string> = { statistics: "三家承运商联合运营分析", investigation: "安全证据调查", verification: "验证报告签名", explain: "解释与追问" };
export const toolLabels: Record<string, string> = {
  delegate_statistics_planning: "委派统计规划", delegate_analysis: "委派运营与证据分析", get_park_overview: "查看园区数据概况", search_memory: "检索主智能体长期记忆", remember_memory: "记住用户明确要求", search_task_history: "查找历史任务",
  compute_statistics: "执行承运商联合统计", investigate: "委托安全证据调查", query_events: "查询真实审计证据",
  submit_analysis: "提交分析结论", verify_latest_report: "验证最近一份报告", identity_status: "查询参与者身份",
  submit_statistics_plan: "提交并校验统计方案",
};
const actionLabels: Record<string, string> = {
  "锁定任务计划": "确认本次任务与完成条件", "模型请求": "向模型咨询下一步", "模型响应": "模型给出了本轮建议",
  "锁定查询时间范围": "确认本次查询的上海时间范围", "批准统计方案": "确认要统计的路段与指标",
  "生成并验证签名任务": "给统计任务签名并复核", "预留隐私查询预算": "检查本次查询的频率限制",
  "封装签名授权请求": "准备发给安全授权服务的授权请求", "建立双向 TLS 会话": "与安全授权服务相互认证并加密连接", "认证任务交换": "申请授权并核对安全授权服务回复",
  "任务与本地输入认证": "读取本承运商车次并计算真实时长", "生成秘密分享多项式": "将各项统计量拆成秘密份额",
  "接收并确认输入份额": "接收另一个承运商协作节点的输入份额", "接收并确认聚合份额": "接收用于还原结果的聚合份额",
  "发送输入份额并核对回执": "发送一份秘密份额并确认送达", "计算本地聚合份额": "汇总我收到的三份数据",
  "发送聚合份额并确认": "将聚合份额交给指定重构节点", "重构总和并签署批准输出": "还原统计结果并签名确认",
  "三方秘密分享计算": "组织三家承运商完成隐私统计", "三方进程端点就绪": "三个承运商协作节点已就绪，可以开始通信",
  "复核三方输出签名与绑定": "确认计算结果来自本次真实任务", "报告规范化与签名": "为本次结果签发报告",
  "报告认证加密与回读": "加密报告并读回核对", "报告签名与任务绑定复核": "复查报告签名与任务是否一致",
  "发布报告与完成对话": "交付签名报告", "证据分析完成": "给出有证据支持的分析结论",
  "接收节点端点表": "确认其他承运商协作节点的通信位置", "协议完成": "结束本承运商协作节点的协作",
  "证据调查委托": "核对本轮运营结果与证据", "执行统计任务必需分析": "继续补齐本轮证据分析", "任务产物与审计链校验": "交付前检查结果与审计记录",
};
export const actionLabel = (action: string) => toolLabels[action] ?? actionLabels[action] ?? friendlyText(action);
export const checkLabel = (name: string) => ({ taskId: "属于本次任务", requestDigest: "对应同一份请求", messageId: "对应本次发送的消息", "accepted=true": "安全授权服务已接受请求", "安全授权服务签名": "回复确实来自安全授权服务", "TLS 1.3 及登记身份": "加密连接与对方身份匹配", "任务签名与策略": "任务签名与允许范围符合要求", "预算预留": "查询间隔符合限制", "任务授权及输入认证": "任务授权与本地数据检查完成", "登记身份": "发送方是登记节点", "任务绑定": "消息属于本次任务", "去重": "没有重复提交", "有限域范围": "份额数值在允许范围内", "确认回执绑定": "接收确认属于本次任务", "三方齐全及输出范围": "三个承运商协作节点齐全且结果范围有效", "唯一合法输出及完整绑定": "结果唯一且对应本次请求", "分析结构及证据引用": "分析内容齐全且引用实际证据", "必需产物": "本轮所需内容齐全", "审计链": "审计记录完整性符合检查", "签名与任务绑定": "签名有效且报告属于本次任务", "认证解密与原文一致": "报告解密读回与原文一致" } as Record<string, string>)[name] ?? expandSecurityNames(friendlyText(name));
export const userFacingError = (message: string) => friendlyText(message.replace(/(模型服务返回 HTTP 5\d{2}。)请检查接口格式、地址、模型能力和凭据。/, "$1模型服务商暂时无法完成请求，请稍后重试。").replace(/任务缺少计划要求的产物：([^。]+)。?/, (_match, required: string) => `本轮尚未取得所需的${required.replace(/aggregate|analysis|verification|explanation/g, value => ({ aggregate: "统计结果", analysis: "证据分析", verification: "报告验证结果", explanation: "结果说明" } as Record<string, string>)[value])}，因此无法完成交付。`));

export function sectionPresentation(title: string) {
  let label = friendlyText(title), description = "这里保留本次实际记录，可切换原始数据或复制原文进行核对。";
  if (title.includes("私钥")) description = "私钥用于证明本承运商协作节点身份或生成数字签名。这里显示本机实际材料，便于对照本步的签名与身份检查。";
  else if (title.includes("证书")) description = "证书把公钥与登记身份关联起来。核对证书来源、有效期和指纹，才能确认连接的对象。";
  else if (title.includes("规范化待签名字节")) { label = "用于生成签名的统一格式原文"; description = "JCS 让签名与验证使用相同的内容表示。下方保留实际参与签名的原文。"; }
  else if (title.includes("载荷 SHA-256 摘要")) { label = "签名内容的摘要指纹"; description = "SHA-256 为内容生成固定长度的指纹，方便比较内容是否一致；它不能代替签名或加密。"; }
  else if (title.startsWith("签名信封")) { label = "签署者、已签名内容与数字签名"; description = "把签署者、完整内容和签名放在一起，便于用登记公钥检查来源及签署后的改动。"; }
  else if (title === "实际多项式与全部份额") { label = "本承运商协作节点如何拆分统计量，以及生成的全部份额"; description = "Shamir 为各项统计量使用独立随机数生成份额。这里展示本机完整材料，供你对照计算公式。"; }
  else if (title === "车辆完整原始输入") { label = "本承运商协作节点本次选中的车辆原始记录"; description = "这些是按批准路段和时段选中的实际记录；它们在节点内参与计算，不作为模型上下文。"; }
  else if (title === "公开计算约定") { label = "各承运商协作节点共同采用的计算规则"; description = "统一数值编码、指标顺序与节点完成要求，使各方处理同一个统计问题。"; }
  else if (title === "实际返回值") { label = "本次服务实际返回的结果"; description = "下面是执行服务返回的公开数据。是否成功应结合本步状态和实际校验结论判断。"; }
  else if (["调用请求", "工具调用", "请求与执行契约"].includes(title)) { label = title === "请求与执行契约" ? "你的问题与本轮交付要求" : "本次请求执行的服务与范围"; description = "查看这次请求了什么，以及允许使用哪些参数；实际执行仍需要通过系统检查。"; }
  else if (title.includes("会话") || title.includes("协商")) description = "这里记录实际建立的通信连接，可核对通信身份、证书指纹和使用的加密方式。";
  else if (title.includes("回执")) description = "这是接收方的确认信息。发送方会检查是否接受，以及回复是否属于同一任务。";
  else if (title.includes("完整重构")) description = "这些数值用于把节点份额还原为批准的统计结果，可与本步计算公式和最终指标对照。";
  else if (title === "原始执行记录") description = "保留系统最初记录的操作名称、处理说明和检查结果，用于与上方易读说明对照。";
  return { title: expandSecurityNames(friendlyText(label)), description };
}

export const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const fieldLabels: Record<string, string> = {
  reservationContext: "本次冻结的园区容量", expectedTrips: "预计到园车次", availableTrips: "可投入运输车次", requiredWorkMinutes: "预计作业量（分钟）", entryCapacity: "入口接纳额度", serviceCapacityMinutes: "可用作业量（分钟）", slotStart: "时段开始", slotEnd: "时段结束", bucketMinutes: "分组分钟数", planCoverage: "预约申报覆盖", declaredSlots: "已申报半小时时段数", recommendedTrips: "建议安排车次", inputMissing: "申报是否不完整", coordination: "预约协同结果", suggestions: "人工错峰建议",
  ...PARK_FIELD_LABELS, ...PARK_TIME_LABELS, visitId: "车次编号", carrierId: "承运商标识", visitCount: "车次数", completedCount: "已离园车次", parkContext: "本次园区与承运商", settings: "园区设置", carriers: "三家承运商", dataUpdatedAt: "数据快照更新时间", dataset: "数据类型", cohort: "车次选取口径", coverage: "本次车次覆盖", visits: "车次", completed: "已完成车次", unfinished: "未离园车次", contributingCarriers: "实际有数据的承运商数",
  taskId: "任务编号", requestId: "请求编号", conversationId: "会话编号", requestDigest: "请求内容指纹", planDigest: "统计方案指纹", reportDigest: "报告内容指纹",
  request: "用户请求", plan: "任务计划", intent: "任务类型", requires: "必须完成", mode: "执行模式", model: "使用模型", provider: "模型提供方",
  road: "入口", speed: "原始速度", averageSpeed: "平均速度", windowSeconds: "任务窗口", participantCount: "承运商协作节点数", participants: "参与承运商协作节点", vehicleCount: "车辆数", sampleCount: "采样记录数", nodes: "承运商数据分布",
  roads: "查询入口", start: "起始时间", end: "结束时间", timeZone: "统计时区", statistics: "统计方案", query: "批准查询", metrics: "统计指标", groups: "分入口结果", datasetVersion: "数据版本", operation: "聚合方式", field: "统计字段", denominatorField: "分母字段", multiplier: "倍率", filter: "筛选条件", op: "比较关系", label: "指标名称", unit: "单位", validSamples: "有效样本数", distanceKm: "里程增量", energyKwh: "能耗增量", vehicleId: "车辆标识（园区使用车牌号）", recordedAt: "采样时间", records: "原始记录", dimensions: "向量维数", components: "向量各分量", totals: "重构后的充分统计量",
  scale: "定点编码倍率", prime: "有限域素数", degree: "多项式次数", mathematicalThreshold: "数学重构门限", executionRequiresAllThree: "是否要求三方全部完成",
  secret: "编码后的本地统计量", coefficient: "本次随机系数", shares: "分发的秘密份额", share: "秘密份额值", value: "实际数值", values: "还原结果使用的份额",
  x: "份额横坐标", ownX: "本承运商协作节点的份额横坐标", incoming: "收到的输入份额", aggregate: "本承运商协作节点的聚合份额", inputs: "输入数量", coefficients: "重构结果使用的权重", sum: "还原的总和", denominator: "均值换算除数",
  recipient: "接收方", sender: "发送方", from: "发送方", to: "接收方", message: "协议消息", messageId: "消息编号", accepted: "是否接受", rejected: "是否拒绝",
  type: "消息类型", protocol: "使用协议", signer: "签署者", signature: "数字签名", payload: "签名载荷", signingPublicKey: "签名公钥", fingerprint: "证书指纹",
  id: "编号", role: "身份角色", certificateExpires: "证书到期时间", peerFingerprint256: "对端证书指纹", peerSubject: "对端证书主体", peerIssuer: "对端证书签发者",
  displayName: "登记名称", displayCode: "登记编号", usesLlm: "是否调用大模型", level: "职责层级", duties: "登记职责", plateNumber: "车牌号", vehicleType: "车辆类型", energyType: "动力类型", capacityTonnes: "额定载重（吨）", allowedRoads: "登记通行道路", profiled: "是否已建档", entranceRoads: "园区入口道路",
  peerValidFrom: "对端证书生效时间", peerValidTo: "对端证书到期时间", authorized: "证书认证是否通过", cipher: "协商的密码套件", ephemeralKey: "临时密钥交换信息", note: "说明",
  method: "请求方法", url: "请求地址", headers: "请求头", messages: "消息列表", content: "消息正文", tools: "可用工具", tool_calls: "工具调用", tool_call_id: "对应工具调用", tool_choice: "工具选择方式", parallel_tool_calls: "是否允许并行调用",
  function: "工具定义", name: "名称", arguments: "实际参数", parameters: "参数约束", description: "用途说明", properties: "字段定义", required: "必填字段", additionalProperties: "是否允许额外字段", schema: "参数规则",
  httpStatus: "HTTP 状态码", status: "执行状态", durationMs: "耗时", finishReason: "模型结束原因", usage: "用量统计", prompt_tokens: "输入 Token 数", completion_tokens: "输出 Token 数", total_tokens: "总 Token 数",
  attempts: "本轮模型请求尝试次数", retryCount: "本轮重试次数", retryScheduled: "是否安排再次尝试", providerCode: "服务商错误代码", providerType: "服务商错误类型", providerParam: "相关请求参数", providerRequestId: "服务商请求编号",
  facts: "确认事实", possibleCauses: "可能原因", recommendations: "处理建议", uncertainties: "尚不能确定", evidenceIds: "引用的证据编号", events: "查询到的审计事件", baseline: "确定性分析基线",
  kind: "事件类型", details: "事件详情", claimedIdentity: "声明身份", verifiedIdentity: "已验证身份", prevHash: "前一事件哈希", hash: "当前事件哈希", head: "链末端哈希", check: "已执行校验", layer: "处理层级", roadCount: "入口数量",
  result: "计算结果", analysis: "证据分析", verification: "验签结果", valid: "是否验证通过", reason: "校验说明", code: "错误代码", error: "失败信息",
  nonce: "本次加密随机数", tag: "用于检查改动的认证标签", aad: "关联认证信息 AAD", ciphertext: "完整密文", version: "封装版本", algorithm: "加密算法", encoding: "字节编码方式",
  at: "记录时间", createdAt: "创建时间", expiresAt: "过期时间", updatedAt: "更新时间", timestamp: "时间", source: "数据来源", actualTimeFilter: "是否进行了实际时间筛选",
  cooldownSeconds: "查询冷却时间", reconstruction: "重构要求", threshold: "多项式次数 t", round: "调用轮次", toolResultCount: "已完成工具数", toolCallId: "工具调用编号",
  pid: "进程编号", host: "监听地址", port: "监听端口", count: "事件数量", audit: "审计链状态", verifiedAt: "验证时间", receivedInputShares: "已收到输入份额数",
  objective: "本步目标", operations: "记录的处理步骤", checks: "记录的检查结果", originalAction: "原始操作名称", deepThinking: "是否请求深度思考", thinkingProtocol: "模型兼容方式", resolvedByServer: "时间是否由服务端统一确定", analysisAlreadyPresent: "本轮此前是否已有分析", index: "统计分量编号",
};
export const fieldLabel = (key: string) => expandSecurityNames(fieldLabels[key] ?? (key.startsWith("carrier-") ? actorLabel(key) : key));
export function readableValue(value: unknown, key = ""): string {
  if (value === null || value === undefined) return "未提供";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") {
    if (["at", "createdAt", "updatedAt", "expiresAt", "verifiedAt", "timestamp", "start", "end", "slotStart", "slotEnd", "recordedAt", "dataUpdatedAt", ...Object.keys(PARK_TIME_LABELS)].includes(key)) return shanghaiTime(value);
    if (["speed", "averageSpeed"].includes(key)) return `${value} km/h`;
    if (["windowSeconds", "cooldownSeconds"].includes(key)) return `${value} 秒`;
    if (key === "durationMs") return value < 1000 ? `${value} 毫秒` : `${(value / 1000).toFixed(2)} 秒`;
    if (key.endsWith("Minutes")) return `${value} 分钟`;
  }
  if (typeof value === "string") {
    if (key === "request") return value;
    if (["protocol", "algorithm", "check"].includes(key)) return expandSecurityNames(value);
    if (["at", "createdAt", "updatedAt", "expiresAt", "verifiedAt", "timestamp", "certificateExpires", "peerValidFrom", "peerValidTo"].includes(key) && Number.isFinite(Date.parse(value))) return shanghaiTime(new Date(value));
    if (registeredIdentityFor(value)) return actorLabel(value);
    if (key === "intent") return intentLabels[value] ?? value;
    if (key === "name") return toolLabels[value] ?? value;
    if (["field", "denominatorField"].includes(key)) return PARK_FIELD_LABELS[value as keyof typeof PARK_FIELD_LABELS] ?? fieldLabels[value] ?? value;
    if (key === "dataset" && value === "park_visits") return "园区进出园车次";
    if (key === "dataset" && value === "reservation_plans") return "预约需求与运力申报计划";
    if (key === "analysis" && value === "bottleneck") return "跨企业等待与周转瓶颈分析";
    if (key === "cohort") return value === "arrivals" ? "按到达时间选取车次" : value === "departures" ? "按离园时间选取车次" : value;
    if (key === "carrierId") return currentParkSettings.value.carriers.find(c => c.id === value)?.name ?? value;
    if (key === "requires") return ({ aggregate: "真实统计结果", analysis: "证据分析结论", verification: "报告验证结果", explanation: "结果说明" } as Record<string, string>)[value] ?? value;
    const words: Record<string, string> = { llm: "模型协作", mean_speed: "平均速度", share: "输入份额", aggregate: "聚合份额", "task.request": "任务授权请求", user: "用户", assistant: "模型回复", tool: "服务返回结果", system: "本轮处理要求", auto: "自动选择", stop: "回答结束", tool_calls: "建议执行服务", completed: "已完成", running: "进行中", failed: "未完成", statistics: "承运商联合运营统计", explanation: "结果说明" };
    return words[value] ?? value;
  }
  return String(value);
}

export interface Fact { label: string; value: string }
export interface StepPresentation { title: string; body: string; facts: Fact[]; rows: { label: string; value: string }[]; rowTitle: string; nextActions: string[]; structuredAnswer?: unknown; guide: ReturnType<typeof explainStep> }
export function presentStep(step: Step, materials?: ProtocolMaterials, settings?: ParkSettings): StepPresentation {
  const sections = [...(step.protocolDetails?.sections ?? []), ...(materials?.sections ?? [])];
  const find = (title: string) => record(sections.find(section => section.title === title)?.data);
  const facts: Fact[] = [], rows: StepPresentation["rows"] = [];
  const add = (label: string, value: unknown, key = "") => { if (value !== undefined && value !== null) facts.push({ label, value: readableValue(value, key) }); };
  const guide = explainStep(step);
  let body = guide.current, rowTitle = "本次实际数据", nextActions: string[] = [], structuredAnswer: unknown;
  if (step.status === "failed" || step.status === "cancelled") body = `${guide.current}\n\n${userFacingError(step.detail)}`;
  const response = find("公开响应字段");
  const contract = find("请求与执行契约"), plan = record(contract?.plan);
  if (step.action === "锁定任务计划" && plan && step.status === "completed") {
    const outputs: Record<string, string> = { aggregate: "真实统计结果", analysis: "证据分析结论", verification: "报告验证结果", explanation: "结果说明" };
    const requires = Array.isArray(plan.requires) ? plan.requires.map(value => outputs[String(value)] ?? String(value)).join("、") : "计划要求的产物";
    body = `本次按“${intentLabels[String(plan.intent)] ?? plan.intent}”处理。需要取得${requires}后，才会签名并交付报告。`;
    add("本轮需要交付", requires);
    if (plan.intent === "statistics") {
      const approved = record(plan.statistics);
      if (approved) {
        add("已批准入口", Array.isArray(approved.roads) ? approved.roads.join("、") : undefined);
        add("起始时间", approved.start, "start"); add("结束时间", approved.end, "end");
      } else {
        // Old admission snapshots contain all entrances and a 60-second placeholder. They are not approved scope.
        const request = typeof contract?.request === "string" ? contract.request : "";
        const mentioned = PARK_ENTRANCES.filter(entrance => request.includes(entrance));
        if (mentioned.length) add("提问中的入口", mentioned.join("、"));
        add("执行入口", "待统计规划 Agent 确认"); add("统计时间", "待统计规划 Agent 确认");
        body += "\n\n入口、时间和指标仍在规划，实际执行范围以下面的“批准统计方案”为准。";
      }
      add("承运商协作节点", Array.isArray(plan.participants) ? `${plan.participants.length} 个` : undefined);
    }
  }
  if (step.action === "模型响应" && response && !["failed", "cancelled"].includes(step.status)) {
    if (typeof response.content === "string" && response.content.trim()) {
      try {
        const decoded: unknown = JSON.parse(response.content.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1"));
        structuredAnswer = decoded !== null && typeof decoded === "object" ? decoded : undefined;
        body = structuredAnswer ? "模型的公开回复已整理为以下内容。涉及执行或校验的结论，仍以本轮实际记录为准。" : response.content;
      } catch { body = response.content; }
    } else body = "模型根据当前进度提出了操作建议。系统会先检查这些建议，再决定是否允许执行。";
    if (Array.isArray(response.tool_calls)) nextActions = response.tool_calls.map(call => record(record(call)?.function)?.name).filter((name): name is string => typeof name === "string").map(actionLabel);
    const status = find("响应状态、用量与耗时");
    if (status) { add("响应耗时", status.durationMs, "durationMs"); add("模型", status.model); }
  }
  if (step.kind === "tool") {
    const result = sections.find(section => section.title === "实际返回值")?.data, data = record(result);
    if (step.status === "completed") {
      body = ({ compute_statistics: data?.analysis ? "本轮联合统计与所需证据分析已返回。园区协调 Agent 会继续检查交付内容，再准备签名报告。" : "本轮联合统计服务已返回，具体结果和剩余处理步骤见下方。", investigate: "园区协调 Agent 已返回事实、可能原因、建议与证据引用。", query_events: "已读取通过审计完整性检查的事件，可作为后续分析依据。", submit_analysis: "分析内容和引用的事件编号已通过检查。", identity_status: "已取得各参与者的公开登记身份；实际通信身份仍需结合对应认证记录核对。", verify_latest_report: "报告签名校验已返回，是否通过请查看实际校验结论。", submit_statistics_plan: "统计方案已通过系统检查，后续按相同的路段、时间和指标执行。" } as Record<string, string>)[step.action] ?? body;
    }
    if (data) {
      add("平均速度", data.averageSpeed, "averageSpeed"); add("承运商协作节点数", data.participantCount); add("引用证据", Array.isArray(data.evidenceIds) ? `${data.evidenceIds.length} 条` : undefined);
      add("查询到的事件", Array.isArray(data.events) ? `${data.events.length} 条` : undefined);
      if (typeof data.valid === "boolean") add("验签结果", data.valid ? "通过" : "未通过");
    }
  }
  const parkInput = find("本承运商完整车次与本地派生值");
  if (parkInput) { add("本承运商选中车次", Array.isArray(parkInput.visits) ? `${parkInput.visits.length} 个` : undefined); add("数据处理", "在本承运商节点计算事件时长，缺少端点不补零"); }
  const input = find("车辆完整原始输入");
  if (input) { add("样本示例速度", input.speed, "speed"); add("所在路段", input.road); add("本承运商协作节点选中记录", Array.isArray(input.records) ? `${input.records.length} 条` : undefined); add("数据来源", Array.isArray(input.records) ? "本承运商协作节点加密时序记录" : "历史预置读数"); }
  const polynomial = find("实际多项式与全部份额");
  if (polynomial) {
    add("原始速度", polynomial.speed, "speed"); add(Array.isArray(polynomial.components) ? "示例分量编码值" : "编码后的速度", polynomial.secret);
    add("统计量向量", Array.isArray(polynomial.components) ? `${polynomial.components.length} 个分量，每项独立随机分享` : undefined);
    rowTitle = Array.isArray(polynomial.components) ? "示例分量的三份秘密份额（完整向量在详情中）" : "这三份数据分别交给谁";
    if (Array.isArray(polynomial.shares)) for (const entry of polynomial.shares) { const row = record(entry); if (row) rows.push({ label: `${actorLabel(String(row.recipient), settings)} · 第 ${row.x} 份`, value: String(row.value) }); }
  }
  const numerical = find("聚合运算实际数值");
  if (numerical) {
    rowTitle = "本承运商协作节点收到的三个来源的份额";
    if (Array.isArray(numerical.incoming)) for (const entry of numerical.incoming) { const row = record(entry); if (row) rows.push({ label: actorLabel(String(row.from), settings), value: Array.isArray(row.values) ? `${row.values.length} 项向量份额，完整数值见详情` : String(row.value) }); }
    add("本地聚合份额", Array.isArray(numerical.aggregate) ? `${numerical.aggregate.length} 项统计量份额` : numerical.aggregate);
  }
  const transcript = find("发送的完整份额消息") ?? find("收到的完整协议消息");
  const packet = record(transcript?.message) ?? find("完整聚合份额消息");
  if (packet) { add(packet.type === "aggregate" ? "本次聚合份额" : "本次秘密份额", Array.isArray(packet.shares) ? `${packet.shares.length} 项向量份额` : packet.share); add("份额横坐标", transcript?.x); }
  const receipt = find("实际接收回执") ?? find("发送的回执") ?? find("实际回执");
  if (receipt && typeof receipt.accepted === "boolean") add("对方回执", receipt.accepted ? "已接收" : "未接受");
  const reconstructed = find("完整重构数值");
  if (reconstructed) { add("平均速度", reconstructed.averageSpeed, "averageSpeed"); add("重构总和", reconstructed.sum); add("分入口结果", Array.isArray(reconstructed.groups) ? `${reconstructed.groups.length} 个入口` : undefined); }
  const output = find("批准输出");
  if (output) { add("平均速度", output.averageSpeed, "averageSpeed"); add("承运商协作节点数", output.participantCount); }
  if (step.action === "模型请求") { add("第几轮", step.metadata.round); add("使用模型", step.metadata.model); add("已完成的服务调用", step.metadata.toolResultCount); }
  for (const title of ["统计方案", "批准的时间范围"]) {
    const data = find(title);
    if (data) { add(data.dataset === "park_visits" ? "查询入口" : "采样路段", Array.isArray(data.roads) ? data.roads.join("、") : undefined); add("起始时间", data.start, "start"); add("结束时间", data.end, "end"); add("统计指标", Array.isArray(data.metrics) ? data.metrics.map(metric => record(metric)?.label).filter(Boolean).join("、") : undefined); }
  }
  const publicSections: ProtocolSection[] = step.protocolDetails?.sections ?? [];
  for (const section of publicSections) {
    const data = record(section.data);
    if (section.title === "实际分析结论" && data && Array.isArray(data.evidenceIds)) add("引用证据", `${data.evidenceIds.length} 条`);
    if (section.title === "本次策略" && data) { add("统计入口", data.road); add("任务窗口", data.windowSeconds, "windowSeconds"); add("查询冷却", data.cooldownSeconds, "cooldownSeconds"); }
  }
  const title = guide.known ? actionLabel(step.action) : ({ model: "模型协助记录", tool: "服务执行记录", security: "安全检查记录", exchange: "参与者之间的协作消息", mpc: "节点计算记录", report: "报告处理记录", analysis: "本轮规划与分析记录" })[step.kind];
  return { title: step.kind === "model" && step.action === "模型响应" && step.status === "running" ? "模型正在回复" : title, body, facts, rows, rowTitle, nextActions, structuredAnswer, guide };
}
