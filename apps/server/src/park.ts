import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CARRIER_BINDINGS, PARK_ENTRANCES, isParkEntrance, canonicalParkEntrance, parseParkTimestamp, normalizePlateNumber, plateNumberError, PARK_EVENT_FIELDS, PARK_LIFECYCLE_FIELDS, PARK_FIELDS, MAX_PARK_VISITS, MAX_WINDOW_MS, defaultParkSettings, error, type ParkLifecycleField, type ParkCatalog, type ParkSettings, type ParkSnapshot, type ParkVisit, type StatisticsQuery, type StatisticsRecord } from "@vectra/shared";
import { atomicWrite, canonical, hash, seal, unseal, type Security } from "./security";
import { JOURNEY_STAGES } from "@vectra/shared";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown, length: number) => typeof v === "string" && new RegExp(`^[A-Za-z0-9_\\-\\u4e00-\\u9fff]{1,${length}}$`).test(v);
const fail = (message: string): never => { throw error("invalid_park_data", message, 422); };
export interface VehicleIdentityAlias { from: string; to: string; carrierId: string }
export function validateParkSettings(value: unknown): ParkSettings {
  if (!record(value) || Object.keys(value).some(k => !["name", "carriers", "entranceRoads"].includes(k)) || typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 80 || !Array.isArray(value.carriers) || value.carriers.length !== 3) return fail("请填写园区名称和三家承运商名称。");
  const carriers = CARRIER_BINDINGS.map(binding => {
    const carrier = (value.carriers as unknown[]).find(c => record(c) && c.id === binding.id);
    if (!record(carrier) || Object.keys(carrier).some(k => !["id", "participant", "name"].includes(k)) || carrier.participant !== binding.participant || typeof carrier.name !== "string" || !carrier.name.trim() || carrier.name.trim().length > 50) return fail("三家承运商的标识和计算节点绑定固定，只能修改显示名称。");
    return { ...binding, name: carrier.name.trim() };
  });
  if (new Set(carriers.map(c => c.name.toLowerCase())).size !== 3) return fail("三家承运商名称须不同。");
  if (value.entranceRoads !== undefined && (!Array.isArray(value.entranceRoads) || value.entranceRoads.length !== PARK_ENTRANCES.length || value.entranceRoads.some(r => !isParkEntrance(r)) || new Set(value.entranceRoads).size !== PARK_ENTRANCES.length)) return fail("园区固定为东入口、南入口、西入口、北入口，不能新增、删除或改名。");
  return { name: value.name.trim(), carriers, entranceRoads: [...PARK_ENTRANCES] };
}
export function validateParkVisits(value: unknown, now = Date.now()): ParkVisit[] {
  if (!Array.isArray(value) || value.length > MAX_PARK_VISITS) return fail(`完整快照最多 ${MAX_PARK_VISITS} 个车次；允许发布空数组以清空当前数据。`);
  const ids = new Set<string>(), arrivals = new Set<string>(), vehicles = new Map<string, string>();
  return value.map((raw, index) => {
    const bad = (text: string): never => fail(`第 ${index + 1} 个车次：${text}`);
    const timeFields = [...PARK_EVENT_FIELDS, "appointmentStart", "appointmentEnd"] as const;
    if (!record(raw) || Object.keys(raw).some(k => !["visitId", "carrierId", "vehicleId", "road", ...timeFields, "distanceKm", "energyKwh"].includes(k))) return bad("含有未知字段。");
    if (!identifier(raw.visitId, 100) || !identifier(raw.road, 40) || !CARRIER_BINDINGS.some(c => c.id === raw.carrierId)) return bad("须填写全局唯一车次编号、入口以及明确的所属承运商。");
    const plateProblem = plateNumberError(raw.vehicleId); if (plateProblem) return bad(plateProblem);
    const vehicleId = normalizePlateNumber(raw.vehicleId as string);
    if (!isParkEntrance(raw.road)) return bad("实际入口须选择东入口、南入口、西入口或北入口。");
    if (ids.has(String(raw.visitId))) return bad("车次编号重复；同一车辆多次进园须使用不同车次编号。");
    ids.add(String(raw.visitId));
    const owner = vehicles.get(vehicleId);
    if (owner && owner !== raw.carrierId) return bad("同一车辆不能归属于不同承运商；请统一车辆标识和归属。");
    vehicles.set(vehicleId, String(raw.carrierId));
    const visit: Record<string, unknown> = { visitId: raw.visitId, carrierId: raw.carrierId, vehicleId, road: raw.road };
    for (const field of timeFields) if (raw[field] !== undefined) {
      const time = parseParkTimestamp(raw[field]);
      if (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0 || !Number.isFinite(new Date(time).getTime())) return bad(`${field} 须为真实有效时间，未写时区时按上海处理。`);
      if (!field.startsWith("appointment") && time > now) return bad("实际作业事件不能发生在未来。");
      visit[field] = time;
    }
    if (visit.arrivedAt === undefined) return bad("缺少到达入口队列时间 arrivedAt。");
    const arrival = `${visit.vehicleId}:${visit.arrivedAt}`;
    if (arrivals.has(arrival)) return bad("同一车辆、同一到达时间重复，不能通过更换车次编号重复计数。");
    arrivals.add(arrival);
    let previous = -1;
    const journeyStart = Number(PARK_EVENT_FIELDS.map(field => visit[field]).find(value => value !== undefined));
    for (const field of PARK_EVENT_FIELDS) if (visit[field] !== undefined) {
      const time = Number(visit[field]);
      if (time < previous || time - journeyStart > MAX_WINDOW_MS) return bad("实际事件须按备车、发车、园外集结、到达、核验、入园、作业与离园的顺序，完整链路跨度最多 31 天。");
      previous = time;
    }
    if ((visit.appointmentStart === undefined) !== (visit.appointmentEnd === undefined) || visit.appointmentStart !== undefined && (Number(visit.appointmentStart) >= Number(visit.appointmentEnd) || Math.abs(Number(visit.appointmentStart) - Number(visit.arrivedAt)) > MAX_WINDOW_MS || Number(visit.appointmentEnd) - Number(visit.appointmentStart) > MAX_WINDOW_MS)) return bad("预约开始与结束须成对填写、开始早于结束，与本车次相距及预约跨度均不超过 31 天。");
    for (const field of ["distanceKm", "energyKwh"] as const) if (raw[field] !== undefined) {
      if (typeof raw[field] !== "number" || !Number.isFinite(raw[field]) || raw[field] < 0 || raw[field] > 1_000_000 || visit.departedAt === undefined) return bad("里程和用电量须为已离园车次的完整行程增量，范围 0—1000000，不能填累计仪表值。");
      visit[field] = raw[field];
    }
    return visit as unknown as ParkVisit;
  });
}

