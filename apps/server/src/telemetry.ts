import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PARTICIPANTS, error, type DataCatalog, type TelemetryRecord, type TelemetrySnapshot } from "@vectra/shared";
import { atomicWrite, canonical, seal, unseal, type Security } from "./security";
import { MAX_RECORDS, parseShanghaiDate } from "./statistics";

export class Telemetry {
  constructor(private security: Security) {
    mkdirSync(join(security.root, "telemetry"), { recursive: true });
    if (!existsSync(join(security.root, "telemetry", "catalog.json")) || this.catalog().source !== "import") this.publish([]);
    const catalog = this.catalog();
    if (catalog.vehicleCount === undefined) this.writeCatalog(this.describe(this.snapshot().records, catalog.version, catalog.updatedAt));
  }
  catalog(): DataCatalog { return JSON.parse(readFileSync(join(this.security.root, "telemetry", "catalog.json"), "utf8")); }
  snapshot(): TelemetrySnapshot {
    const catalog = this.catalog(), { version } = catalog;
    return { version, catalog, records: PARTICIPANTS.flatMap(id => readTelemetry(this.security, version, id)) };
  }
  import(value: unknown, expectedVersion?: string) {
    if (expectedVersion !== undefined && (typeof expectedVersion !== "string" || expectedVersion !== this.catalog().version)) throw error("dataset_changed", "车辆数据已由其他操作更新，请重新载入当前数据后再保存。草稿未被清空。", 409);
    if (!Array.isArray(value) || !value.length || value.length > MAX_RECORDS) throw error("invalid_telemetry", `一次导入 1—${MAX_RECORDS} 条记录。`, 422);
    const ids = new Set<string>(), owners = new Map<string, string>();
    const input = value.map((raw): Omit<TelemetryRecord, "participant"> & { participant?: string } => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !["participant", "vehicleId", "road", "recordedAt", "speed", "distanceKm", "energyKwh"].includes(k))) throw error("invalid_telemetry", "车辆数据字段无效。", 422);
      const { participant, vehicleId, road, speed, distanceKm, energyKwh } = raw;
      const recordedAt = typeof raw.recordedAt === "string" ? parseShanghaiDate(raw.recordedAt) : raw.recordedAt;
      if (participant !== undefined && !PARTICIPANTS.includes(participant) || typeof vehicleId !== "string" || !/^[\w-]{1,80}$/.test(vehicleId) || typeof road !== "string" || !/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,40}$/.test(road) || !Number.isSafeInteger(recordedAt) || recordedAt < 0 || recordedAt > Date.now() + 5000 || typeof speed !== "number" || !Number.isFinite(speed) || speed < 0 || speed > 250 || [distanceKm, energyKwh].some(n => n !== undefined && (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1000))) throw error("invalid_telemetry", "检查车辆编号、路段、采样时间及数值范围（速度 0—250，其余 0—1000）；计算节点可省略以自动分配。", 422);
      if (participant !== undefined) {
        if (owners.has(vehicleId) && owners.get(vehicleId) !== participant) throw error("invalid_telemetry", "同一车辆必须归属于同一个计算节点，避免跨节点重复计数。", 422);
        owners.set(vehicleId, participant);
      }
      const key = `${vehicleId}:${road}:${recordedAt}`; if (ids.has(key)) throw error("invalid_telemetry", "同一车辆、路段和时间存在重复记录。", 422); ids.add(key);
      return { ...(participant === undefined ? {} : { participant }), vehicleId, road, recordedAt, speed, ...(distanceKm === undefined ? {} : { distanceKm }), ...(energyKwh === undefined ? {} : { energyKwh }) };
    });
    // Resolve explicit ownership first, so records without an owner follow any explicit owner regardless of row order.
    const records: TelemetryRecord[] = input.map(row => ({ ...row, participant: owners.get(row.vehicleId) ?? participantForVehicle(row.vehicleId) }));
    return this.publish(records);
  }
  private publish(records: TelemetryRecord[]) {
    const version = randomUUID(), folder = join(this.security.root, "telemetry", version); mkdirSync(folder);
    for (const id of PARTICIPANTS) {
      const key = readFileSync(join(this.security.root, id, "input.key"));
      atomicWrite(join(folder, `${id}.enc.json`), canonical(seal(records.filter(r => r.participant === id), key, `telemetry:${version}:${id}`)));
    }
    const catalog = this.describe(records, version, Date.now());
    this.writeCatalog(catalog);
    return catalog;
  }
  private describe(records: TelemetryRecord[], version: string, updatedAt: number): DataCatalog {
    const roads = [...new Set(records.map(r => r.road))].sort().map(id => {
      const rows = records.filter(r => r.road === id);
      return { id, vehicleCount: new Set(rows.map(r => r.vehicleId)).size, sampleCount: rows.length, start: Math.min(...rows.map(r => r.recordedAt)), end: Math.max(...rows.map(r => r.recordedAt)), fields: ["speed", ...["distanceKm", "energyKwh"].filter(field => rows.some(r => r[field as "distanceKm"] !== undefined))] };
    });
    const nodes = PARTICIPANTS.map(id => { const rows = records.filter(r => r.participant === id); return { id, vehicleCount: new Set(rows.map(r => r.vehicleId)).size, sampleCount: rows.length }; });
    return { version, source: "import", updatedAt, roads, nodes, vehicleCount: new Set(records.map(r => r.vehicleId)).size, sampleCount: records.length };
  }
  private writeCatalog(catalog: DataCatalog) {
    // Publish only after all immutable per-node snapshots exist. Running tasks retain their signed version.
    atomicWrite(join(this.security.root, "telemetry", catalog.version, "catalog.json"), canonical(catalog));
    atomicWrite(join(this.security.root, "telemetry", "catalog.json"), canonical(catalog));
  }
}
export function participantForVehicle(vehicleId: string) {
  return PARTICIPANTS[createHash("sha256").update(vehicleId).digest().readUInt32BE(0) % PARTICIPANTS.length];
}
export function readTelemetry(security: Security, version: string, id: string): TelemetryRecord[] {
  if (!/^[a-f0-9-]{36}$/.test(version) || !PARTICIPANTS.includes(id as any)) throw error("invalid_dataset", "车辆数据版本或身份无效。", 403);
  const key = readFileSync(join(security.root, id, "input.key"));
  return unseal(JSON.parse(readFileSync(join(security.root, "telemetry", version, `${id}.enc.json`), "utf8")), key, `telemetry:${version}:${id}`) as TelemetryRecord[];
}
