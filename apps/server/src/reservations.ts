import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CARRIER_BINDINGS, PARK_ENTRANCES, isParkEntrance, parseParkTimestamp, MAX_WINDOW_MS, RESERVATION_SLOT_MS, RESERVATION_FIELDS,
  error, type CarrierId, type ParkSettings, type ReservationSlot, type CapacitySlot, type ReservationCatalog, type ReservationSnapshot, type ReservationVersion, type StatisticsRecord } from "@vectra/shared";
import { atomicWrite, canonical, seal, unseal, type Security } from "./security";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw error("invalid_reservation", message, 422); };
const keyOf = (row: { road: string; slotStart: number }) => row.road + ":" + row.slotStart;
export function validateReservationRows(value: unknown, capacity = false, now = Date.now()): ReservationSlot[] | CapacitySlot[] {
  if (!Array.isArray(value) || value.length > 6000) return fail("每方最多保存 6000 个半小时时段。");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const bad = (message: string): never => fail("第 " + (index + 1) + " 行：" + message);
    const fields = capacity ? ["road", "slotStart", "entryCapacity", "serviceCapacityMinutes"] : ["carrierId", "road", "slotStart", ...RESERVATION_FIELDS];
    if (!object(raw) || Object.keys(raw).some(key => !fields.includes(key)) || !isParkEntrance(raw.road)) return bad("请选择固定入口并填写完整时段信息。");
    const slotStart = parseParkTimestamp(raw.slotStart);
    if (!Number.isSafeInteger(slotStart) || slotStart < 0 || slotStart % RESERVATION_SLOT_MS || slotStart > now + MAX_WINDOW_MS) return bad("时段须为上海整点或半点，最多提前 31 天。");
    if (!capacity && !CARRIER_BINDINGS.some(carrier => carrier.id === raw.carrierId)) return bad("承运商身份无效。");
    for (const field of capacity ? ["entryCapacity", "serviceCapacityMinutes"] : RESERVATION_FIELDS)
      if (typeof raw[field] !== "number" || !Number.isFinite(raw[field]) || Number(raw[field]) < 0 || Number(raw[field]) > 1_000_000 ||
        !field.endsWith("Minutes") && !Number.isSafeInteger(raw[field])) return bad("车次须为非负整数，作业分钟数须为有效非负数，最大 1000000。");
    if (!capacity && (raw.expectedTrips === 0 ? raw.requiredWorkMinutes !== 0 : Number(raw.requiredWorkMinutes) <= 0)) return bad("有到园需求时须填写预计作业量；零需求的作业量应为零。");
    const row = { ...raw, slotStart } as unknown as ReservationSlot | CapacitySlot, key = keyOf(row);
    if (seen.has(key)) return bad("同一入口和半小时时段只能申报一行，请合并后填写。");
    seen.add(key); return row;
  }) as ReservationSlot[] | CapacitySlot[];
}
export class ReservationData {
  private readonly folder: string;
  private get bindings() { return CARRIER_BINDINGS.filter(carrier => this.owners.includes(carrier.id)); }
  constructor(private security: Security, private settings: () => ParkSettings, private readonly owners: readonly CarrierId[] = CARRIER_BINDINGS.map(carrier => carrier.id)) {
    this.folder = join(security.root, "reservations"); mkdirSync(this.folder, { recursive: true });
    if (!existsSync(join(this.folder, "catalog.json"))) this.publish([], []);
  }
  catalog(): ReservationCatalog { return JSON.parse(readFileSync(join(this.folder, "catalog.json"), "utf8")); }
  private all(version = this.catalog().version) { return this.bindings.flatMap(carrier => readReservationSlots(this.security, version, carrier.id)); }
  forCarrier(carrierId: CarrierId, version?: string): ReservationSnapshot {
    if (!this.owners.includes(carrierId)) throw error("carrier_scope_forbidden", "本部署不持有该企业的预约。", 403);
    const catalog = version ? readReservationCatalog(this.security, version) : this.catalog(), slots = readReservationSlots(this.security, catalog.version, carrierId);
    return { version: catalog.version, catalog: { ...catalog, planCount: slots.length, sampleCount: slots.length,
      nodes: catalog.nodes.filter(node => node.id === carrierId), roads: this.describe(slots, catalog.capacitySlots, catalog.version, catalog.updatedAt).roads }, slots };
  }
  versions(owner?: CarrierId): ReservationVersion[] {
    return readdirSync(this.folder).filter(name => /^[a-f0-9-]{36}$/.test(name)).flatMap(version => {
      try { const catalog = readReservationCatalog(this.security, version); return [{ version, updatedAt: catalog.updatedAt,
        rowCount: owner ? catalog.nodes.find(node => node.id === owner)?.sampleCount ?? 0 : catalog.capacitySlots.length }]; }
      catch { return []; }
    }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  }
  replaceCarrier(carrierId: CarrierId, value: unknown, baseVersion: unknown, now = Date.now()): ReservationSnapshot {
    if (Array.isArray(value) && value.some(row => object(row) && row.carrierId !== carrierId)) throw error("carrier_scope_forbidden", "只能维护当前承运商的预约需求和运力。", 403);
    const slots = validateReservationRows(value, false, now) as ReservationSlot[];
    if (slots.some(slot => slot.carrierId !== carrierId)) throw error("carrier_scope_forbidden", "只能维护当前承运商的预约需求和运力。", 403);
    const catalog = this.catalog(), before = readReservationSlots(this.security, catalog.version, carrierId);
    this.checkVersion(baseVersion, catalog, carrierId);
    this.checkPast(before, slots, now);
    const all = this.all(catalog.version).filter(slot => slot.carrierId !== carrierId);
    this.publish([...all, ...slots], catalog.capacitySlots); return this.forCarrier(carrierId);
  }
  replaceCapacity(value: unknown, baseVersion: unknown, now = Date.now()) {
    const capacities = validateReservationRows(value, true, now) as CapacitySlot[], catalog = this.catalog();
    this.checkVersion(baseVersion, catalog); this.checkPast(catalog.capacitySlots, capacities, now);
    return this.publish(this.all(catalog.version), capacities);
  }
  refreshSettings() { const catalog = this.catalog(); if (canonical(catalog.settings) !== canonical(this.settings())) this.publish(this.all(catalog.version), catalog.capacitySlots); }
  importSnapshot(slots:unknown,capacities:unknown) {
    const current=this.catalog();
    if(current.sampleCount||current.capacitySlots.length)throw error("migration_not_empty","迁移目标预约台账必须为空。",409);
    return this.publish(validateReservationRows(slots,false) as ReservationSlot[],validateReservationRows(capacities,true) as CapacitySlot[]);
  }
  private checkVersion(version: unknown, catalog: ReservationCatalog, owner?: CarrierId) {
    if (typeof version !== "string" || !/^[a-f0-9-]{36}$/.test(version)) throw error("reservation_changed", "请先载入预约台账，再保存。", 409);
    if (version === catalog.version) return;
    let unchanged = false;
    try { unchanged = owner ? canonical(readReservationSlots(this.security, version, owner)) === canonical(readReservationSlots(this.security, catalog.version, owner))
      : canonical(readReservationCatalog(this.security, version).capacitySlots) === canonical(catalog.capacitySlots); } catch { /* Invalid or removed historical versions cannot authorize a write. */ }
    if (!unchanged) throw error("reservation_changed", "本方预约资料或园区容量已变化，请刷新后核对；当前草稿仍保留。", 409);
  }
  private checkPast(before: Array<ReservationSlot | CapacitySlot>, after: Array<ReservationSlot | CapacitySlot>, now: number) {
    const old = new Map(before.map(row => [keyOf(row), row])), next = new Map(after.map(row => [keyOf(row), row]));
    for (const row of [...before, ...after]) if (row.slotStart <= now && canonical(old.get(keyOf(row)) ?? null) !== canonical(next.get(keyOf(row)) ?? null)) {
      if (old.has(keyOf(row)) && !next.has(keyOf(row)) && row.slotStart + RESERVATION_SLOT_MS <= now) continue;
      return fail("已经开始的计划时段只读，不能新增或修改；结束后可归档，原内容保留在历史快照。");
    }
  }
  private publish(slots: ReservationSlot[], capacities: CapacitySlot[]) {
    if (slots.some(slot => !this.owners.includes(slot.carrierId))) throw error("carrier_scope_forbidden", "不能在本部署保存其他企业的预约。", 403);
    const version = randomUUID(), folder = join(this.folder, version); mkdirSync(folder);
    for (const carrier of this.bindings) atomicWrite(join(folder, carrier.id + ".enc.json"), canonical(seal(slots.filter(slot => slot.carrierId === carrier.id),
      readFileSync(join(this.security.root, carrier.id, "input.key")), "reservations:" + version + ":" + carrier.id)));
    const catalog = this.describe(slots, capacities, version, Date.now());
    atomicWrite(join(folder, "catalog.json"), canonical(catalog)); atomicWrite(join(this.folder, "catalog.json"), canonical(catalog)); return catalog;
  }
  private describe(slots: ReservationSlot[], capacities: CapacitySlot[], version: string, updatedAt: number): ReservationCatalog {
    return { dataset: "reservation_plans", version, source: "import", updatedAt, settings: this.settings(), slotMinutes: 30, capacitySlots: capacities, planCount: slots.length,
      vehicleCount: 0, sampleCount: slots.length, nodes: CARRIER_BINDINGS.map(carrier => ({ id: carrier.id, vehicleCount: 0, sampleCount: slots.filter(slot => slot.carrierId === carrier.id).length })),
      roads: PARK_ENTRANCES.map(id => { const rows = slots.filter(slot => slot.road === id); return { id, vehicleCount: 0, sampleCount: rows.length,
        start: rows.length ? Math.min(...rows.map(slot => slot.slotStart)) : 0, end: rows.length ? Math.max(...rows.map(slot => slot.slotStart + RESERVATION_SLOT_MS)) : 0, fields: [...RESERVATION_FIELDS] }; }) };
  }
}
export function readReservationCatalog(security: Security, version: string): ReservationCatalog {
  if (!/^[a-f0-9-]{36}$/.test(version)) throw error("invalid_dataset", "预约计划版本无效。", 403);
  return JSON.parse(readFileSync(join(security.root, "reservations", version, "catalog.json"), "utf8"));
}
export function readReservationSlots(security: Security, version: string, owner: string): ReservationSlot[] {
  if (!/^[a-f0-9-]{36}$/.test(version) || !CARRIER_BINDINGS.some(carrier => carrier.id === owner)) throw error("invalid_dataset", "预约版本或承运商身份无效。", 403);
  return unseal(JSON.parse(readFileSync(join(security.root, "reservations", version, owner + ".enc.json"), "utf8")),
    readFileSync(join(security.root, owner, "input.key")), "reservations:" + version + ":" + owner) as ReservationSlot[];
}
export function projectReservations(slots: ReservationSlot[]): StatisticsRecord[] {
  return slots.map(slot => ({ road: slot.road, recordedAt: slot.slotStart,
    expectedTrips: slot.expectedTrips, availableTrips: slot.availableTrips, requiredWorkMinutes: slot.requiredWorkMinutes }));
}
export const RESERVATION_PLANNING_GUIDE = "预约协同使用独立的 reservation_plans 数据，不是实际到达或离园车次。按计划时段开始时间选择，start含、end不含；未来查询允许到服务端当前时间后31天，跨度最多31天。每个原始时段30分钟；bucketMinutes从30、60、120、240、720、1440中选，长区间使用较粗粒度，最多128个入口时段和2048个秘密分享分量。不要设置cohort或analysis。必须至少包含三个sum指标：预计到园车次(expectedTrips)、可投入运输车次(availableTrips)、预计作业量(requiredWorkMinutes)。可投入运输车次是该入口时段可安排的运输额度，不是去重车辆数，不可跨入口重复承诺同一运力。园区公开入口容量、作业分钟容量随快照冻结；未配置不当成零或无限。结果仅为申报计划与人工协调建议，不证明车辆已到达，不自动更改预约。";
