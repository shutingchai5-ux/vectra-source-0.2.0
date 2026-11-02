import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { BUSINESS_DOMAINS, type BusinessDomain, type CarrierId, type StatisticsRecord } from "@vectra/shared";
import { ROOT } from "../apps/server/src/config";
import { readDeployment } from "../apps/server/src/deployment";
import { Security, canonical, atomicWrite, hash } from "../apps/server/src/security";
import { ParkData, projectParkVisits } from "../apps/server/src/park";
import { FleetData } from "../apps/server/src/fleet";
import { ReservationData, projectReservations } from "../apps/server/src/reservations";
import { BusinessData, projectBusiness } from "../apps/server/src/business";
import { FederatedPark } from "../apps/server/src/federation-park";
import { validateQuery, localVector, finishVector } from "../apps/server/src/statistics";
import { buildStatisticsDay, statisticsDayQueries } from "./statistics-day";

function append<T>(before: T[], additions: T[], key: (row: T) => string, retainExisting = false): T[] {
  const rows = new Map(before.map(row => [key(row), row]));
  for (const row of additions) {
    const previous = rows.get(key(row));
    if (previous && canonical(previous) !== canonical(row) && !retainExisting) throw new Error("记录已存在且内容不同，未覆盖：" + key(row));
    if (!previous) rows.set(key(row), row);
  }
  return [...rows.values()];
}
const option = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const data = buildStatisticsDay(option("--date") ?? "2026-11-05"), apply = process.argv.includes("--apply");
if (data.end > Date.now() && !process.argv.includes("--allow-future-events")) throw new Error("该日期包含未来车次；只有明确授权的离线数据填充可使用 --allow-future-events，HTTP 事件与统计时间校验保持不变。");
const cacheRoot = join(ROOT, "node_modules/.cache"), staging = mkdtempSync(join(cacheRoot, "statistics-day-"));
const domains = Object.keys(BUSINESS_DOMAINS) as BusinessDomain[];
type Pointer = { actual: string; staged: string; before: string; after?: string; payload?: string; targetPayload?: string };
const pointers: Pointer[] = [];
const stagedCompanies = new Map<CarrierId, { park: ParkData; fleet: FleetData; reservations: ReservationData; business: BusinessData }>();
try {
  const identities = ["park", ...data.carriers.map(carrier => carrier.owner)];
  const roots = new Map<string, { actual: string; staged: string; dataDir: string }>();
  for (const identity of identities) {
    const deployment = readDeployment(join(ROOT, "runtime-deploy", identity, "deployment.json"));
    if (!resolve(deployment.dataDir).startsWith(resolve(ROOT) + sep)) throw new Error("数据目录不在当前项目内，未写入。");
    const actual = join(deployment.dataDir, "pki"), staged = join(staging, identity);
    if (!existsSync(join(actual, "registry.json"))) throw new Error("现有身份目录不存在，未初始化或替换密钥。");
    cpSync(actual, staged, { recursive: true });
    roots.set(identity, { actual, staged, dataDir: deployment.dataDir });
    const files = identity === "park" ? ["reservations/catalog.json", "charging-capacity/current.json"] : ["fleet/catalog.json", "park/catalog.json", "reservations/catalog.json", ...domains.map(domain => `business/${domain}/catalog.json`)];
    for (const file of files) pointers.push({ actual: join(actual, file), staged: join(staged, file), before: readFileSync(join(staged, file), "utf8") });
  }
  const summary: unknown[] = [];
  for (const carrier of data.carriers) {
    const location = roots.get(carrier.owner)!, security = await Security.open(location.staged);
    const park = new ParkData(security, [carrier.owner]), fleet = new FleetData(security, park, [carrier.owner]);
    const reservations = new ReservationData(security, () => park.catalog().settings, [carrier.owner]), business = new BusinessData(security, carrier.owner, park, fleet);
    const previousVisits = park.snapshot().visits.length;
    const profiles = fleet.profiles().map(({ updatedAt, ...row }) => row);
    const vehicles = append(profiles, carrier.vehicles, row => row.vehicleId);
    if (vehicles.length !== profiles.length) fleet.save(carrier.owner, vehicles, fleet.catalog().version, true);
    const oldVisits = park.snapshot(), visits = append(oldVisits.visits, carrier.visits, row => row.visitId);
    if (visits.length !== oldVisits.visits.length) park.import(visits, oldVisits.version, Math.max(Date.now(), data.end));
    const oldReservations = reservations.forCarrier(carrier.owner);
    const slotKey = (row: { road: string; slotStart: number }) => row.road + ":" + row.slotStart;
    const slots = append(oldReservations.slots, carrier.reservations, slotKey, true);
    if (slots.length !== oldReservations.slots.length) reservations.replaceCarrier(carrier.owner, slots, oldReservations.version);
    for (const domain of domains) {
      const old = business.snapshot(domain);
      const additions = domain === "haulage" ? carrier.business.haulage.map(row => {
        const previous = old.records.find(value => value.id === row.id);
        return { ...row, sourceParkVersion: previous && "sourceParkVersion" in previous ? previous.sourceParkVersion : park.catalog().version };
      }) : carrier.business[domain];
      const records = append(old.records, additions, row => row.id);
      const declaration = { start: data.start, end: data.end };
      if (records.length !== old.records.length || canonical(old.catalog.declaration ?? null) !== canonical(declaration)) business.replace(domain, records, declaration, old.version, domain === "haulage" ? Math.max(Date.now(), data.end) : Date.now());
    }
    stagedCompanies.set(carrier.owner, { park, fleet, reservations, business });
    summary.push({ carrierId: carrier.owner, name: park.catalog().settings.carriers.find(item => item.id === carrier.owner)?.name, addedVehicles: vehicles.length - profiles.length, addedVisits: visits.length - previousVisits,
      dateVehicles: carrier.vehicles.length, dateVisits: carrier.visits.length, dateCompletedVisits: carrier.visits.filter(visit => visit.departedAt !== undefined).length,
      dateReservations: carrier.reservations.length, dateBusiness: Object.fromEntries(domains.map(domain => [domain, carrier.business[domain].length])), totalVisits: visits.length });
  }
  const parkRoot = roots.get("park")!, security = await Security.open(parkRoot.staged);
  const park = new ParkData(security, []), reservations = new ReservationData(security, () => park.catalog().settings, []);
  const beforeCapacity = reservations.catalog();
  const capacities = append(beforeCapacity.capacitySlots, data.capacities, row => row.road + ":" + row.slotStart, true);
  if (capacities.length !== beforeCapacity.capacitySlots.length) reservations.replaceCapacity(capacities, beforeCapacity.version);
  const federation = new FederatedPark(security, park, reservations, 20000), oldCharge = federation.charge();
  const charging = append(oldCharge.slots, data.chargeCapacities, row => row.road + ":" + row.slotStart + ":" + row.connector, true);
  if (charging.length !== oldCharge.slots.length) federation.saveCharge({ slots: charging, baseVersion: oldCharge.version });
  const queries = statisticsDayQueries(data), results = queries.map(query => {
    validateQuery(query, undefined, Math.max(Date.now(), data.end));
    const vectors = data.carriers.map(carrier => {
      const source = stagedCompanies.get(carrier.owner)!;
      let records: StatisticsRecord[];
      if (query.dataset === "park_visits") records = projectParkVisits(source.park.snapshot().visits, query);
      else if (query.dataset === "reservation_plans") records = projectReservations(source.reservations.forCarrier(carrier.owner).slots);
      else records = projectBusiness(source.business.snapshot(query.domain!).records, query);
      return localVector(records, query, query.domain ? source.business.catalog(query.domain).declaration : undefined);
    });
    const total = vectors[0].map((_, index) => vectors.reduce((sum, vector) => sum + vector[index], 0n));
    return { query, groups: finishVector(total, query) };
  });
  const changed = pointers.filter(pointer => {
    pointer.after = readFileSync(pointer.staged, "utf8");
    if (pointer.before === pointer.after) return false;
    const version = JSON.parse(pointer.after).version;
    if (typeof version !== "string" || !/^[a-f0-9-]{36}$/.test(version)) throw new Error("版本格式无效。");
    const payload = pointer.staged.endsWith("current.json") ? version + ".json" : version;
    pointer.payload = join(dirname(pointer.staged), payload); pointer.targetPayload = join(dirname(pointer.actual), payload);
    return true;
  });
  const report = { date: data.day, applied: apply, validationReferenceTime: data.end, queryCount: queries.length, companies: summary,
    entryCapacitySlots: data.capacities.length, chargingCapacitySlots: data.chargeCapacities.length, changedCatalogs: changed.length };
  if (apply) {
    const backup = join(ROOT, "runtime-deploy/backups", "statistics-" + data.day + "-" + Date.now()); mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, "catalog-pointers.json"), JSON.stringify(changed.map(({ actual, before, after }) => ({ actual, before: JSON.parse(before), after: JSON.parse(after!) })), null, 2));
    const db = new Database(join(parkRoot.dataDir, "vectra.sqlite3")); db.exec("PRAGMA busy_timeout=5000");
    try {
      for (const pointer of changed) {
        if (readFileSync(pointer.actual, "utf8") !== pointer.before) throw new Error("台账在准备期间已更新，请重新运行；尚未切换版本。");
        cpSync(pointer.payload!, pointer.targetPayload!, { recursive: true, errorOnExist: true, force: false });
      }
      db.transaction(() => {
        const switched: Pointer[] = [];
        try {
          for (const carrier of data.carriers) for (const vehicle of carrier.vehicles) {
            const digest = hash(vehicle.vehicleId), previous = db.query<{ owner: string }, [string]>("SELECT owner FROM federation_vehicle_owners WHERE plate_hash=?").get(digest);
            if (previous && previous.owner !== carrier.owner) throw new Error("新增车辆已归属其他承运商，未覆盖。");
            db.query("INSERT OR IGNORE INTO federation_vehicle_owners VALUES(?,?)").run(digest, carrier.owner);
          }
          for (const pointer of changed) {
            if (readFileSync(pointer.actual, "utf8") !== pointer.before) throw new Error("台账刚刚更新，本轮写入已回滚。");
            atomicWrite(pointer.actual, pointer.after!); switched.push(pointer);
          }
        } catch (cause) { for (const pointer of switched.reverse()) if (readFileSync(pointer.actual, "utf8") === pointer.after) atomicWrite(pointer.actual, pointer.before); throw cause; }
      }).immediate();
    } finally { db.close(); }
    writeFileSync(join(backup, "verification.json"), JSON.stringify({ ...report, results }, null, 2));
    console.log(JSON.stringify({ ...report, backup }, null, 2));
  } else console.log(JSON.stringify(report, null, 2));
} finally {
  if (resolve(staging).startsWith(resolve(cacheRoot, "statistics-day-"))) rmSync(staging, { recursive: true, force: true });
}
