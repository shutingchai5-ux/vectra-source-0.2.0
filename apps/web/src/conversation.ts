import type { ProtocolMaterials, ProtocolSection, Step } from "@vectra/shared";
import { shanghaiTime } from "@vectra/shared";
import { expandSecurityNames } from "./security-language";
import { explainStep } from "./step-explanations";

export interface Actor {
  id: string; name: string; role: string; icon: "car" | "compass" | "search" | "tower" | "shield" | "compute" | "report" | "model";
  tone: string; badge?: string;
}
const actors: Actor[] = [
  { id: "coordinator", name: "任务管家", role: "任务协调助手", icon: "compass", tone: "teal" },
  { id: "analyst", name: "安全分析师", role: "安全分析助手", icon: "search", tone: "indigo" },
  { id: "rsu", name: "路侧卫士", role: "路侧安全网关", icon: "tower", tone: "cyan" },
  { id: "security", name: "安全守卫", role: "任务安全检查", icon: "shield", tone: "rose" },
  { id: "mpc", name: "计算助手", role: "隐私计算服务", icon: "compute", tone: "slate" },
  { id: "report", name: "报告专员", role: "签名与报告服务", icon: "report", tone: "amber" },
  { id: "model", name: "模型助手", role: "模型服务", icon: "model", tone: "violet" },
  { id: "vehicle-a", name: "小蓝", role: "计算节点 A", icon: "compute", tone: "blue", badge: "A" },
  { id: "vehicle-b", name: "小橙", role: "计算节点 B", icon: "compute", tone: "orange", badge: "B" },
  { id: "vehicle-c", name: "小紫", role: "计算节点 C", icon: "compute", tone: "purple", badge: "C" },
];
const aliases: Record<string, string> = {
  "任务协调器": "coordinator", "任务协调 Agent": "coordinator", "信息安全分析 Agent": "analyst",
  "统计规划 Agent": "coordinator",
  "RSU 安全网关": "rsu", "安全执行层": "security", "隐私计算执行器": "mpc",
  "报告服务": "report", "报告验证服务": "report", "模型服务": "model", "执行层": "security",
};
export function actorFor(value: string): Actor {
  return actors.find(actor => actor.id === (aliases[value] ?? value)) ?? { id: value, name: value, role: "协作参与者", icon: "model", tone: "slate" };
}
export function stepActor(step: Step): Actor {
  // A received message belongs to the receiving worker's observation. Model replies have their own speaker.
  return actorFor(step.kind === "model" && step.sender === "模型服务" ? "model" : step.agent);
}
export const actorLabel = (value: string) => { const actor = actorFor(value); return actor.badge ? `${actor.name}（${actor.role}）` : actor.name; };
export function friendlyText(value: string): string {
  return value.replace(/vehicle-[abc]|coordinator|信息安全分析 Agent|任务协调 Agent|任务协调器|RSU 安全网关|隐私计算执行器|报告验证服务|安全执行层/g, actorLabel)
    .replace(/(?<![A-Za-z0-9_/-])(?:rsu|mpc|report|analyst|security|model)(?![A-Za-z0-9_/-])/g, actorLabel);
}
export const intentLabels: Record<string, string> = { statistics: "多指标联合统计", investigation: "安全证据调查", verification: "签名报告验证", explain: "解释与追问" };
export const toolLabels: Record<string, string> = {
  compute_statistics: "发起多车辆联合统计", investigate: "委托安全证据调查", query_events: "查询真实审计证据",
  submit_analysis: "提交分析结论", verify_latest_report: "验证最近一份报告", identity_status: "查询参与者身份",
  submit_statistics_plan: "提交并校验统计方案",
};
const actionLabels: Record<string, string> = {
  "锁定任务计划": "确认本次任务与完成条件", "模型请求": "向模型咨询下一步", "模型响应": "模型给出了本轮建议",
  "锁定查询时间范围": "确认本次查询的上海时间范围", "批准统计方案": "确认要统计的路段与指标",
  "生成并验证签名任务": "给统计任务签名并复核", "预留隐私查询预算": "检查本次查询的频率限制",
  "封装签名授权请求": "准备发给安全网关的授权请求", "建立双向 TLS 会话": "与安全网关相互认证并加密连接", "认证任务交换": "申请授权并核对网关回复",
  "任务与本地输入认证": "读取并筛选本节点车辆数据", "生成秘密分享多项式": "将各项统计量拆成秘密份额",
  "接收并确认输入份额": "接收另一个计算节点的输入份额", "接收并确认聚合份额": "接收用于还原结果的汇总份额",
  "发送输入份额并核对回执": "发送一份秘密份额并确认送达", "计算本地聚合份额": "汇总我收到的三份数据",
  "发送聚合份额并确认": "将汇总份额交给小蓝节点", "重构总和并签署批准输出": "还原统计结果并签名确认",
  "三方秘密分享计算": "组织三个节点完成多车辆隐私计算", "三方进程端点就绪": "三个计算节点已就绪，可以开始通信",
  "复核三方输出签名与绑定": "确认计算结果来自本次真实任务", "报告规范化与签名": "为本次结果签发报告",
  "报告认证加密与回读": "加密报告并读回核对", "报告签名与任务绑定复核": "复查报告签名与任务是否一致",
  "发布报告与完成对话": "交付签名报告", "证据分析完成": "给出有证据支持的分析结论",
  "接收节点端点表": "确认其他计算节点的通信位置", "协议完成": "结束本节点的协作",
  "证据调查委托": "请安全分析师核对本轮记录", "执行统计任务必需分析": "继续补齐本轮证据分析", "任务产物与审计链校验": "交付前检查结果与审计记录",
};
export const actionLabel = (action: string) => toolLabels[action] ?? actionLabels[action] ?? friendlyText(action);
export const checkLabel = (name: string) => ({ taskId: "属于本次任务", requestDigest: "对应同一份请求", messageId: "对应本次发送的消息", "accepted=true": "网关已接受请求", "RSU 签名": "回复确实来自安全网关", "TLS 1.3 及登记身份": "加密连接与对方身份匹配", "任务签名与策略": "任务签名与允许范围符合要求", "预算预留": "查询间隔符合限制", "任务授权及输入认证": "任务授权与本地数据检查完成", "登记身份": "发送方是登记节点", "任务绑定": "消息属于本次任务", "去重": "没有重复提交", "有限域范围": "份额数值在允许范围内", "确认回执绑定": "接收确认属于本次任务", "三方齐全及输出范围": "三个节点齐全且结果范围有效", "唯一合法输出及完整绑定": "结果唯一且对应本次请求", "分析结构及证据引用": "分析内容齐全且引用实际证据", "必需产物": "本轮所需内容齐全", "审计链": "审计记录完整性符合检查", "签名与任务绑定": "签名有效且报告属于本次任务", "认证解密与原文一致": "报告解密读回与原文一致" } as Record<string, string>)[name] ?? expandSecurityNames(friendlyText(name));
export const userFacingError = (message: string) => friendlyText(message.replace(/任务缺少计划要求的产物：([^。]+)。?/, (_match, required: string) => `本轮尚未取得所需的${required.replace(/aggregate|analysis|verification|explanation/g, value => ({ aggregate: "统计结果", analysis: "证据分析", verification: "报告验证结果", explanation: "结果说明" } as Record<string, string>)[value])}，因此无法完成交付。`));

