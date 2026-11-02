import { CARRIER_BINDINGS, MAX_PARK_VISITS, PARK_EVENT_FIELDS, PARK_TIME_LABELS, isParkEntrance, isPlateNumber, normalizePlateNumber, plateNumberError, parseParkTimestamp, shanghaiTimestamp, type ParkVisit } from "@vectra/shared";
export const visitTimeFields = [...PARK_EVENT_FIELDS, "appointmentStart", "appointmentEnd"] as const;
export type VisitDraft = { key: string; sourceVehicleId?: string; visitId: string; carrierId: string; vehicleId: string; road: string; distanceKm: string | number; energyKwh: string | number } & Record<typeof visitTimeFields[number], string>;
export function emptyVisit(carrierId: string, vehicleId = "", road = ""): VisitDraft {
  return { key: crypto.randomUUID(), visitId: crypto.randomUUID(), carrierId, vehicleId, road, ...Object.fromEntries(visitTimeFields.map(field => [field, ""])), distanceKm: "", energyKwh: "" } as VisitDraft;
}
export function visitDraft(value: ParkVisit): VisitDraft {
  const draft: VisitDraft = { ...emptyVisit(value.carrierId, isPlateNumber(value.vehicleId) ? normalizePlateNumber(value.vehicleId) : "", value.road), ...(!isPlateNumber(value.vehicleId) ? { sourceVehicleId: value.vehicleId } : {}), visitId: value.visitId, distanceKm: value.distanceKm ?? "", energyKwh: value.energyKwh ?? "" };
  for (const field of visitTimeFields) if (value[field] !== undefined) {
    const at = parseParkTimestamp(value[field]);
    if (!Number.isFinite(at)) throw new Error(PARK_TIME_LABELS[field] + "不是有效时间，请核对日期与时区。");
    draft[field] = shanghaiTimestamp(at).slice(0, 23);
  }
  return draft;
}
export function importedVisitDrafts(value: unknown): VisitDraft[] {
  if (!Array.isArray(value) || value.length > MAX_PARK_VISITS) throw new Error("文件须为完整车次数组，最多" + MAX_PARK_VISITS + "个车次。");
  return value.map((row, index) => {
    const prefix = "第" + (index + 1) + "条记录：";
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => !["visitId", "carrierId", "vehicleId", "road", ...visitTimeFields, "distanceKm", "energyKwh"].includes(key))) throw new Error(prefix + "格式不符合车次示例。");
    if (typeof row.visitId !== "string" || !row.visitId.trim() || !CARRIER_BINDINGS.some(c => c.id === row.carrierId) || !isParkEntrance(row.road) || row.arrivedAt === undefined) throw new Error(prefix + "请提供车次编号、车牌号、所属承运商、固定入口与到达时间。");
    const problem = plateNumberError(row.vehicleId); if (problem) throw new Error(prefix + problem);
    for (const field of ["distanceKm", "energyKwh"]) if (row[field] !== undefined && (typeof row[field] !== "number" || !Number.isFinite(row[field]))) throw new Error(prefix + "里程与电耗应为数值，未知时请省略。");
    try { return visitDraft(row as ParkVisit); } catch (cause) { throw new Error(prefix + (cause instanceof Error ? cause.message : String(cause))); }
  });
}
export function visitPayload(rows: VisitDraft[]) {
  return rows.map((row, index) => {
    if (!row.visitId.trim() || !row.vehicleId.trim() || !row.road.trim() || !row.arrivedAt) throw new Error("第" + (index + 1) + "个车次缺少车次编号、车牌号、入口或到达时间。");
    const problem = plateNumberError(row.vehicleId); if (problem) throw new Error("第" + (index + 1) + "个车次：" + problem);
    const result: Record<string, unknown> = { visitId: row.visitId.trim(), carrierId: row.carrierId, vehicleId: normalizePlateNumber(row.vehicleId), road: row.road.trim() };
    for (const field of visitTimeFields) if (row[field]) result[field] = row[field];
    for (const field of ["distanceKm", "energyKwh"] as const) if (String(row[field]).trim()) {
      const value = Number(row[field]); if (!Number.isFinite(value)) throw new Error("第" + (index + 1) + "个车次的里程或电耗不是有效数字。"); result[field] = value;
    }
    return result;
  });
}
