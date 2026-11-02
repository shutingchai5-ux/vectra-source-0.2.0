import type { AuditEvent } from "@vectra/shared";
import { actorLabel, friendlyText, intentLabels } from "./conversation";

export const evidenceCategories = [
  { id: "task", label: "任务执行", description: "任务的创建、停止与取消", marker: "01" },
  { id: "data", label: "数据管理", description: "承运商、园区车次与数据版本", marker: "02" },
  { id: "security", label: "身份与安全", description: "请求授权与接入拒绝", marker: "03" },
  { id: "computation", label: "隐私计算", description: "MPC 调度与统计结果", marker: "04" },
  { id: "report", label: "报告交付", description: "签名报告的发布记录", marker: "05" },
  { id: "system", label: "系统运行", description: "服务启动与运行信息", marker: "06" },
  { id: "other", label: "其他记录", description: "历史或尚未归类的事件", marker: "07" },
] as const;

export type EvidenceCategory = typeof evidenceCategories[number]["id"];
type Outcome = "recorded" | "passed" | "rejected" | "failed" | "cancelled";
interface EventDescription { category: EvidenceCategory; title: string; summary: string; outcome: Outcome; status: string }
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? String(value) : "未记录";
export const auditTaskId = (event: AuditEvent) => typeof event.details.taskId === "string" ? event.details.taskId : "";