/** Only the owning worker derives durations; unknown endpoints remain unknown. */
export function projectParkVisits(visits: ParkVisit[], query: StatisticsQuery): StatisticsRecord[] {
  return visits.flatMap(visit => {
    const recordedAt = query.cohort === "departures" ? visit.departedAt : visit.arrivedAt;
    if (recordedAt === undefined) return [];
    const row: StatisticsRecord = { vehicleId: visit.vehicleId, road: visit.road, recordedAt, completed: visit.departedAt === undefined ? 0 : 1 };
    for (const stage of JOURNEY_STAGES) if (visit[stage.start] !== undefined && visit[stage.end] !== undefined) row[stage.field] = (visit[stage.end]! - visit[stage.start]!) / 60_000;
    if (visit.departedAt !== undefined) row.turnaroundMinutes = (visit.departedAt - visit.arrivedAt) / 60_000;
    row.completeJourney = JOURNEY_STAGES.every(stage => row[stage.field] !== undefined) ? 1 : 0;
    if (row.completeJourney) row.endToEndMinutes = (visit.departedAt! - visit.dispatchReadyAt!) / 60_000;
    if (visit.appointmentStart !== undefined && visit.appointmentEnd !== undefined) row.appointmentOnTime = visit.arrivedAt >= visit.appointmentStart && visit.arrivedAt < visit.appointmentEnd ? 1 : 0;
    if (visit.distanceKm !== undefined) row.distanceKm = visit.distanceKm;
    if (visit.energyKwh !== undefined) row.energyKwh = visit.energyKwh;
    return [row];
  });
}

