import { MAX_WINDOW_MS, PARK_TIME_LABELS, isParkEntrance, normalizePlateNumber, parseParkTimestamp, plateNumberError, type VehicleState } from "@vectra/shared";
import type { VisitDraft } from "./visit-drafts";

export function admissionIssues(draft: VisitDraft, knownVehicle: VehicleState | undefined, mode: "known" | "temporary", currentTime: boolean, now = Date.now()): string[] {
  const issues: string[] = [], problem = plateNumberError(draft.vehicleId);
  if (mode === "known" && !knownVehicle?.profiled) issues.push("请选择本承运商已保存档案的车辆，或切换为临时车辆登记。");
  if (problem) issues.push(problem);
  if (!isParkEntrance(draft.road)) issues.push("请选择本次实际入园入口。");
  const enteredAt = currentTime ? now : parseParkTimestamp(draft.enteredAt);
  if (!Number.isFinite(enteredAt) || enteredAt < 0 || enteredAt > now) issues.push("补录入园时间须为非未来的有效上海时间。");
  const arrivedAt = draft.arrivedAt ? parseParkTimestamp(draft.arrivedAt) : enteredAt;
  for (const field of ["dispatchReadyAt", "dispatchedAt", "offsiteArrivedAt", "arrivedAt", "gateStartedAt", "appointmentStart", "appointmentEnd"] as const) if (draft[field]) {
    const at = parseParkTimestamp(draft[field]);
    if (!Number.isFinite(at) || at < 0 || !field.startsWith("appointment") && at > now) issues.push(PARK_TIME_LABELS[field] + "须为有效时间，实际事件不能在未来。");
  }
  if (Number.isFinite(arrivedAt) && Number.isFinite(enteredAt) && (arrivedAt > enteredAt || enteredAt - arrivedAt > MAX_WINDOW_MS)) issues.push("到达时间不能晚于入园时间，单个车次跨度最多31天。");
  if (draft.gateStartedAt) { const gateAt = parseParkTimestamp(draft.gateStartedAt); if (gateAt < arrivedAt || gateAt > enteredAt) issues.push("开始核验时间须位于到达与入园之间。"); }
  let previous = -1;
  for (const field of ["dispatchReadyAt", "dispatchedAt", "offsiteArrivedAt", "arrivedAt"] as const) {
    const at = field === "arrivedAt" ? arrivedAt : draft[field] ? parseParkTimestamp(draft[field]) : undefined;
    if (at === undefined) continue;
    if (at < previous) issues.push("请按备车、发车、园外集结、到达入口的实际顺序填写时间。");
    if (enteredAt - at > MAX_WINDOW_MS) issues.push("完整跨企业链路跨度最多31天。");
    previous = at;
  }
  if (!!draft.appointmentStart !== !!draft.appointmentEnd) issues.push("预约开始与结束时间需要成对填写，未知时两项均留空。");
  if (draft.appointmentStart && draft.appointmentEnd) {
    const start = parseParkTimestamp(draft.appointmentStart), end = parseParkTimestamp(draft.appointmentEnd);
    if (start >= end || end - start > MAX_WINDOW_MS || Math.abs(start - arrivedAt) > MAX_WINDOW_MS) issues.push("预约开始须早于结束，且与本次车次相距不超过31天。");
  }
  return [...new Set(issues)];
}

export function admissionPayload(draft: VisitDraft, currentTime: boolean): Record<string, unknown> {
  return { visitId: draft.visitId, vehicleId: normalizePlateNumber(draft.vehicleId), road: draft.road,
    ...(!currentTime ? { enteredAt: draft.enteredAt } : {}),
    ...Object.fromEntries((["dispatchReadyAt", "dispatchedAt", "offsiteArrivedAt", "arrivedAt", "gateStartedAt", "appointmentStart", "appointmentEnd"] as const).filter(field => !!draft[field]).map(field => [field, draft[field]])) };
}

export function queueIssues(draft: VisitDraft, knownVehicle: VehicleState | undefined, mode: "known" | "temporary", currentTime: boolean, now = Date.now()): string[] {
  // The current time is a validation bound here; an entry event is never created or submitted.
  const issues = admissionIssues({ ...draft, arrivedAt: currentTime ? "" : draft.arrivedAt, enteredAt: "", gateStartedAt: "" }, knownVehicle, mode, true, now);
  if (!currentTime && !draft.arrivedAt) issues.push("请填写实际到达入口时间，或选择使用当前上海时间。");
  return issues;
}

export function queuePayload(draft: VisitDraft, currentTime: boolean): Record<string, unknown> {
  const payload = admissionPayload(draft, true);
  delete payload.gateStartedAt;
  if (currentTime) delete payload.arrivedAt;
  else payload.arrivedAt = draft.arrivedAt;
  return payload;
}