export function sectionPresentation(title: string) {
  let label = friendlyText(title), description = "这里保留本次实际记录，可切换原始数据或复制原文进行核对。";
  if (title.includes("私钥")) description = "私钥用于证明本节点身份或生成数字签名。这里显示本机实际材料，便于对照本步的签名与身份检查。";
  else if (title.includes("证书")) description = "证书把公钥与登记身份关联起来。核对证书来源、有效期和指纹，才能确认连接的对象。";
  else if (title.includes("规范化待签名字节")) { label = "用于生成签名的统一格式原文"; description = "JCS 让签名与验证使用相同的内容表示。下方保留实际参与签名的原文。"; }
  else if (title.includes("载荷 SHA-256 摘要")) { label = "签名内容的摘要指纹"; description = "SHA-256 为内容生成固定长度的指纹，方便比较内容是否一致；它不能代替签名或加密。"; }
  else if (title.startsWith("签名信封")) { label = "签署者、已签名内容与数字签名"; description = "把签署者、完整内容和签名放在一起，便于用登记公钥检查来源及签署后的改动。"; }
  else if (title === "实际多项式与全部份额") { label = "本节点如何拆分统计量，以及生成的全部份额"; description = "Shamir 为各项统计量使用独立随机数生成份额。这里展示本机完整材料，供你对照计算公式。"; }
  else if (title === "车辆完整原始输入") { label = "本节点本次选中的车辆原始记录"; description = "这些是按批准路段和时段选中的实际记录；它们在节点内参与计算，不作为模型上下文。"; }
  else if (title === "公开计算约定") { label = "各节点共同采用的计算规则"; description = "统一数值编码、指标顺序与节点完成要求，使各方处理同一个统计问题。"; }
  else if (title === "实际返回值") { label = "本次服务实际返回的结果"; description = "下面是执行服务返回的公开数据。是否成功应结合本步状态和实际校验结论判断。"; }
  else if (["调用请求", "工具调用", "请求与执行契约"].includes(title)) { label = title === "请求与执行契约" ? "你的问题与本轮交付要求" : "本次请求执行的服务与范围"; description = "查看这次请求了什么，以及允许使用哪些参数；实际执行仍需要通过系统检查。"; }
  else if (title.includes("会话") || title.includes("协商")) description = "这里记录实际建立的通信连接，可核对通信身份、证书指纹和使用的加密方式。";
  else if (title.includes("回执")) description = "这是接收方的确认信息。发送方会检查是否接受，以及回复是否属于同一任务。";
  else if (title.includes("完整重构")) description = "这些数值用于把节点份额还原为批准的统计结果，可与本步计算公式和最终指标对照。";
  else if (title === "原始执行记录") description = "保留系统最初记录的操作名称、处理说明和检查结果，用于与上方易读说明对照。";
  return { title: expandSecurityNames(label), description };
}

