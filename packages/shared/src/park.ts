import type { DataCatalog } from "./statistics";
/** Stable organisation identities. Vehicle IDs never choose an organisation by hashing. */
export const CARRIER_BINDINGS = [
  { id: "carrier-a", participant: "carrier-a" },
  { id: "carrier-b", participant: "carrier-b" },
  { id: "carrier-c", participant: "carrier-c" },
] as const;
export type CarrierId = typeof CARRIER_BINDINGS[number]["id"];
export interface Carrier { id: CarrierId; participant: string; name: string }
export const PARK_ENTRANCES = ["东入口", "南入口", "西入口", "北入口"] as const;
export type ParkEntrance = typeof PARK_ENTRANCES[number];
export const isParkEntrance = (value: unknown): value is ParkEntrance => typeof value === "string" && PARK_ENTRANCES.some(entrance => entrance === value);
/** Only unambiguous historical names may be normalised; unknown roads require a user correction. */
export function canonicalParkEntrance(value: string): ParkEntrance | undefined {
  if (isParkEntrance(value)) return value;
  const aliases: Record<string, ParkEntrance> = { 东门入口: "东入口", 南门入口: "南入口", 西门入口: "西入口", 北门入口: "北入口", 东门: "东入口", 南门: "南入口", 西门: "西入口", 北门: "北入口" };
  return Object.hasOwn(aliases, value) ? aliases[value] : undefined;
}
export interface ParkSettings { name: string; carriers: Carrier[]; entranceRoads?: string[] }
export const defaultParkSettings = (): ParkSettings => ({ name: "联合运营物流园区", entranceRoads: [...PARK_ENTRANCES], carriers: CARRIER_BINDINGS.map((binding, i) => ({ ...binding, name: `承运商 ${String.fromCharCode(65 + i)}` })) });
export const PARK_EVENT_FIELDS = ["dispatchReadyAt", "dispatchedAt", "offsiteArrivedAt", "arrivedAt", "gateStartedAt", "enteredAt", "readyAt", "serviceStartedAt", "serviceEndedAt", "departedAt"] as const;
export const PARK_LIFECYCLE_FIELDS = ["enteredAt", "serviceStartedAt", "serviceEndedAt", "departedAt"] as const;
export type ParkLifecycleField = typeof PARK_LIFECYCLE_FIELDS[number];
export const PARK_TIME_LABELS: Record<string, string> = { dispatchReadyAt: "承运商备车就绪", dispatchedAt: "运输发车", offsiteArrivedAt: "到达园外集结点", arrivedAt: "到达入口队列", gateStartedAt: "开始入园核验", enteredAt: "入园", readyAt: "到达作业等候区", serviceStartedAt: "开始作业", serviceEndedAt: "结束作业", departedAt: "离园", appointmentStart: "预约开始", appointmentEnd: "预约结束" };
export interface ParkVisit {
  /** Current vehicleId values are canonical full plates, never an independently entered number. */
  visitId: string; carrierId: CarrierId; vehicleId: string; road: string; arrivedAt: number;
  dispatchReadyAt?: number; dispatchedAt?: number; offsiteArrivedAt?: number;
  gateStartedAt?: number; enteredAt?: number; readyAt?: number; serviceStartedAt?: number; serviceEndedAt?: number; departedAt?: number;
  appointmentStart?: number; appointmentEnd?: number; distanceKm?: number; energyKwh?: number;
}
/** Derive the current business state from actual recorded events, including legacy sparse records. */
export function parkVisitStatus(visit: ParkVisit) {
  return visit.departedAt !== undefined ? "departed" : visit.serviceEndedAt !== undefined ? "work_completed" : visit.serviceStartedAt !== undefined ? "working"
    : visit.enteredAt !== undefined || visit.readyAt !== undefined ? "in_park" : "queued";
}
export const PARK_FIELDS = ["dispatchWaitMinutes", "transportMinutes", "offsiteWaitMinutes", "queueMinutes", "gateMinutes", "yardTransitMinutes", "yardWaitMinutes", "serviceMinutes", "departureWaitMinutes", "turnaroundMinutes", "endToEndMinutes", "completeJourney", "completed", "appointmentOnTime", "distanceKm", "energyKwh"] as const;
export const PARK_FIELD_LABELS: Record<typeof PARK_FIELDS[number], string> = { dispatchWaitMinutes: "承运商待发时长", transportMinutes: "运输在途时长", offsiteWaitMinutes: "园外等候时长", queueMinutes: "入口排队时长", gateMinutes: "入园核验时长", yardTransitMinutes: "园内转运时长", yardWaitMinutes: "场内待作业时长", serviceMinutes: "作业时长", departureWaitMinutes: "作业后待离园时长", turnaroundMinutes: "园区周转时长", endToEndMinutes: "端到端时长", completeJourney: "完整链路标记", completed: "已离园标记", appointmentOnTime: "按预约到达标记", distanceKm: "本车次行驶里程", energyKwh: "本车次用电量" };
export const PARK_COHORT_LABELS = { arrivals: "按到达时间选取车次", departures: "按离园时间选取车次" } as const;
export interface ParkContext { settings: ParkSettings; dataUpdatedAt: number }
export interface ParkCoverage { visits: number; completed: number; unfinished: number; contributingCarriers: number }
export interface ParkCatalog extends DataCatalog {
  dataset: "park_visits"; settings: ParkSettings; visitCount: number; completedCount: number;
  carrierId?: CarrierId; scopeVersion?: string;
}
export interface ParkSnapshot { version: string; catalog: ParkCatalog; visits: ParkVisit[] }
export const MAX_PARK_VISITS = 6000;
/** Strict event timestamp parser shared by file previews and server validation. */
export function parseParkTimestamp(value: unknown): number {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : NaN;
  if (typeof value !== "string") return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.exec(value);
  if (!match) return NaN;
  const day = new Date(match[1] + "-" + match[2] + "-" + match[3] + "T00:00:00Z");
  if (day.getUTCFullYear() !== Number(match[1]) || day.getUTCMonth() + 1 !== Number(match[2]) || day.getUTCDate() !== Number(match[3])) return NaN;
  const normalized = value.replace(" ", "T");
  return Date.parse(/[Zz]$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : normalized + "+08:00");
}
