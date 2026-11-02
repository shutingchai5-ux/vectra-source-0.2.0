import type { MetricSpec, StatisticsQuery, RoadStatistics, DataCatalog } from "./statistics";
import type { ParkSettings, CarrierId } from "./park";

export const JOURNEY_STAGES = [
  { field: "dispatchWaitMinutes", label: "承运商待发", start: "dispatchReadyAt", end: "dispatchedAt" },
  { field: "transportMinutes", label: "运输在途", start: "dispatchedAt", end: "offsiteArrivedAt" },
  { field: "offsiteWaitMinutes", label: "园外等候", start: "offsiteArrivedAt", end: "arrivedAt" },
  { field: "queueMinutes", label: "入口排队", start: "arrivedAt", end: "gateStartedAt" },
  { field: "gateMinutes", label: "入园核验", start: "gateStartedAt", end: "enteredAt" },
  { field: "yardTransitMinutes", label: "园内转运", start: "enteredAt", end: "readyAt" },
  { field: "yardWaitMinutes", label: "待作业", start: "readyAt", end: "serviceStartedAt" },
  { field: "serviceMinutes", label: "实际作业", start: "serviceStartedAt", end: "serviceEndedAt" },
  { field: "departureWaitMinutes", label: "作业后待离园", start: "serviceEndedAt", end: "departedAt" },
] as const;
export function bottleneckMetrics(): MetricSpec[] {
  return [
    ...JOURNEY_STAGES.map(stage => ({ label: stage.label + "平均时长", operation: "mean" as const, field: stage.field })),
    ...JOURNEY_STAGES.map(stage => ({ label: stage.label + "完整链路均值", operation: "mean" as const, field: stage.field,
      filter: { field: "completeJourney" as const, op: "eq" as const, value: 1 } })),
    { label: "完整链路车次", operation: "count", filter: { field: "completeJourney", op: "eq", value: 1 } },
    { label: "端到端平均时长", operation: "mean", field: "endToEndMinutes", filter: { field: "completeJourney", op: "eq", value: 1 } },
  ];
}
export function summarizeBottleneck(group: RoadStatistics) {
  const metric = (label: string) => group.metrics.find(item => item.label === label);
  const complete = metric("完整链路车次")?.value ?? 0;
  const total = metric("端到端平均时长")?.value ?? null;
  const stages = JOURNEY_STAGES.map(stage => {
    const observed = metric(stage.label + "平均时长"), common = metric(stage.label + "完整链路均值");
    return { ...stage, observed: observed?.value ?? null, validSamples: observed?.validSamples ?? 0,
      comparable: common?.value ?? null, share: total && common?.value !== null && common?.value !== undefined ? common.value / total * 100 : null };
  });
  const ranking = [...stages].filter(stage => stage.comparable !== null && stage.comparable > 0).sort((a, b) => b.comparable! - a.comparable!);
  const leaders = ranking.filter(stage => stage.comparable === ranking[0]?.comparable).map(stage => stage.label);
  return { complete, total, stages, ranking, leaders, missingStages: stages.filter(stage => !stage.validSamples).map(stage => stage.label) };
}