export class ParkData {
  private readonly folder: string;
  private get bindings() { return CARRIER_BINDINGS.filter(carrier => this.owners.includes(carrier.id)); }
  constructor(private security: Security, private readonly owners: readonly ParkVisit["carrierId"][] = CARRIER_BINDINGS.map(carrier => carrier.id)) {
    this.folder = join(security.root, "park"); mkdirSync(this.folder, { recursive: true });
    if (!existsSync(join(this.folder, "catalog.json"))) this.publish([], defaultParkSettings());
    else {
      const { catalog, visits } = this.snapshot(), normalized = visits.map(visit => ({ ...visit, road: canonicalParkEntrance(visit.road) ?? visit.road }));
      if (canonical(catalog.settings.entranceRoads ?? []) !== canonical(PARK_ENTRANCES) || normalized.some((visit, index) => visit.road !== visits[index].road)) {
        this.publish(normalized, { ...catalog.settings, entranceRoads: [...PARK_ENTRANCES] });
      }
    }
  }
  catalog(): ParkCatalog { return JSON.parse(readFileSync(join(this.folder, "catalog.json"), "utf8")); }
  snapshot(): ParkSnapshot {
    const catalog = this.catalog();
    return { version: catalog.version, catalog, visits: this.bindings.flatMap(c => readParkVisits(this.security, catalog.version, c.participant)) };
  }
  forCarrier(carrierId: ParkVisit["carrierId"]): ParkSnapshot {
    if (!this.owners.includes(carrierId)) throw error("carrier_scope_forbidden", "本部署不持有该企业的车次。", 403);
    const snapshot = this.snapshot(), visits = snapshot.visits.filter(visit => visit.carrierId === carrierId), catalog = this.describe(visits, snapshot.catalog.settings, snapshot.version, snapshot.catalog.updatedAt);
    return { version: snapshot.version, visits, catalog: { ...catalog, nodes: catalog.nodes.filter(node => node.id === carrierId), carrierId, scopeVersion: hash(visits) } };
  }
  /** Only a validated confirmation creates a live visit. Selecting a vehicle never calls this operation. */
  queueCarrier(carrierId: ParkVisit["carrierId"], raw: unknown): ParkSnapshot {
    const allowed = ["visitId", "vehicleId", "road", "arrivedAt", "appointmentStart", "appointmentEnd", "dispatchReadyAt", "dispatchedAt", "offsiteArrivedAt"];
    if (!record(raw) || Object.keys(raw).some(key => !allowed.includes(key))) return fail("请填写车辆、实际入口与有效到达信息后登记排队，入园及后续事件须另行确认。");
    const now = Date.now(), visit = validateParkVisits([{ ...raw, carrierId, arrivedAt: raw.arrivedAt ?? now }], now)[0], snapshot = this.snapshot();
    const existing = snapshot.visits.find(row => row.visitId === visit.visitId);
    if (existing) {
      if (existing.carrierId === carrierId && Object.keys(raw).every(key => existing[key as keyof ParkVisit] === visit[key as keyof ParkVisit])) return this.forCarrier(carrierId);
      throw error("visit_exists", "该车次编号已使用，请刷新记录后核对。", 409);
    }
    if (snapshot.visits.some(row => row.vehicleId === visit.vehicleId && row.departedAt === undefined)) throw error("vehicle_already_in_park", "该车辆已有排队或未离园车次，请打开当前车次继续办理。", 409);
    this.importCarrier(carrierId, [...snapshot.visits.filter(row => row.carrierId === carrierId), visit], snapshot.version);
    return this.forCarrier(carrierId);
  }
  admitCarrier(carrierId: ParkVisit["carrierId"], raw: unknown): ParkSnapshot {
    const allowed = ["visitId", "vehicleId", "road", "enteredAt", "arrivedAt", "gateStartedAt", "appointmentStart", "appointmentEnd", "dispatchReadyAt", "dispatchedAt", "offsiteArrivedAt"];
    if (!record(raw) || Object.keys(raw).some(key => !allowed.includes(key))) return fail("请填写车辆、实际入口及有效的入园信息后确认入园。");
    const now = Date.now(), enteredAt = raw.enteredAt === undefined ? now : parseParkTimestamp(raw.enteredAt);
    const visit = validateParkVisits([{ ...raw, carrierId, enteredAt, arrivedAt: raw.arrivedAt ?? enteredAt }], now)[0], snapshot = this.snapshot();
    const existing = snapshot.visits.find(row => row.visitId === visit.visitId);
    if (existing) {
      if (existing.carrierId === carrierId && existing.enteredAt !== undefined && Object.keys(raw).every(key => existing[key as keyof ParkVisit] === visit[key as keyof ParkVisit])) return this.forCarrier(carrierId);
      throw error("visit_exists", "该车次编号已使用，请重新载入后核对。", 409);
    }
    if (snapshot.visits.some(row => row.vehicleId === visit.vehicleId && row.departedAt === undefined)) throw error("vehicle_already_in_park", "该车辆已有排队或未离园车次，请打开当前车次继续办理。", 409);
    this.importCarrier(carrierId, [...snapshot.visits.filter(row => row.carrierId === carrierId), visit], snapshot.version);
    return this.forCarrier(carrierId);
  }
  advanceCarrier(carrierId: ParkVisit["carrierId"], visitId: string, raw: unknown): ParkSnapshot {
    if (!record(raw) || Object.keys(raw).some(key => !["field", "at", "baseVersion", "distanceKm", "energyKwh"].includes(key)) || typeof raw.baseVersion !== "string" || !(PARK_LIFECYCLE_FIELDS as readonly unknown[]).includes(raw.field)) return fail("请提交当前车次版本及本次生命周期操作。");
    const field = raw.field as ParkLifecycleField, snapshot = this.snapshot(), previous = snapshot.visits.find(row => row.visitId === visitId && row.carrierId === carrierId);
    if (!previous) throw error("visit_missing", "当前承运商下未找到该车次。", 404);
    if (field !== "departedAt" && (raw.distanceKm !== undefined || raw.energyKwh !== undefined)) return fail("完整行程的里程和电耗只在离园时记录。");
    // Retrying a confirmed operation must not replace its real timestamp or repeat side effects.
    if (previous[field] !== undefined) {
      if (raw.at !== undefined && parseParkTimestamp(raw.at) !== previous[field] || raw.distanceKm !== undefined && raw.distanceKm !== previous.distanceKm || raw.energyKwh !== undefined && raw.energyKwh !== previous.energyKwh) throw error("visit_changed", "该阶段已记录；如需调整，请使用记录更正。", 409);
      return this.forCarrier(carrierId);
    }
    this.checkVisitVersion(carrierId, previous, raw.baseVersion, snapshot.version);
    const nextIndex = PARK_LIFECYCLE_FIELDS.findLastIndex(key => previous[key] !== undefined) + 1;
    if (PARK_LIFECYCLE_FIELDS[nextIndex] !== field) return fail("请按入园、开始作业、结束作业、离园的顺序操作。");
    const now = Date.now(), at = raw.at === undefined ? now : parseParkTimestamp(raw.at), visit = validateParkVisits([{ ...previous, [field]: at, ...(raw.distanceKm === undefined ? {} : { distanceKm: raw.distanceKm }), ...(raw.energyKwh === undefined ? {} : { energyKwh: raw.energyKwh }) }], now)[0];
    this.importCarrier(carrierId, snapshot.visits.filter(row => row.carrierId === carrierId).map(row => row.visitId === visitId ? visit : row), snapshot.version);
    return this.forCarrier(carrierId);
  }
  correctCarrier(carrierId: ParkVisit["carrierId"], visitId: string, raw: unknown): ParkSnapshot {
    if (!record(raw) || Object.keys(raw).some(key => !["visit", "baseVersion"].includes(key)) || !record(raw.visit) || typeof raw.baseVersion !== "string") return fail("请提交完整的更正记录及当前车次版本。");
    const snapshot = this.snapshot(), previous = snapshot.visits.find(row => row.visitId === visitId && row.carrierId === carrierId);
    if (!previous) throw error("visit_missing", "当前承运商下未找到该车次。", 404);
    this.checkVisitVersion(carrierId, previous, raw.baseVersion, snapshot.version);
    const visit = validateParkVisits([raw.visit])[0];
    if (visit.carrierId !== carrierId || visit.visitId !== visitId || visit.vehicleId !== previous.vehicleId) return fail("更正记录不能改变车牌、承运商或车次编号。");
    if (visit.departedAt === undefined && snapshot.visits.some(row => row.visitId !== visitId && row.vehicleId === visit.vehicleId && row.departedAt === undefined)) throw error("vehicle_already_in_park", "该车辆已有另一条未离园记录，请核对后更正。", 409);
    this.importCarrier(carrierId, snapshot.visits.filter(row => row.carrierId === carrierId).map(row => row.visitId === visitId ? visit : row), snapshot.version);
    return this.forCarrier(carrierId);
  }
  appendCarrier(carrierId: ParkVisit["carrierId"], visits: unknown, baseVersion: unknown): ParkSnapshot {
    if (!Array.isArray(visits) || !visits.length) return fail("请先载入需要追加的本方车次记录。");
    const current = this.snapshot();
    this.importCarrier(carrierId, [...current.visits.filter(row => row.carrierId === carrierId), ...visits], baseVersion);
    return this.forCarrier(carrierId);
  }
  private checkVisitVersion(carrierId: ParkVisit["carrierId"], previous: ParkVisit, baseVersion: string, currentVersion: string) {
    if (baseVersion === currentVersion) return;
    const before = /^[a-f0-9-]{36}$/.test(baseVersion) && existsSync(join(this.folder, baseVersion, "catalog.json")) ? readParkVisits(this.security, baseVersion, carrierId).find(row => row.visitId === previous.visitId) : undefined;
    if (!before || canonical(before) !== canonical(previous)) throw error("visit_changed", "该车次已更新，请重新载入后核对；当前填写内容仍保留。", 409);
  }
  importCarrier(carrierId: ParkVisit["carrierId"], value: unknown, baseVersion: unknown) {
    const current = this.snapshot(), own = current.visits.filter(visit => visit.carrierId === carrierId);
    if (baseVersion !== current.version) {
      let previous: ParkVisit[] | undefined;
      if (typeof baseVersion === "string" && /^[a-f0-9-]{36}$/.test(baseVersion) && existsSync(join(this.folder, baseVersion, "catalog.json"))) previous = readParkVisits(this.security, baseVersion, carrierId);
      if (!previous || canonical(previous) !== canonical(own)) throw error("dataset_changed", "本承运商的车次已更新，请重新载入并核对，当前草稿仍保留。", 409);
    }
    if (!Array.isArray(value) || value.some(row => !record(row) || row.carrierId !== carrierId)) throw error("carrier_scope_forbidden", "当前角色只能登记和修改本承运商的车次。", 403);
    const next = [...current.visits.filter(visit => visit.carrierId !== carrierId), ...validateParkVisits(value)], ids = new Set<string>(), arrivals = new Set<string>(), owners = new Map<string, string>();
    if (next.length > MAX_PARK_VISITS) return fail("园区当前全部车次最多" + MAX_PARK_VISITS + "条。");
    for (const visit of next) {
      if (ids.has(visit.visitId)) return fail("车次编号与已有记录重复，请使用新的车次编号。"); ids.add(visit.visitId);
      const owner = owners.get(visit.vehicleId), arrival = visit.vehicleId + ":" + visit.arrivedAt;
      if (owner && owner !== visit.carrierId) return fail("该车牌已有其他承运商的车次，不能跨承运商登记。");
      if (arrivals.has(arrival)) return fail("同一车牌、同一到达时间重复，不能重复计数。"); owners.set(visit.vehicleId, visit.carrierId); arrivals.add(arrival);
    }
    this.publish(next, current.catalog.settings); return this.forCarrier(carrierId).catalog;
  }
  /** Re-key only current business snapshots; frozen inputs and signed evidence retain their original bytes. */
  previewVehicleIdentities(aliases: VehicleIdentityAlias[]): ParkVisit[] {
    const replacements = new Map(aliases.map(alias => [alias.from, alias])), owners = new Map<string, string>(), arrivals = new Set<string>();
    return this.snapshot().visits.map(visit => {
      const alias = replacements.get(visit.vehicleId);
      if (alias && alias.carrierId !== visit.carrierId) return fail("旧车辆记录的承运商归属冲突，请先核对车次。");
      const next = alias ? { ...visit, vehicleId: alias.to } : visit, owner = owners.get(next.vehicleId), arrival = next.vehicleId + ":" + next.arrivedAt;
      if (owner && owner !== next.carrierId) return fail("同一车牌不能归属于不同承运商，请先核对车次。");
      if (arrivals.has(arrival)) return fail("补录车牌后出现同车同一到达时间的重复车次，请先核对车次。");
      owners.set(next.vehicleId, next.carrierId); arrivals.add(arrival); return next;
    });
  }
  reidentifyVehicles(aliases: VehicleIdentityAlias[]) {
    if (!aliases.length) return;
    const before = this.snapshot(), after = this.previewVehicleIdentities(aliases);
    if (canonical(before.visits) !== canonical(after)) this.publish(after, before.catalog.settings);
  }
  private checkVersion(baseVersion: unknown) {
    if (typeof baseVersion !== "string" || baseVersion !== this.catalog().version) throw error("dataset_changed", "园区数据或名称已更新，请重新载入后保存；当前草稿仍保留。", 409);
  }
  import(visits: unknown, baseVersion: unknown) { this.checkVersion(baseVersion); return this.publish(validateParkVisits(visits), this.catalog().settings); }
  configure(settings: unknown, baseVersion: unknown) { this.checkVersion(baseVersion); return this.publish(this.snapshot().visits, validateParkSettings(settings)); }
  private publish(visits: ParkVisit[], settings: ParkSettings): ParkCatalog {
    if (visits.some(visit => !this.owners.includes(visit.carrierId))) throw error("carrier_scope_forbidden", "不能在本部署保存其他企业的车次。", 403);
    const version = randomUUID(), folder = join(this.folder, version), updatedAt = Date.now(); mkdirSync(folder);
    for (const carrier of this.bindings) {
      const key = readFileSync(join(this.security.root, carrier.participant, "input.key"));
      atomicWrite(join(folder, `${carrier.participant}.enc.json`), canonical(seal(visits.filter(v => v.carrierId === carrier.id), key, `park:${version}:${carrier.participant}`)));
    }
    const catalog = this.describe(visits, settings, version, updatedAt);
    atomicWrite(join(folder, "catalog.json"), canonical(catalog));
    // Switch the public pointer only once the immutable three-owner snapshot is complete.
    atomicWrite(join(this.folder, "catalog.json"), canonical(catalog)); return catalog;
  }
  private describe(visits: ParkVisit[], settings: ParkSettings, version: string, updatedAt: number): ParkCatalog {
    const roads = [...new Set(visits.map(v => v.road))].sort().map(id => {
      const rows = visits.filter(v => v.road === id), projected = projectParkVisits(rows, { cohort: "arrivals" } as StatisticsQuery);
      return { id, vehicleCount: new Set(rows.map(v => v.vehicleId)).size, sampleCount: rows.length, start: Math.min(...rows.map(v => v.arrivedAt)), end: Math.max(...rows.flatMap(v => PARK_EVENT_FIELDS.flatMap(field => v[field] === undefined ? [] : [v[field]!]))), fields: PARK_FIELDS.filter(field => projected.some(row => row[field] !== undefined)) };
    });
    const catalog: ParkCatalog = { dataset: "park_visits", version, source: "import", updatedAt, settings, visitCount: visits.length, completedCount: visits.filter(v => v.departedAt !== undefined).length, vehicleCount: new Set(visits.map(v => v.vehicleId)).size, sampleCount: visits.length, roads, nodes: CARRIER_BINDINGS.map(c => { const rows = visits.filter(v => v.carrierId === c.id); return { id: c.participant, vehicleCount: new Set(rows.map(v => v.vehicleId)).size, sampleCount: rows.length }; }) };
    return catalog;
  }
}
export function readParkCatalog(security: Security, version: string): ParkCatalog {
  if (!/^[a-f0-9-]{36}$/.test(version)) throw error("invalid_dataset", "园区快照版本无效。", 403);
  return JSON.parse(readFileSync(join(security.root, "park", version, "catalog.json"), "utf8"));
}
export function readParkVisits(security: Security, version: string, participant: string): ParkVisit[] {
  if (!/^[a-f0-9-]{36}$/.test(version) || !CARRIER_BINDINGS.some(c => c.participant === participant)) throw error("invalid_dataset", "园区快照版本或承运商节点无效。", 403);
  const key = readFileSync(join(security.root, participant, "input.key"));
  return unseal(JSON.parse(readFileSync(join(security.root, "park", version, `${participant}.enc.json`), "utf8")), key, `park:${version}:${participant}`) as ParkVisit[];
}