export const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const fieldLabels: Record<string, string> = {
  taskId: "任务编号", requestId: "请求编号", conversationId: "会话编号", requestDigest: "请求内容指纹", planDigest: "统计方案指纹", reportDigest: "报告内容指纹",
  request: "用户请求", plan: "任务计划", intent: "任务类型", requires: "必须完成", mode: "执行模式", model: "使用模型", provider: "模型提供方",
  road: "路段", speed: "原始速度", averageSpeed: "平均速度", windowSeconds: "任务窗口", participantCount: "计算节点数", participants: "参与计算节点", vehicleCount: "车辆数", sampleCount: "采样记录数", nodes: "计算节点分布",
  roads: "查询路段", start: "起始时间", end: "结束时间", timeZone: "统计时区", statistics: "统计方案", query: "批准查询", metrics: "统计指标", groups: "分路段结果", datasetVersion: "数据版本", operation: "聚合方式", field: "统计字段", denominatorField: "分母字段", multiplier: "倍率", filter: "筛选条件", op: "比较关系", label: "指标名称", unit: "单位", validSamples: "有效样本数", distanceKm: "里程增量", energyKwh: "能耗增量", vehicleId: "车辆编号", recordedAt: "采样时间", records: "原始记录", dimensions: "向量维数", components: "向量各分量", totals: "重构后的充分统计量",
  scale: "定点编码倍率", prime: "有限域素数", degree: "多项式次数", mathematicalThreshold: "数学重构门限", executionRequiresAllThree: "是否要求三方全部完成",
  secret: "编码后的本地统计量", coefficient: "本次随机系数", shares: "分发的秘密份额", share: "秘密份额值", value: "实际数值", values: "还原结果使用的份额",
  x: "份额横坐标", ownX: "本节点的份额横坐标", incoming: "收到的输入份额", aggregate: "本节点的汇总份额", inputs: "输入数量", coefficients: "重构结果使用的权重", sum: "还原的总和", denominator: "均值换算除数",
  recipient: "接收方", sender: "发送方", from: "发送方", to: "接收方", message: "协议消息", messageId: "消息编号", accepted: "是否接受", rejected: "是否拒绝",
  type: "消息类型", protocol: "使用协议", signer: "签署者", signature: "数字签名", payload: "签名载荷", signingPublicKey: "签名公钥", fingerprint: "证书指纹",
  id: "编号", role: "身份角色", certificateExpires: "证书到期时间", peerFingerprint256: "对端证书指纹", peerSubject: "对端证书主体", peerIssuer: "对端证书签发者",
  peerValidFrom: "对端证书生效时间", peerValidTo: "对端证书到期时间", authorized: "证书认证是否通过", cipher: "协商的密码套件", ephemeralKey: "临时密钥交换信息", note: "说明",
  method: "请求方法", url: "请求地址", headers: "请求头", messages: "消息列表", content: "消息正文", tools: "可用工具", tool_calls: "工具调用", tool_call_id: "对应工具调用", tool_choice: "工具选择方式", parallel_tool_calls: "是否允许并行调用",
  function: "工具定义", name: "名称", arguments: "实际参数", parameters: "参数约束", description: "用途说明", properties: "字段定义", required: "必填字段", additionalProperties: "是否允许额外字段", schema: "参数规则",
  httpStatus: "HTTP 状态码", status: "执行状态", durationMs: "耗时", finishReason: "模型结束原因", usage: "用量统计", prompt_tokens: "输入 Token 数", completion_tokens: "输出 Token 数", total_tokens: "总 Token 数",
  facts: "确认事实", possibleCauses: "可能原因", recommendations: "处理建议", uncertainties: "尚不能确定", evidenceIds: "引用的证据编号", events: "查询到的审计事件", baseline: "确定性分析基线",
  kind: "事件类型", details: "事件详情", claimedIdentity: "声明身份", verifiedIdentity: "已验证身份", prevHash: "前一事件哈希", hash: "当前事件哈希", head: "链末端哈希", check: "已执行校验", layer: "处理层级", roadCount: "路段数量",
  result: "计算结果", analysis: "证据分析", verification: "验签结果", valid: "是否验证通过", reason: "校验说明", code: "错误代码", error: "失败信息",
  nonce: "本次加密随机数", tag: "用于检查改动的认证标签", aad: "关联认证信息 AAD", ciphertext: "完整密文", version: "封装版本", algorithm: "加密算法", encoding: "字节编码方式",
  at: "记录时间", createdAt: "创建时间", expiresAt: "过期时间", updatedAt: "更新时间", timestamp: "时间", source: "数据来源", actualTimeFilter: "是否进行了实际时间筛选",
  cooldownSeconds: "查询冷却时间", reconstruction: "重构要求", threshold: "多项式次数 t", round: "调用轮次", toolResultCount: "已完成工具数", toolCallId: "工具调用编号",
  pid: "进程编号", host: "监听地址", port: "监听端口", count: "事件数量", audit: "审计链状态", verifiedAt: "验证时间", receivedInputShares: "已收到输入份额数",
  objective: "本步目标", operations: "记录的处理步骤", checks: "记录的检查结果", originalAction: "原始操作名称", deepThinking: "是否请求深度思考", thinkingProtocol: "模型兼容方式", resolvedByServer: "时间是否由服务端统一确定", analysisAlreadyPresent: "本轮此前是否已有分析", index: "统计分量编号",
};
export const fieldLabel = (key: string) => expandSecurityNames(fieldLabels[key] ?? (key.startsWith("vehicle-") ? actorLabel(key) : key));
export function readableValue(value: unknown, key = ""): string {
  if (value === null || value === undefined) return "未提供";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") {
    if (["at", "createdAt", "updatedAt", "expiresAt", "verifiedAt", "timestamp", "start", "end", "recordedAt"].includes(key)) return shanghaiTime(value);
    if (["speed", "averageSpeed"].includes(key)) return `${value} km/h`;
    if (["windowSeconds", "cooldownSeconds"].includes(key)) return `${value} 秒`;
    if (key === "durationMs") return value < 1000 ? `${value} 毫秒` : `${(value / 1000).toFixed(2)} 秒`;
  }
  if (typeof value === "string") {
    if (["protocol", "algorithm", "check"].includes(key)) return expandSecurityNames(value);
    if (["at", "createdAt", "updatedAt", "expiresAt", "verifiedAt", "timestamp", "certificateExpires", "peerValidFrom", "peerValidTo"].includes(key) && Number.isFinite(Date.parse(value))) return shanghaiTime(new Date(value));
    if (actors.some(actor => actor.id === value) || aliases[value]) return actorLabel(value);
    if (key === "intent") return intentLabels[value] ?? value;
    if (key === "name") return toolLabels[value] ?? value;
    if (key === "requires") return ({ aggregate: "真实统计结果", analysis: "证据分析结论", verification: "报告验证结果", explanation: "结果说明" } as Record<string, string>)[value] ?? value;
    const words: Record<string, string> = { llm: "模型协作", mean_speed: "平均速度", share: "输入份额", aggregate: "汇总份额", "task.request": "任务授权请求", user: "用户", assistant: "模型助手", tool: "服务返回结果", system: "本轮处理要求", auto: "自动选择", stop: "回答结束", tool_calls: "建议执行服务", completed: "已完成", running: "进行中", failed: "未完成", statistics: "多车辆联合统计", explanation: "结果说明" };
    return words[value] ?? value;
  }
  return String(value);
}