// Classify recorded event types, rather than interpreting model text as security evidence.
export function describeAuditEvent(event: AuditEvent): EventDescription {
  const data = event.details;
  switch (event.kind) {
    case "park_queue_registered": return { category: "data", title: "车辆排队登记已保存", summary: "已记录到达入口时间，车次处于排队待入园状态。入园需要后续单独确认，入口沿用本次登记。", outcome: "recorded", status: "排队待入园" };
    case "park_admission_confirmed": return { category: "data", title: "车辆入园已确认", summary: "车次已记录实际入园事件，可继续办理开始作业、结束作业与离园。", outcome: "recorded", status: "已入园" };
    case "park_lifecycle_recorded": return { category: "data", title: "车次阶段已更新", summary: "本方车次已保存新的实际生命周期事件，入口与已记录时间继续保留。", outcome: "recorded", status: "已保存" };
    case "reservation_plans_saved": return { category: "data", title: "承运商预约需求与运力已保存", summary: count(data.rowCount) + " 个本方时段已发布新快照。计划不生成实际入园车次，已有报告继续使用原版本。", outcome: "recorded", status: "已保存" };
    case "reservation_capacity_saved": return { category: "data", title: "园区入口与作业容量已保存", summary: count(data.rowCount) + " 个容量时段已发布；后续预约协同使用新版本，历史报告保留原冻结容量。", outcome: "recorded", status: "已保存" };
    case "park_entrances_fixed": return { category: "data", title: "园区四个入口已统一", summary: "已固定东入口、南入口、西入口、北入口，并将明确对应的旧入口名称保存为新版本。原车次、车辆与实际时间保留。", outcome: "recorded", status: "已统一" };
    case "identity_generation_started": return { category: "security", title: "承运商身份已重新签发", summary: "已启用统一的承运商证书与签名身份。旧对话、报告、协议材料和审计已按迁移范围清理，业务数据与模型配置保留。", outcome: "recorded", status: "新身份已启用" };
    case "task_created": return { category: "task", title: "任务已受理", summary: `已创建${intentLabels[String(data.intent)] ?? "协作任务"}，后续进展请查看关联事件。`, outcome: "recorded", status: "已受理" };
    case "task_failed": return data.code === "cancelled"
      ? { category: "task", title: "任务已取消", summary: "该任务已停止执行，取消记录保留在审计链中。", outcome: "cancelled", status: "已取消" }
      : { category: "task", title: "任务未完成", summary: `任务停止，错误代码：${String(data.code ?? "未记录")}。可分析此事件并核对同一任务的前序记录。`, outcome: "failed", status: "执行失败" };
    case "telemetry_imported": return { category: "data", title: "车辆数据已导入", summary: `${count(data.roadCount)} 个路段 · ${count(data.vehicleCount)} 辆车 · ${count(data.sampleCount)} 条采样记录。`, outcome: "recorded", status: "已导入" };
    case "park_visits_imported": return { category: "data", title: "园区车次快照已发布", summary: `${count(data.roadCount)} 条入口道路 · ${count(data.vehicleCount)} 辆车 · ${count(data.visitCount)} 个车次 · ${count(data.completedCount)} 个已离园。`, outcome: "recorded", status: "已导入" };
    case "park_settings_saved": return { category: "data", title: "园区与承运商名称已更新", summary: "三家承运商的固定节点归属保持绑定，新任务使用本次版本，历史签名报告保留原名称。", outcome: "recorded", status: "已保存" };
    case "business_ledger_saved": return { category: "data", title: "本公司经营台账已保存", summary: `已发布新的本方资料版本，共 ${count(data.rowCount)} 条；原始内容留在企业端。`, outcome: "recorded", status: "已保存" };
    case "charging_capacity_saved": return { category: "data", title: "园区充电容量已保存", summary: `已更新 ${count(data.rowCount)} 个接口时段，后续任务将冻结所用版本。`, outcome: "recorded", status: "已保存" };
    case "company_service_started": return { category: "system", title: "企业独立服务已启动", summary: "本公司数据、登录与计算服务已就绪。", outcome: "recorded", status: "已启动" };
    case "carrier_vehicles_saved": return { category: "data", title: "承运商车辆档案已保存", summary: `${count(data.vehicleCount)} 辆车的基础资料与通行道路已更新，进出园车次仍单独管理。`, outcome: "recorded", status: "已保存" };
    case "task_authorized": return { category: "security", title: "任务请求已获授权", summary: "已通过安全授权服务的身份、签名、策略与防重放校验；后续计算及交付状态见关联事件。", outcome: "passed", status: "授权通过" };
    case "request_rejected": return { category: "security", title: "接入请求被拒绝", summary: `${friendlyText(String(data.layer ?? "接入检查"))}拒绝了请求，代码：${String(data.code ?? "未记录")}。拒绝记录本身不能确定行为动机。`, outcome: "rejected", status: "请求拒绝" };
    case "mpc_started": return { category: "computation", title: "隐私计算已发起", summary: "已开始调度 MPC；本条记录表示开始执行，计算结果见后续统计事件。", outcome: "recorded", status: "已发起" };
    case "statistics_completed": return { category: "computation", title: "批准的统计已完成", summary: `已将联合统计结果记入审计链，承运商协作节点数：${count(data.participantCount)}。完整任务的交付状态请继续核对。`, outcome: "passed", status: "计算完成" };
    case "report_published": return { category: "report", title: "报告发布记录", summary: "已将报告摘要记入审计链，可结合关联任务核对报告及交付状态。", outcome: "recorded", status: "已记录" };
    case "service_started": return { category: "system", title: "服务已启动", summary: `服务版本：${String(data.version ?? "未记录")}。`, outcome: "recorded", status: "已启动" };
    default: return { category: "other", title: event.kind === "experiment_completed" ? "历史实验记录" : "其他审计事件", summary: `原始事件类型：${event.kind}。完整内容保留在事件详情中。`, outcome: "recorded", status: "已记录" };
  }
}

export const needsAttention = (event: AuditEvent) => ["failed", "rejected"].includes(describeAuditEvent(event).outcome);
export interface EvidenceFilters { category: EvidenceCategory | "all"; keyword: string; taskId: string; attentionOnly: boolean }

export function filterEvidence(events: readonly AuditEvent[], filters: EvidenceFilters): AuditEvent[] {
  const query = filters.keyword.trim().toLocaleLowerCase();
  return events.filter(event => {
    const view = describeAuditEvent(event);
    if (filters.category !== "all" && view.category !== filters.category) return false;
    if (filters.taskId && auditTaskId(event) !== filters.taskId) return false;
    if (filters.attentionOnly && !needsAttention(event)) return false;
    if (!query) return true;
    const category = evidenceCategories.find(item => item.id === view.category)!;
    const identities = [event.claimedIdentity, event.verifiedIdentity].filter((value): value is string => Boolean(value));
    const text = [`#${event.id}`, event.kind, category.label, view.title, view.summary, view.status,
      ...identities, ...identities.map(id => actorLabel(id)), JSON.stringify(event.details), event.hash, event.prevHash].join(" ");
    return text.toLocaleLowerCase().includes(query);
  }).sort((a, b) => b.id - a.id);
}
