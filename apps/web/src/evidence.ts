import type { AuditEvent } from "@vectra/shared";
import { actorLabel, intentLabels } from "./conversation";

export const evidenceCategories = [
  { id: "task", label: "任务执行", description: "任务的创建、停止与取消", marker: "01" },
  { id: "data", label: "数据管理", description: "车辆数据导入与数据版本", marker: "02" },
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
    case "task_created": return { category: "task", title: "任务已受理", summary: `已创建${intentLabels[String(data.intent)] ?? "协作任务"}，后续进展请查看关联事件。`, outcome: "recorded", status: "已受理" };
    case "task_failed": return data.code === "cancelled"
      ? { category: "task", title: "任务已取消", summary: "该任务已停止执行，取消记录保留在审计链中。", outcome: "cancelled", status: "已取消" }
      : { category: "task", title: "任务未完成", summary: `任务停止，错误代码：${String(data.code ?? "未记录")}。可分析此事件并核对同一任务的前序记录。`, outcome: "failed", status: "执行失败" };
    case "telemetry_imported": return { category: "data", title: "车辆数据已导入", summary: `${count(data.roadCount)} 个路段 · ${count(data.vehicleCount)} 辆车 · ${count(data.sampleCount)} 条采样记录。`, outcome: "recorded", status: "已导入" };
    case "task_authorized": return { category: "security", title: "任务请求已获授权", summary: "已通过网关的身份、签名、策略与防重放校验；后续计算及交付状态见关联事件。", outcome: "passed", status: "授权通过" };
    case "request_rejected": return { category: "security", title: "接入请求被拒绝", summary: `${String(data.layer ?? "接入层")} 拒绝了请求，代码：${String(data.code ?? "未记录")}。拒绝记录本身不能确定行为动机。`, outcome: "rejected", status: "请求拒绝" };
    case "mpc_started": return { category: "computation", title: "隐私计算已发起", summary: "已开始调度 MPC；本条记录表示开始执行，计算结果见后续统计事件。", outcome: "recorded", status: "已发起" };
    case "statistics_completed": return { category: "computation", title: "批准的统计已完成", summary: `已将联合统计结果记入审计链，计算节点数：${count(data.participantCount)}。完整任务的交付状态请继续核对。`, outcome: "passed", status: "计算完成" };
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
      ...identities, ...identities.map(actorLabel), JSON.stringify(event.details), event.hash, event.prevHash].join(" ");
    return text.toLocaleLowerCase().includes(query);
  }).sort((a, b) => b.id - a.id);
}