export interface Fact { label: string; value: string }
export interface StepPresentation { title: string; body: string; facts: Fact[]; rows: { label: string; value: string }[]; rowTitle: string; nextActions: string[]; structuredAnswer?: unknown; guide: ReturnType<typeof explainStep> }
export function presentStep(step: Step, materials?: ProtocolMaterials): StepPresentation {
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
    if (plan.intent === "statistics") { add("统计路段", plan.road); add("任务窗口", plan.windowSeconds, "windowSeconds"); add("计算节点", Array.isArray(plan.participants) ? `${plan.participants.length} 个` : undefined); }
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
      body = ({ compute_statistics: data?.analysis ? "本轮联合统计与所需证据分析已返回。任务管家会继续检查交付内容，再准备签名报告。" : "本轮联合统计服务已返回，具体结果和剩余处理步骤见下方。", investigate: "安全分析师已返回事实、可能原因、建议与证据引用。", query_events: "已读取通过审计完整性检查的事件，可作为后续分析依据。", submit_analysis: "分析内容和引用的事件编号已通过检查。", identity_status: "已取得各参与者的公开登记身份；实际通信身份仍需结合对应认证记录核对。", verify_latest_report: "报告签名校验已返回，是否通过请查看实际校验结论。", submit_statistics_plan: "统计方案已通过系统检查，后续按相同的路段、时间和指标执行。" } as Record<string, string>)[step.action] ?? body;
    }
    if (data) {
      add("平均速度", data.averageSpeed, "averageSpeed"); add("计算节点数", data.participantCount); add("引用证据", Array.isArray(data.evidenceIds) ? `${data.evidenceIds.length} 条` : undefined);
      add("查询到的事件", Array.isArray(data.events) ? `${data.events.length} 条` : undefined);
      if (typeof data.valid === "boolean") add("验签结果", data.valid ? "通过" : "未通过");
    }
  }
  const input = find("车辆完整原始输入");
  if (input) { add("样本示例速度", input.speed, "speed"); add("所在路段", input.road); add("本节点选中记录", Array.isArray(input.records) ? `${input.records.length} 条` : undefined); add("数据来源", Array.isArray(input.records) ? "本节点加密时序记录" : "历史预置读数"); }
  const polynomial = find("实际多项式与全部份额");
  if (polynomial) {
    add("原始速度", polynomial.speed, "speed"); add(Array.isArray(polynomial.components) ? "示例分量编码值" : "编码后的速度", polynomial.secret);
    add("统计量向量", Array.isArray(polynomial.components) ? `${polynomial.components.length} 个分量，每项独立随机分享` : undefined);
    rowTitle = Array.isArray(polynomial.components) ? "示例分量的三份秘密份额（完整向量在详情中）" : "这三份数据分别交给谁";
    if (Array.isArray(polynomial.shares)) for (const entry of polynomial.shares) { const row = record(entry); if (row) rows.push({ label: `${actorLabel(String(row.recipient))} · 第 ${row.x} 份`, value: String(row.value) }); }
  }
  const numerical = find("聚合运算实际数值");
  if (numerical) {
    rowTitle = "本节点收到的三个来源的份额";
    if (Array.isArray(numerical.incoming)) for (const entry of numerical.incoming) { const row = record(entry); if (row) rows.push({ label: actorLabel(String(row.from)), value: Array.isArray(row.values) ? `${row.values.length} 项向量份额，完整数值见详情` : String(row.value) }); }
    add("本地聚合份额", Array.isArray(numerical.aggregate) ? `${numerical.aggregate.length} 项统计量份额` : numerical.aggregate);
  }
  const transcript = find("发送的完整份额消息") ?? find("收到的完整协议消息");
  const packet = record(transcript?.message) ?? find("完整聚合份额消息");
  if (packet) { add(packet.type === "aggregate" ? "本次聚合份额" : "本次秘密份额", Array.isArray(packet.shares) ? `${packet.shares.length} 项向量份额` : packet.share); add("份额横坐标", transcript?.x); }
  const receipt = find("实际接收回执") ?? find("发送的回执") ?? find("实际回执");
  if (receipt && typeof receipt.accepted === "boolean") add("对方回执", receipt.accepted ? "已接收" : "未接受");
  const reconstructed = find("完整重构数值");
  if (reconstructed) { add("平均速度", reconstructed.averageSpeed, "averageSpeed"); add("重构总和", reconstructed.sum); add("分路段结果", Array.isArray(reconstructed.groups) ? `${reconstructed.groups.length} 个路段` : undefined); }
  const output = find("批准输出");
  if (output) { add("平均速度", output.averageSpeed, "averageSpeed"); add("计算节点数", output.participantCount); }
  if (step.action === "模型请求") { add("第几轮", step.metadata.round); add("使用模型", step.metadata.model); add("已完成的服务调用", step.metadata.toolResultCount); }
  for (const title of ["统计方案", "批准的时间范围"]) {
    const data = find(title);
    if (data) { add("查询路段", Array.isArray(data.roads) ? data.roads.join("、") : undefined); add("起始时间", data.start, "start"); add("结束时间", data.end, "end"); add("统计指标", Array.isArray(data.metrics) ? data.metrics.map(metric => record(metric)?.label).filter(Boolean).join("、") : undefined); }
  }
  const publicSections: ProtocolSection[] = step.protocolDetails?.sections ?? [];
  for (const section of publicSections) {
    const data = record(section.data);
    if (section.title === "实际分析结论" && data && Array.isArray(data.evidenceIds)) add("引用证据", `${data.evidenceIds.length} 条`);
    if (section.title === "本次策略" && data) { add("统计路段", data.road); add("任务窗口", data.windowSeconds, "windowSeconds"); add("查询冷却", data.cooldownSeconds, "cooldownSeconds"); }
  }
  const title = guide.known ? actionLabel(step.action) : ({ model: "模型协助记录", tool: "服务执行记录", security: "安全检查记录", exchange: "参与者之间的协作消息", mpc: "节点计算记录", report: "报告处理记录", analysis: "本轮规划与分析记录" })[step.kind];
  return { title: step.kind === "model" && step.action === "模型响应" && step.status === "running" ? "模型正在回复" : title, body, facts, rows, rowTitle, nextActions, structuredAnswer, guide };
}