export const RESERVATION_SLOT_MINUTES = 30;
export const RESERVATION_SLOT_MS = RESERVATION_SLOT_MINUTES * 60_000;
export const RESERVATION_FIELDS = ["expectedTrips", "availableTrips", "requiredWorkMinutes"] as const;
export const RESERVATION_FIELD_LABELS = { expectedTrips: "预计到园车次", availableTrips: "可投入运输车次", requiredWorkMinutes: "预计作业量" } as const;
export interface ReservationSlot { carrierId: CarrierId; road: string; slotStart: number; expectedTrips: number; availableTrips: number; requiredWorkMinutes: number }
export interface CapacitySlot { road: string; slotStart: number; entryCapacity: number; serviceCapacityMinutes: number }
export interface CapacityWindow { road: string; slotStart: number; slotEnd: number; entryCapacity: number | null; serviceCapacityMinutes: number | null; coveredSlots: number; expectedSlots: number }
export interface ReservationContext { slotMinutes: 30; capacities: CapacityWindow[] }
export interface ReservationCatalog extends DataCatalog {
  dataset: "reservation_plans"; settings: ParkSettings; slotMinutes: 30; capacitySlots: CapacitySlot[]; planCount: number;
}
export interface ReservationSnapshot { version: string; catalog: ReservationCatalog; slots: ReservationSlot[] }
export interface ReservationVersion { version: string; updatedAt: number; rowCount: number }
export const reservationMetrics = (): MetricSpec[] => [
  { label: "预计到园车次", operation: "sum", field: "expectedTrips" },
  { label: "可投入运输车次", operation: "sum", field: "availableTrips" },
  { label: "预计作业量", operation: "sum", field: "requiredWorkMinutes" },
];
/** The same frames and half-open start-time selection are used for inputs and capacity. */
export function statisticsFrames(query: StatisticsQuery): Array<{ road: string; start: number; end: number }> {
  if (query.dataset !== "reservation_plans" && !(query.dataset === "carrier_business" && query.domain !== "haulage")) return query.roads.map(road => ({ road, start: query.start, end: query.end }));
  const duration = query.bucketMinutes! * 60_000, anchor = -8 * 3600_000;
  if (!(duration > 0)) throw new Error("预约统计缺少有效时间粒度");
  const frames: Array<{ road: string; start: number; end: number }> = [];
  for (const road of query.roads) for (let at = Math.floor((query.start - anchor) / duration) * duration + anchor; at < query.end; at += duration)
    frames.push({ road, start: Math.max(at, query.start), end: Math.min(at + duration, query.end) });
  return frames;
}
export function reservationContextFor(capacities: CapacitySlot[], query: StatisticsQuery): ReservationContext {
  return { slotMinutes: 30, capacities: statisticsFrames(query).map(frame => {
    const selected = capacities.filter(slot => slot.road === frame.road && slot.slotStart >= frame.start && slot.slotStart < frame.end);
    const expectedSlots = Math.max(0, Math.ceil(frame.end / RESERVATION_SLOT_MS) - Math.ceil(frame.start / RESERVATION_SLOT_MS));
    const complete = expectedSlots > 0 && selected.length === expectedSlots;
    return { road: frame.road, slotStart: frame.start, slotEnd: frame.end, coveredSlots: selected.length, expectedSlots,
      entryCapacity: complete ? selected.reduce((sum, slot) => sum + slot.entryCapacity, 0) : null,
      serviceCapacityMinutes: complete ? selected.reduce((sum, slot) => sum + slot.serviceCapacityMinutes, 0) : null };
  }) };
}
export interface CoordinationRow {
  road: string; start: number; end: number; expectedTrips: number; availableTrips: number; requiredWorkMinutes: number;
  entryCapacity: number | null; serviceCapacityMinutes: number | null; recommendedTrips: number | null;
  transportGap: number; entryGap: number | null; workGapMinutes: number | null; unarrangedTrips: number | null;
  reasons: string[]; inputMissing: boolean;
}
export type CoordinationResult = ReturnType<typeof coordinateReservations>;
export function coordinateReservations(groups: RoadStatistics[], context: ReservationContext) {
  const rows: CoordinationRow[] = groups.map(group => {
    const sum = (field: string) => group.metrics.find(metric => metric.label === field)?.value;
    const expected = sum("预计到园车次"), available = sum("可投入运输车次"), work = sum("预计作业量");
    const start = group.slotStart!, end = group.slotEnd!;
    const capacity = context.capacities.find(slot => slot.road === group.road && slot.slotStart === start && slot.slotEnd === end);
    const configured = !!capacity && capacity.expectedSlots > 0 && capacity.coveredSlots === capacity.expectedSlots;
    const entryCapacity = configured ? capacity.entryCapacity : null;
    const serviceCapacityMinutes = configured ? capacity.serviceCapacityMinutes : null;
    const expectedTrips = expected ?? 0, availableTrips = available ?? 0, requiredWorkMinutes = work ?? 0;
    const selectedSlots = Math.max(0, Math.ceil(end / RESERVATION_SLOT_MS) - Math.ceil(start / RESERVATION_SLOT_MS));
    const inputMissing = expected == null || available == null || work == null || group.planCoverage?.contributingCarriers !== 3 || group.planCoverage?.declaredSlots !== selectedSlots * 3;
    const transportGap = Math.max(0, expectedTrips - availableTrips);
    const entryGap = entryCapacity === null ? null : Math.max(0, expectedTrips - entryCapacity);
    const workGapMinutes = serviceCapacityMinutes === null ? null : Math.max(0, requiredWorkMinutes - serviceCapacityMinutes);
    const workLimit = expectedTrips && requiredWorkMinutes ? Math.floor(serviceCapacityMinutes! / (requiredWorkMinutes / expectedTrips)) : expectedTrips;
    const recommendedTrips = inputMissing || !configured ? null : Math.max(0, Math.min(expectedTrips, availableTrips, entryCapacity!, workLimit));
    const reasons = [...(inputMissing ? ["该时段未收到完整需求与运力申报"] : []), ...(!configured ? ["园区容量尚未完整配置"] : []),
      ...(transportGap ? ["运输运力不足"] : []), ...(entryGap ? ["入口接纳额度不足"] : []), ...(workGapMinutes ? ["作业资源不足"] : [])];
    return { road: group.road, start, end, expectedTrips, availableTrips, requiredWorkMinutes, entryCapacity, serviceCapacityMinutes,
      recommendedTrips, transportGap, entryGap, workGapMinutes, unarrangedTrips: recommendedTrips === null ? null : expectedTrips - recommendedTrips, reasons, inputMissing };
  });
  // Suggestions consume remaining budgets once. No reservation or actual trip is modified.
  const remaining = rows.map(row => ({ transport: Math.max(0, row.availableTrips - row.expectedTrips),
    entry: row.entryCapacity === null ? 0 : Math.max(0, row.entryCapacity - row.expectedTrips),
    work: row.serviceCapacityMinutes === null ? 0 : Math.max(0, row.serviceCapacityMinutes - row.requiredWorkMinutes) }));
  const suggestions: Array<{ road: string; from: number; to: number; trips: number; workMinutes: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    const source = rows[i]; let pending = source.unarrangedTrips ?? 0;
    if (!pending || !source.expectedTrips || !source.requiredWorkMinutes) continue;
    const perTrip = source.requiredWorkMinutes / source.expectedTrips;
    for (let j = i + 1; j < rows.length && pending; j++) {
      const target = rows[j], capacity = remaining[j];
      if (target.road !== source.road || target.start < source.end || target.inputMissing || target.recommendedTrips === null) continue;
      const trips = Math.min(pending, capacity.transport, capacity.entry, Math.floor(capacity.work / perTrip));
      if (!trips) continue;
      suggestions.push({ road: source.road, from: source.start, to: target.start, trips, workMinutes: trips * perTrip });
      pending -= trips; capacity.transport -= trips; capacity.entry -= trips; capacity.work -= trips * perTrip;
    }
  }
  return { rows, suggestions };
}
