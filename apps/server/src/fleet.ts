import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CARRIER_BINDINGS, PARK_ENTRANCES, canonicalParkEntrance, ENERGY_TYPES, VEHICLE_TYPES, MAX_FLEET_VEHICLES, PARK_EVENT_FIELDS, PARK_TIME_LABELS, parkVisitStatus, isPlateNumber, normalizePlateNumber, plateNumberError, error, type CarrierId, type FleetOverview, type ParkVehicle, type VehicleState } from "@vectra/shared";
import { atomicWrite, canonical, hash, seal, unseal, type Security } from "./security";
import type { ParkData, VehicleIdentityAlias } from "./park";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fail = (message: string): never => { throw error("invalid_vehicle", message, 422); };
interface FleetCatalog { version: string; updatedAt: number; vehicleCount: number }
export class FleetData {
  private readonly folder: string;
  private get bindings() { return CARRIER_BINDINGS.filter(carrier => this.owners.includes(carrier.id)); }
  constructor(private security: Security, private park: ParkData, private readonly owners: readonly CarrierId[] = CARRIER_BINDINGS.map(carrier => carrier.id)) {
    this.folder = join(security.root, "fleet"); mkdirSync(this.folder, { recursive: true });
    if (!existsSync(join(this.folder, "catalog.json"))) this.publish([], []);
    else {
      const before = this.profiles(), aliases = this.identityAliases(), plates = new Set<string>();
      const after = before.map(vehicle => {
        const plate = isPlateNumber(vehicle.plateNumber) ? normalizePlateNumber(vehicle.plateNumber) : isPlateNumber(vehicle.vehicleId) ? normalizePlateNumber(vehicle.vehicleId) : undefined;
        if (plate && plates.has(plate)) return fail("旧车辆档案存在重复车牌，请先核对原始数据。");
        if (plate) { plates.add(plate); this.addAlias(aliases, vehicle.vehicleId, plate, vehicle.carrierId); }
        return { ...vehicle, ...(plate ? { vehicleId: plate, plateNumber: plate } : {}), allowedRoads: [...new Set(vehicle.allowedRoads.map(road => canonicalParkEntrance(road) ?? road))] };
      });
      this.park.previewVehicleIdentities(aliases);
      if (canonical(before) !== canonical(after)) this.publish(after, aliases);
      this.park.reidentifyVehicles(aliases);
    }
  }
  catalog(): FleetCatalog { return JSON.parse(readFileSync(join(this.folder, "catalog.json"), "utf8")); }
  profiles(version = this.catalog().version): ParkVehicle[] {
    if (!/^[a-f0-9-]{36}$/.test(version)) throw error("invalid_dataset", "车辆档案版本无效。", 403);
    return this.bindings.flatMap(carrier => {
      const key = readFileSync(join(this.security.root, carrier.participant, "input.key"));
      return unseal(JSON.parse(readFileSync(join(this.folder, version, `${carrier.id}.enc.json`), "utf8")), key, `fleet:${version}:${carrier.id}`) as ParkVehicle[];
    });
  }
  private identityAliases(): VehicleIdentityAlias[] {
    const { version } = this.catalog();
    return this.bindings.flatMap(carrier => {
      const file = join(this.folder, version, carrier.id + ".identity-aliases.enc.json"); if (!existsSync(file)) return [];
      const key = readFileSync(join(this.security.root, carrier.participant, "input.key"));
      return unseal(JSON.parse(readFileSync(file, "utf8")), key, "fleet-identities:" + version + ":" + carrier.id) as VehicleIdentityAlias[];
    });
  }
  private addAlias(aliases: VehicleIdentityAlias[], from: string, to: string, carrierId: string) {
    if (from === to) return;
    const existing = aliases.find(alias => alias.from === from);
    if (existing && (existing.to !== to || existing.carrierId !== carrierId)) return fail("旧车辆记录已关联其他车牌，请重新载入并核对。");
    if (!existing) aliases.push({ from, to, carrierId });
  }
  overview(): FleetOverview {
    // Alias publication precedes the park pointer; this also resumes an interrupted re-key on restart/retry.
    this.park.reidentifyVehicles(this.identityAliases());
    const catalog = this.catalog(), snapshot = this.park.snapshot(), byVehicle = new Map<string, VehicleState>();
    for (const vehicle of this.profiles()) byVehicle.set(vehicle.vehicleId, { ...vehicle, profiled: true, status: "no_visit" });
    for (const visit of snapshot.visits) {
      const vehicle: VehicleState = byVehicle.get(visit.vehicleId) ?? { vehicleId: visit.vehicleId, ...(isPlateNumber(visit.vehicleId) ? { plateNumber: normalizePlateNumber(visit.vehicleId) } : {}), carrierId: visit.carrierId, allowedRoads: [], profiled: false, status: "no_visit" };
      if (vehicle.lastVisit && vehicle.lastVisit.arrivedAt >= visit.arrivedAt) continue;
      const field = [...PARK_EVENT_FIELDS].reverse().find(field => visit[field] !== undefined)!;
      vehicle.lastVisit = { visitId: visit.visitId, road: visit.road, arrivedAt: visit.arrivedAt, lastEventAt: visit[field]!, stage: PARK_TIME_LABELS[field] };
      vehicle.status = parkVisitStatus(visit);
      byVehicle.set(visit.vehicleId, vehicle);
    }
    return { ...catalog, parkVersion: snapshot.version, parkUpdatedAt: snapshot.catalog.updatedAt, settings: snapshot.catalog.settings, roads: [...PARK_ENTRANCES], vehicles: [...byVehicle.values()].sort((a, b) => a.carrierId.localeCompare(b.carrierId) || a.vehicleId.localeCompare(b.vehicleId)) };
  }
  forCarrier(carrierId: CarrierId): FleetOverview {
    if (!this.owners.includes(carrierId)) throw error("carrier_scope_forbidden", "本部署不持有该企业的车辆。", 403);
    const value = this.overview(), vehicles = value.vehicles.filter(vehicle => vehicle.carrierId === carrierId);
    const { vehicleCount: _globalCount, ...scoped } = value as FleetOverview & { vehicleCount?: number };
    return { ...scoped, vehicles, carrierId, scopeVersion: hash(this.profiles().filter(vehicle => vehicle.carrierId === carrierId)) };
  }
  assertVisitOwners(value: unknown) {
    if (!Array.isArray(value)) return;
    const owners = new Map(this.profiles().map(v => [v.vehicleId, v.carrierId]));
    for (const row of value) if (object(row) && typeof row.vehicleId === "string") {
      const plate = normalizePlateNumber(row.vehicleId);
      if (owners.has(plate) && owners.get(plate) !== row.carrierId) return fail("车次所属承运商与车辆档案不一致，请先核对车牌归属。");
    }
  }
  save(carrierId: unknown, value: unknown, baseVersion: unknown, carrierScoped = false) {
    if (!this.owners.includes(carrierId as CarrierId)) throw error("carrier_scope_forbidden", "只能维护本部署企业的车辆。", 403);
    if (baseVersion !== this.catalog().version) {
      const comparable = carrierScoped && typeof baseVersion === "string" && /^[a-f0-9-]{36}$/.test(baseVersion) && existsSync(join(this.folder, baseVersion, "catalog.json"));
      if (!comparable || canonical(this.profiles(baseVersion as string).filter(vehicle => vehicle.carrierId === carrierId)) !== canonical(this.profiles().filter(vehicle => vehicle.carrierId === carrierId))) throw error("fleet_changed", "本承运商车辆档案已更新，请重新载入后保存，当前草稿仍保留。", 409);
    }
    if (!CARRIER_BINDINGS.some(c => c.id === carrierId) || !Array.isArray(value) || value.length > MAX_FLEET_VEHICLES) return fail(`请选择已登记承运商，每次最多${MAX_FLEET_VEHICLES}辆车。`);
    const overview = this.overview(), roads = new Set(overview.roads), ids = new Set<string>(), sources = new Set<string>(), existingVehicles = new Map(overview.vehicles.map(v => [v.vehicleId, v])), aliases = this.identityAliases(), now = Date.now();
    const vehicles = value.map((raw): ParkVehicle => {
      if (!object(raw) || Object.keys(raw).some(k => !["vehicleId", "sourceVehicleId", "carrierId", "plateNumber", "vehicleType", "energyType", "capacityTonnes", "allowedRoads"].includes(k)) || raw.carrierId !== carrierId) return fail("请填写车牌号并选择所属承运商。");
      const problem = plateNumberError(raw.plateNumber); if (problem) return fail(problem);
      const plate = normalizePlateNumber(raw.plateNumber as string);
      if (raw.vehicleId !== undefined && raw.vehicleId !== plate) return fail("车辆以车牌号唯一标识，无需另填车辆编号。");
      if (ids.has(plate)) return fail("本次保存的车牌号重复，同一车牌只能建立一份车辆档案。"); ids.add(plate);
      if (raw.sourceVehicleId !== undefined && (typeof raw.sourceVehicleId !== "string" || !existingVehicles.has(raw.sourceVehicleId))) return fail("原车辆记录已变化，请重新载入后补录车牌。");
      const sourceId = typeof raw.sourceVehicleId === "string" ? raw.sourceVehicleId : plate, existing = existingVehicles.get(sourceId), target = existingVehicles.get(plate);
      if (existing && existing.carrierId !== carrierId) return fail("该车辆已属于另一家承运商，不能重复建档。");
      if (target && target.carrierId !== carrierId) return fail("该车牌已属于另一家承运商，不能重复建档。");
      if (existing && isPlateNumber(existing.plateNumber ?? existing.vehicleId) && normalizePlateNumber(existing.plateNumber ?? existing.vehicleId) !== plate) return fail("已登记车牌用于唯一识别车辆，新增车辆请单独建档。");
      if (existing && target && existing.vehicleId !== target.vehicleId) return fail("该车牌已有车辆记录，请先核对旧记录，避免将两辆车合并。");
      if (sources.has(sourceId)) return fail("同一旧车辆记录不能补录为多个车牌。"); sources.add(sourceId);
      if (existing) this.addAlias(aliases, existing.vehicleId, plate, existing.carrierId);
      // Older clients may retain historical road metadata; new profiles require no entrance selection.
      const allowedRoads = raw.allowedRoads === undefined ? existing?.allowedRoads ?? [] : raw.allowedRoads;
      if (!Array.isArray(allowedRoads) || allowedRoads.length > PARK_ENTRANCES.length || new Set(allowedRoads).size !== allowedRoads.length || allowedRoads.some(road => typeof road !== "string" || !roads.has(road))) return fail("历史通行入口字段须为固定入口组成的不重复数组，可留空；实际入口在车次登记中填写。");
      if (raw.vehicleType !== undefined && !Object.hasOwn(VEHICLE_TYPES, String(raw.vehicleType)) || raw.energyType !== undefined && !Object.hasOwn(ENERGY_TYPES, String(raw.energyType))) return fail("请选择支持的车型与动力类型。");
      if (raw.capacityTonnes !== undefined && (typeof raw.capacityTonnes !== "number" || !Number.isFinite(raw.capacityTonnes) || raw.capacityTonnes < 0 || raw.capacityTonnes > 1000)) return fail("额定载重须为0—1000吨，未知时留空。");
      return { vehicleId: plate, plateNumber: plate, carrierId: carrierId as CarrierId, allowedRoads: allowedRoads as string[], ...(raw.vehicleType === undefined ? {} : { vehicleType: raw.vehicleType as ParkVehicle["vehicleType"] }), ...(raw.energyType === undefined ? {} : { energyType: raw.energyType as ParkVehicle["energyType"] }), ...(raw.capacityTonnes === undefined ? {} : { capacityTonnes: raw.capacityTonnes as number }), updatedAt: now };
    });
    const all = [...this.profiles().filter(v => v.carrierId !== carrierId), ...vehicles];
    if (all.length > MAX_FLEET_VEHICLES) return fail(`完整车辆档案最多${MAX_FLEET_VEHICLES}辆。`);
    this.park.previewVehicleIdentities(aliases);
    this.publish(all, aliases); return this.overview();
  }
  private publish(vehicles: ParkVehicle[], aliases: VehicleIdentityAlias[]) {
    const version = randomUUID(), folder = join(this.folder, version); mkdirSync(folder);
    for (const carrier of this.bindings) {
      const key = readFileSync(join(this.security.root, carrier.participant, "input.key"));
      atomicWrite(join(folder, `${carrier.id}.enc.json`), canonical(seal(vehicles.filter(v => v.carrierId === carrier.id), key, `fleet:${version}:${carrier.id}`)));
      atomicWrite(join(folder, carrier.id + ".identity-aliases.enc.json"), canonical(seal(aliases.filter(alias => alias.carrierId === carrier.id), key, "fleet-identities:" + version + ":" + carrier.id)));
    }
    const catalog = { version, updatedAt: Date.now(), vehicleCount: vehicles.length };
    atomicWrite(join(folder, "catalog.json"), canonical(catalog)); atomicWrite(join(this.folder, "catalog.json"), canonical(catalog));
  }
}
