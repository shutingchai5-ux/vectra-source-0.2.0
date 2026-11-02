import { CARRIER_BINDINGS, defaultParkSettings, type ParkSettings } from "./park";
import { ROLE_NAMES, LEGACY_ROLE_OWNERS } from "./terms";

export const LLM_AGENT_IDS = ["coordinator", "planner", "analyst"] as const;
export type LlmAgentId = typeof LLM_AGENT_IDS[number];
export const isLlmAgentId = (value: unknown): value is LlmAgentId => LLM_AGENT_IDS.some(id => id === value);
export const REGISTERED_IDENTITIES = [...LLM_AGENT_IDS, "rsu", "report", ...CARRIER_BINDINGS.map(c => c.participant)] as const;
export type RegisteredIdentity = typeof REGISTERED_IDENTITIES[number];
export const IDENTITY_LEVELS = [
  { level: 1, title: "一级 · 主智能体", description: "请求受理、长期记忆、任务委派与最终交付" },
  { level: 2, title: "二级 · 专项协作", description: "子智能体执行规划与分析；承运商协作节点完成隐私计算" },
  { level: 3, title: "三级 · 安全与交付", description: "独立授权与报告签名" },
] as const;
export interface IdentityProfile { displayName: string; displayCode: string; role: string; level: 1 | 2 | 3; duties: string[]; usesLlm: boolean }
export const agentDisplayName = (name: string) => `${name.trim().replace(/(?:\s*Agent)+$/i, "").trim() || "协作"} Agent`;
export function identityProfile(id: string, settings: ParkSettings = defaultParkSettings()): IdentityProfile | undefined {
  if (id === "coordinator") return { displayName: ROLE_NAMES.coordinator, displayCode: id, usesLlm: true, role: "主智能体 · 委派与交付", level: 1, duties: ["理解用户请求，检索与维护长期记忆", "向统计规划 Agent 和运营分析 Agent 委派受限任务", "签署批准任务、调度三方计算并复核最终交付"] };
  if (id === "planner") return { displayName: ROLE_NAMES.planner, displayCode: id, usesLlm: true, role: "子智能体 · 统计规划", level: 2, duties: ["接收主智能体签署的规划任务", "根据公开目录明确入口、时间、指标和车次口径", "提交结构化统计方案；不访问原始车辆数据，不持有长期记忆"] };
  if (id === "analyst") return { displayName: ROLE_NAMES.analyst, displayCode: id, usesLlm: true, role: "子智能体 · 证据与运营分析", level: 2, duties: ["接收主智能体签署的分析任务", "查询批准统计和审计证据，区分事实、假设和建议", "提交可核对的分析结论；不执行车辆数据修改，不持有长期记忆"] };
  if (id === "rsu") return { displayName: ROLE_NAMES.rsu, displayCode: id, usesLlm: false, role: "任务接入与安全授权", level: 3, duties: ["认证园区协调 Agent 与授权消息", "检查任务签名、范围和有效期", "防重放与签署授权回执"] };
  if (id === "report") return { displayName: ROLE_NAMES.report, displayCode: id, usesLlm: false, role: "报告签名与交付", level: 3, duties: ["整理已完成任务的报告", "签署报告并复核任务绑定", "认证加密、保存与交付报告"] };
  const binding = CARRIER_BINDINGS.find(c => c.participant === id);
  if (!binding) return undefined;
  const carrier = settings.carriers.find(c => c.id === binding.id);
  return { displayName: `${carrier?.name ?? defaultParkSettings().carriers.find(c => c.id === binding.id)!.name}协作节点`, displayCode: binding.id, usesLlm: false, role: "承运商数据与隐私计算", level: 2, duties: ["仅处理本承运商的车次快照", "计算本地指标并交换秘密份额", ...(id === "carrier-a" ? ["重构批准统计并签署三方输出"] : ["提交聚合份额并确认交付"])] };
}

/** Internal components run under an existing registered principal, not a new identity. */
const componentOwners: Record<string, RegisteredIdentity> = {
  ...LEGACY_ROLE_OWNERS,
  ...Object.fromEntries(Object.entries(ROLE_NAMES).map(([id, name]) => [name, id as RegisteredIdentity])),
  security: "coordinator", mpc: "coordinator", authorization: "rsu",
};
export function registeredIdentityFor(value: string): RegisteredIdentity | undefined {
  if (REGISTERED_IDENTITIES.includes(value as RegisteredIdentity)) return value as RegisteredIdentity;
  return CARRIER_BINDINGS.find(c => c.id === value)?.participant ?? (Object.hasOwn(componentOwners, value) ? componentOwners[value] : undefined);
}