export const PARK_PLANNING_GUIDE = `你正在为物流园区的三家承运商执行联合运营分析。必须调用 submit_statistics_plan，提交 dataset=park_visits 和 cohort。缺省 cohort=arrivals，以 arrivedAt 按到达时间选车次，包含尚未离园车次；用户明确查询离园吞吐或本时段离园车次时用 departures，以 departedAt 选取。不得把两种口径混用。园区固定为东入口、南入口、西入口、北入口。用户提到东门、南门、西门、北门时，分别使用对应的固定入口名。用户未指定入口时查询全部四个入口；没有车次的入口也保留，其结果按实际空数据说明；缺省今天截至当前时刻，缺省指标为车次数、车辆数、平均入口排队时长、平均周转时长。各入口分别统计。start 含、end 不含，上海时区，最多31天。
每次进园为一个全局唯一 visitId，同一车辆重复进园计多个车次。count=车次数；vehicle_count=各入口去重车辆数，跨入口不能直接相加。三个计算节点分别属于三家承运商，不是三辆车。所有节点都参与协议，但应报告所选范围实际有数据的承运商数量。
允许字段：queueMinutes=到达入口队列至开始入园核验的分钟数；gateMinutes=开始核验至完成入园的分钟数；yardWaitMinutes=到达作业等候区至开始作业的分钟数；serviceMinutes=开始至结束作业的分钟数；turnaroundMinutes=到达入口队列至离园的分钟数。缺少任一端点即缺失，不补零，不把入园至作业的全部时间当作排队。未完成车次不提供完整周转时长。
completed=是否已离园，0或1。完成率用 ratio + filter completed eq 1；未完成车次数用 count + filter completed eq 0。appointmentOnTime=到达是否处于[预约开始,预约结束)，0或1，缺少预约时不提供该字段；准点率用 ratio + filter appointmentOnTime eq 1。超30分钟排队比例用 ratio + filter queueMinutes gt 30，分母是有完整排队端点的车次，不能把缺失记录算成未超时。
distanceKm 和 energyKwh 为已离园车次完整行程增量，不是采样值或累计仪表值。总里程/总用电用 sum，单车次平均用电用 mean energyKwh，百公里用电用 ratio_of_sums energyKwh/distanceKm×100（分子分母均有值的车次）。只支持电能kWh，不将其称为柴油消耗、全部运输能耗或碳排放。
可组合操作 count、vehicle_count、sum、mean、variance总体方差、stddev总体标准差、ratio条件车次比例、ratio_of_sums总量比值；最多12指标。各均值按有效车次加权，不是各承运商均值等权。过滤只在各承运商本地进行。
没有中位数、分位数、最值、跨企业订单关联、自动预约调度、车辆轨迹、历史版本差分或因果推断能力。没有速度采样数据，不能用本表虚构平均速度。改善前后可分别发起明确日期区间的查询，在解释中提醒口径、样本和未完成车次差异。用户指定的指标无法表达时明确说明缺失能力，不静默替换。不索取原始车次或密钥，不生成任意代码代算。`;
