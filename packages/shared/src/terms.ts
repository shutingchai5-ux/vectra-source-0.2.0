/** Canonical product vocabulary. Responsibilities do not create additional actors. */
export const ROLE_NAMES = { coordinator: "园区协调 Agent", planner: "统计规划 Agent", analyst: "运营分析 Agent", rsu: "安全授权服务", report: "签名报告服务" } as const;
export const SYSTEM_TERMS = {
  carrierNode: "承运商协作节点", vehicle: "车辆", vehicleProfile: "车辆档案", visit: "车次",
  entrance: "入口", authorizationReceipt: "授权回执", report: "签名报告", reportsPage: "签名报告",
  protocolMaterials: "完整协议材料", modelService: "模型服务",
  aiChatPage: "AI 对话", vehicleOverviewPage: "园区车辆", carrierVehiclesPage: "承运商工作台",
  parkVisitsPage: "承运商工作台", evidencePage: "证据与审计", modelSettingsPage: "Agent 详情的底层模型",
} as const;
/** Read old records using their registered owner; new records must use the principal ID. */
export const LEGACY_ROLE_OWNERS: Record<string, keyof typeof ROLE_NAMES> = {
  "任务协调器": "coordinator", "协调器": "coordinator", "任务协调 Agent": "coordinator", "信息安全分析 Agent": "analyst",
  "任务管家": "coordinator", "园区协调Agent": "coordinator", "运营分析师": "analyst", "园区运营分析员": "analyst", "安全分析师": "analyst",
  "安全执行层": "coordinator", "执行层": "coordinator", "隐私计算执行器": "coordinator", "执行器": "coordinator", "计算助手": "coordinator", "协调方": "coordinator", "协调端": "coordinator",
  "RSU 安全网关": "rsu", "RSU安全网关": "rsu", "路侧安全网关": "rsu", "路侧网关": "rsu", "安全网关": "rsu", "网关": "rsu", "路侧卫士": "rsu", "安全守卫": "rsu", "路侧单元": "rsu", "RSU": "rsu",
  "报告服务": "report", "报告验证服务": "report", "报告专员": "report",
};
const replacements: Record<string, string> = {
  ...Object.fromEntries(Object.entries(LEGACY_ROLE_OWNERS).map(([label, id]) => [label, ROLE_NAMES[id]])),
  ...Object.fromEntries(Object.values(ROLE_NAMES).map(name => [name, name])),
  "RSU（Roadside Unit，路侧单元）": ROLE_NAMES.rsu,
  "模型网关": "模型服务接口", "自定义网关": "自定义模型服务接口", "API 网关": "模型服务接口", "API网关": "模型服务接口",
  "本机完整实验材料": SYSTEM_TERMS.protocolMaterials, "本机实验材料": SYSTEM_TERMS.protocolMaterials, "完整教学材料": SYSTEM_TERMS.protocolMaterials, "完整实验材料": SYSTEM_TERMS.protocolMaterials, "实验材料": SYSTEM_TERMS.protocolMaterials, "教学材料": SYSTEM_TERMS.protocolMaterials,
  [SYSTEM_TERMS.protocolMaterials]: SYSTEM_TERMS.protocolMaterials, "结果验证": SYSTEM_TERMS.reportsPage,
  "独立计算节点": "独立的承运商协作节点", "计算节点": SYSTEM_TERMS.carrierNode, "参与节点": SYSTEM_TERMS.carrierNode,
  "本节点": "本承运商协作节点", "各节点": "各承运商协作节点", "其他节点": "其他承运商协作节点", "三个节点": "三个承运商协作节点", "三节点": "三个承运商协作节点",
  [SYSTEM_TERMS.carrierNode]: SYSTEM_TERMS.carrierNode,
  "汇总份额": "聚合份额", "协作工作台": "AI 对话",
  "车辆编号": "车牌号",
  "承运商车辆录入": "承运商工作台", "园区与车次": "承运商工作台",
};
const escape = (text: string) => text.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
let cachedKey = "", cachedPattern: RegExp | undefined, cachedWords: Record<string, string> = replacements;
/** Human prose only. Callers must keep code, links, signed data and user input verbatim. */
export function normalizeSystemTerms(text: string, protectedNames: readonly string[] = []): string {
  const names = [...new Set(protectedNames.filter(Boolean))], key = names.join("\0");
  if (!cachedPattern || key !== cachedKey) {
    cachedKey = key; cachedWords = { ...replacements, ...Object.fromEntries(names.map(name => [name, name])) };
    cachedPattern = new RegExp("(?<![A-Za-z0-9_/-])(?:" + Object.keys(cachedWords).sort((a, b) => b.length - a.length).map(escape).join("|") + ")(?![A-Za-z0-9_/-])", "g");
  }
  return text.replace(cachedPattern, match => cachedWords[match]);
}
