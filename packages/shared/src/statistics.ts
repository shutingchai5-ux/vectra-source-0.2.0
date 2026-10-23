// This is a data-only statistical language. It never contains SQL, JavaScript or executable code.
export const STAT_FIELDS = ["speed", "distanceKm", "energyKwh"] as const;
export type StatField = typeof STAT_FIELDS[number];
export const STAT_OPERATIONS = ["count", "vehicle_count", "sum", "mean", "variance", "stddev", "ratio", "ratio_of_sums"] as const;
export interface MetricSpec {
  label: string;
  operation: typeof STAT_OPERATIONS[number];
  field?: StatField;
  denominatorField?: StatField;
  multiplier?: number;
  filter?: { field: StatField; op: "lt" | "lte" | "gt" | "gte" | "eq"; value: number };
}
export interface StatisticsQuery { roads: string[]; start: number; end: number; timeZone: "Asia/Shanghai"; metrics: MetricSpec[] }
export interface TelemetryRecord { participant: string; vehicleId: string; road: string; recordedAt: number; speed: number; distanceKm?: number; energyKwh?: number }
export interface TelemetrySnapshot { version: string; catalog: DataCatalog; records: TelemetryRecord[] }
export const MAX_TELEMETRY_RECORDS = 6000;
export interface DataCatalog {
  version: string; source: "import"; updatedAt: number;
  vehicleCount: number; sampleCount: number;
  nodes: { id: string; vehicleCount: number; sampleCount: number }[];
  roads: { id: string; vehicleCount: number; sampleCount: number; start: number; end: number; fields: string[] }[];
}
export interface MetricResult { label: string; value: number | null; unit: string; validSamples: number; note?: string }
export interface RoadStatistics { road: string; metrics: MetricResult[] }
export const DEFAULT_METRIC: MetricSpec = { label: "平均速度", operation: "mean", field: "speed" };
export const MAX_WINDOW_MS = 31 * 86400_000;
export function metricUnit(metric: MetricSpec) {
  if (metric.operation === "vehicle_count") return "辆";
  if (metric.operation === "count") return "条";
  if (metric.operation === "ratio") return "%";
  const unit = (field?: string) => field === "speed" ? "km/h" : field === "distanceKm" ? "km" : "kWh";
  if (metric.operation === "ratio_of_sums") return metric.field === "energyKwh" && metric.denominatorField === "distanceKm" && metric.multiplier === 100 ? "kWh/100 km" : `${unit(metric.field)}/${unit(metric.denominatorField)}${metric.multiplier === 100 ? " ×100" : ""}`;
  return metric.operation === "variance" ? `(${unit(metric.field)})²` : unit(metric.field);
}
