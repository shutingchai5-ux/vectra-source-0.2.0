import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CARRIER_BINDINGS, PARK_ENTRANCES, defaultParkSettings, sanitizeLogValue, shanghaiDay, type ParkVisit, type StatisticsQuery, type Task } from "@vectra/shared";
import { ParkData, projectParkVisits, readParkVisits, validateParkVisits, validateParkSettings } from "../src/park";
import { approveStatisticsQuery, finishVector, localVector, validateQuery, validateStatisticsOutput } from "../src/statistics";
import { Security, atomicWrite, canonical, seal } from "../src/security";
import { startServer } from "../src/index";
import { config } from "../src/config";
import { configureFixtureModels } from "./fixtures";

const anchor = Date.parse("2026-10-23T00:00:00+08:00"), minute = 60000;
const visit = (id: string, carrierId: ParkVisit["carrierId"], arrivedMinute: number, queue?: number, turnaround?: number, vehicleId = "沪" + carrierId.slice(-1).toUpperCase() + "12345"): ParkVisit => ({ visitId: id, carrierId, vehicleId, road: "东入口", arrivedAt: anchor + arrivedMinute * minute, ...(queue === undefined ? {} : { gateStartedAt: anchor + (arrivedMinute + queue) * minute }), ...(turnaround === undefined ? {} : { departedAt: anchor + (arrivedMinute + turnaround) * minute, distanceKm: 10, energyKwh: 2 }) });
const visits = () => [visit("raw-visit-a1", "carrier-a", 60, 10, 90, "沪A12345"), visit("raw-visit-a2", "carrier-a", 300, 30, 120, "沪A12345"), visit("raw-visit-b1", "carrier-b", 80, 50, 180), visit("raw-visit-c1", "carrier-c", 100)];
const query = (): StatisticsQuery => ({ dataset: "park_visits", cohort: "arrivals", roads: ["东入口"], start: anchor, end: anchor + 86400000, timeZone: "Asia/Shanghai", metrics: [{ label: "车次数", operation: "count" }, { label: "车辆数", operation: "vehicle_count" }, { label: "平均排队", operation: "mean", field: "queueMinutes" }, { label: "排队超30分钟", operation: "ratio", filter: { field: "queueMinutes", op: "gt", value: 30 } }, { label: "平均周转", operation: "mean", field: "turnaroundMinutes" }, { label: "未完成车次", operation: "count", filter: { field: "completed", op: "eq", value: 0 } }, { label: "总用电", operation: "sum", field: "energyKwh" }, { label: "百公里用电", operation: "ratio_of_sums", field: "energyKwh", denominatorField: "distanceKm", multiplier: 100 }] });
function aggregate(rows: ParkVisit[], q = query()) { const vectors = CARRIER_BINDINGS.map(c => localVector(projectParkVisits(rows.filter(v => v.carrierId === c.id), q), q)); return finishVector(vectors[0].map((_, i) => vectors.reduce((sum, vector) => sum + vector[i], 0n)), q); }

test("arrival wording and queue thresholds do not prevent the server locking today or the default park window", () => {
  const now = Date.parse("2026-10-30T14:00:00+08:00"), midnight = Date.parse(`${shanghaiDay(now)}T00:00:00+08:00`);
  for (const request of ["统计今天到达的车次数和排队超过30分钟的比例", "统计东门今天截至当前的到达车次和平均周转时长", "了解东入口运行情况"]) {
    const approved = approveStatisticsQuery(request, { ...query(), start: 0, end: midnight + 86400000 }, undefined, now);
    expect(approved.start).toBe(midnight); expect(approved.end).toBe(now);
  }
  expect(() => approveStatisticsQuery("统计今天16:00至17:00到达车次", { ...query(), start: midnight + 16 * 3600000, end: midnight + 17 * 3600000 }, undefined, now)).toThrow(/未来/);
});

test("park import validates explicit ownership, visit uniqueness, actual chronology and Shanghai calendar dates", () => {
  expect(validateParkSettings(defaultParkSettings()).carriers).toHaveLength(3);
  expect(defaultParkSettings().entranceRoads).toEqual([...PARK_ENTRANCES]);
  for (const entranceRoads of [[], ["东入口", "南入口", "西入口"], [...PARK_ENTRANCES, "第五入口"], ["东入口", "东入口", "西入口", "北入口"]]) expect(() => validateParkSettings({ ...defaultParkSettings(), entranceRoads })).toThrow(/固定/);
  for (const road of ["第五入口", "S101", "东门入口"]) expect(() => validateParkVisits([{ ...visits()[0], road }])).toThrow(/实际入口/);
  expect(() => validateParkSettings({ ...defaultParkSettings(), carriers: defaultParkSettings().carriers.slice(1) })).toThrow();
  expect(() => validateParkSettings({ ...defaultParkSettings(), carriers: defaultParkSettings().carriers.map(c => ({ ...c, name: "重复名称" })) })).toThrow();
  const rows = visits(); expect(validateParkVisits(rows)).toHaveLength(4);
  for (const bad of [[{ ...rows[0], carrierId: undefined }], [rows[0], { ...rows[0], visitId: "different" }], [rows[0], { ...rows[1], carrierId: "carrier-b" }], [{ ...rows[0], gateStartedAt: rows[0].arrivedAt - 1 }], [{ ...rows[0], arrivedAt: Date.now() + minute }], [{ ...rows[0], arrivedAt: "2026-02-30T08:00:00+08:00" }], [{ ...rows[3], energyKwh: 1 }], [{ ...rows[0], appointmentStart: rows[0].arrivedAt }], [{ ...rows[0], departedAt: rows[0].arrivedAt + 32 * 86400000 }]]) expect(() => validateParkVisits(bad)).toThrow();
  const parsed = validateParkVisits([{ ...rows[0], arrivedAt: "2026-10-23T01:00:00" }])[0]; expect(parsed.arrivedAt).toBe(anchor + 60 * minute);
});

test("park cohorts keep repeated visits distinct, exclude missing endpoints and weight actual visits", () => {
  const q = validateQuery(query()), result = aggregate(visits(), q)[0];
  expect(result.coverage).toEqual({ visits: 4, completed: 3, unfinished: 1, contributingCarriers: 3 });
  expect(result.metrics.map(m => m.value)).toEqual([4, 3, 30, 33.333333, 130, 1, 6, 20]);
  expect(result.metrics.map(m => m.validSamples)).toEqual([4, 4, 3, 3, 3, 1, 3, 3]); expect(result.metrics[0].unit).toBe("车次");
  const departed = aggregate(visits(), { ...q, cohort: "departures", start: anchor + 200 * minute, end: anchor + 440 * minute })[0];
  expect(departed.coverage).toEqual({ visits: 2, completed: 2, unfinished: 0, contributingCarriers: 2 });
  const partial = aggregate(visits().filter(v => v.carrierId === "carrier-c"))[0]; expect(partial.metrics[2].value).toBeNull(); expect(partial.metrics[2].validSamples).toBe(0);
  const appointment = { ...visits()[0], appointmentStart: visits()[0].arrivedAt, appointmentEnd: visits()[0].arrivedAt + minute };
  expect(projectParkVisits([appointment], q)[0].appointmentOnTime).toBe(1);
  expect(projectParkVisits([{ ...appointment, appointmentStart: appointment.arrivedAt - minute, appointmentEnd: appointment.arrivedAt }], q)[0].appointmentOnTime).toBe(0);
  expect(() => validateQuery({ ...q, metrics: [{ label: "速度", operation: "mean", field: "speed" }] })).toThrow();
  expect(() => validateQuery({ ...q, cohort: undefined })).toThrow(); expect(() => validateQuery({ ...q, end: Date.now() + 60000 })).toThrow();
  expect(validateStatisticsOutput([result], q)).toHaveLength(1); expect(() => validateStatisticsOutput([{ ...result, coverage: { ...result.coverage, completed: 99 } }], q)).toThrow();
  const fourEntrances = validateQuery({ ...q, roads: [...PARK_ENTRANCES] }, { dataset: "park_visits", roads: [{ id: "东入口" }] } as any);
  const all = aggregate(visits(), fourEntrances); expect(all.map(group => group.road)).toEqual([...PARK_ENTRANCES]);
  for (const group of all.slice(1)) { expect(group.coverage).toEqual({ visits: 0, completed: 0, unfinished: 0, contributingCarriers: 0 }); expect(group.metrics.slice(0, 3).map(metric => metric.value)).toEqual([0, 0, null]); }
  expect(() => validateQuery({ ...q, roads: ["第五入口"] })).toThrow(/固定/);
});

test("fixed entrance upgrade normalises known names once and leaves frozen historical snapshots intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-park-entrances-"));
  try {
    const security = await Security.open(join(root, "pki")), park = new ParkData(security), published = park.import(visits(), park.catalog().version);
    const catalog = { ...published, settings: { ...published.settings, entranceRoads: ["东门入口", "西门入口"] }, roads: published.roads.map(road => ({ ...road, id: "东门入口" })) };
    for (const carrier of CARRIER_BINDINGS) {
      const key = readFileSync(join(security.root, carrier.participant, "input.key")), rows = visits().filter(visit => visit.carrierId === carrier.id).map(visit => ({ ...visit, road: "东门入口" }));
      atomicWrite(join(security.root, "park", published.version, carrier.participant + ".enc.json"), canonical(seal(rows, key, "park:" + published.version + ":" + carrier.participant)));
    }
    for (const file of [join(security.root, "park", "catalog.json"), join(security.root, "park", published.version, "catalog.json")]) atomicWrite(file, canonical(catalog));
    const upgraded = new ParkData(security); expect(upgraded.catalog().settings.entranceRoads).toEqual([...PARK_ENTRANCES]); expect(upgraded.catalog().version).not.toBe(published.version);
    expect(upgraded.snapshot().visits).toEqual(visits()); expect(readParkVisits(security, published.version, "carrier-a")[0].road).toBe("东门入口");
    expect(new ParkData(security).catalog().version).toBe(upgraded.catalog().version);
  } finally { if (resolve(root).startsWith(resolve(tmpdir(), "vectra-park-entrances-"))) rmSync(root, { recursive: true, force: true }); }
});

test("park snapshots keep each owner separate, reject stale writes and preserve frozen names and data", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-park-data-"));
  try {
    const security = await Security.open(join(root, "pki")), park = new ParkData(security); expect(park.catalog().visitCount).toBe(0);
    const initial = park.catalog(), published = park.import(visits(), initial.version);
    for (const c of CARRIER_BINDINGS) expect(readParkVisits(security, published.version, c.participant).every(v => v.carrierId === c.id)).toBeTrue();
    expect(() => park.import([], initial.version)).toThrow(/更新/);
    const settings = defaultParkSettings(); settings.name = "联合分析园区"; settings.carriers[0].name = "第一承运商";
    const renamed = park.configure(settings, published.version); expect(renamed.settings.name).toBe("联合分析园区"); expect(published.settings.name).not.toBe(renamed.settings.name);
    park.import([], renamed.version); expect(park.snapshot().visits).toHaveLength(0); expect(readParkVisits(security, published.version, "carrier-a")).toHaveLength(2);
    const ownHistory = park.forCarrier("carrier-a", published.version);
    expect(ownHistory.version).toBe(published.version); expect(ownHistory.visits).toEqual(visits().filter(visit => visit.carrierId === "carrier-a"));
    expect(ownHistory.catalog.nodes.map(node => node.id)).toEqual(["carrier-a"]); expect(ownHistory.catalog.settings.name).toBe(published.settings.name);
    expect(park.forCarrier("carrier-a").visits).toHaveLength(0);
    expect(() => park.forCarrier("carrier-a", "../outside")).toThrow("快照版本无效");
    expect(() => new ParkData(security, ["carrier-a"]).forCarrier("carrier-b", published.version)).toThrow("本部署不持有");
    expect(readFileSync(join(root, "pki", "park", published.version, "carrier-a.enc.json"), "utf8")).not.toContain("raw-visit-a1");
  } finally { if (resolve(root).startsWith(resolve(tmpdir(), "vectra-park-data-"))) rmSync(root, { recursive: true, force: true }); }
});

test("three-carrier API task executes real workers, binds coverage and report, and excludes raw visits from logs and model", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-park-flow-")), original = globalThis.fetch;
  const live = await startServer({ ...config(), dataDir: root, logDir: join(root, "logs"), port: 0, cooldown: 0, mpcTimeout: 25000 });
  const base = `http://127.0.0.1:${live.server.port}`, cookie = (await original(base + "/api/session")).headers.get("set-cookie")!.split(";")[0];
  let carrierToken = "";
  const send = (path: string, method = "GET", value?: unknown, headers = {}) => original(base + path, { method, headers: { Cookie: cookie, "Content-Type": "application/json", "X-Carrier-Role": carrierToken, ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  let modelInput = "";
  try {
    let catalog = await (await send("/api/park")).json();
    expect((await original(base + "/api/park/records")).status).toBe(401); expect((await send("/api/park/records", "GET", undefined, { Origin: "https://attacker.invalid" })).status).toBe(403);
    for (const carrier of CARRIER_BINDINGS) {
      carrierToken = (await (await send("/api/carrier-role", "POST", { carrierId: carrier.id })).json()).token;
      const imported = await send("/api/park", "POST", { visits: visits().filter(row => row.carrierId === carrier.id), baseVersion: catalog.version }); expect(imported.status).toBe(201); catalog = await imported.json();
    }
    expect((await send("/api/park", "POST", { visits: [], baseVersion: "stale" })).status).toBe(409);
    configureFixtureModels(live.app, "park-fixture-key");
    globalThis.fetch = Object.assign(async (_url: unknown, options?: RequestInit) => {
      const body = String(options?.body); modelInput += body; const payload = JSON.parse(body), names = payload.tools.map((t: any) => t.function.name), last = payload.messages.at(-1);
      const call = (name: string, args = {}) => Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
      if (names.includes("submit_statistics_plan")) return call("submit_statistics_plan", query());
      if (names.includes("submit_analysis")) return last.role === "user" ? call("query_events") : call("submit_analysis", { facts: ["批准结果包含4个车次"], possibleCauses: ["入口资源配置需要结合班次复核"], recommendations: ["人工比较预约时段与作业安排"], uncertainties: ["尚有未离园车次，不能用完成均值代表全部车次"], evidenceIds: [JSON.parse(last.content).events[0].id] });
      return last.role === "user" ? call("compute_statistics") : Response.json({ choices: [{ message: { role: "assistant", content: "联合统计已返回，平均排队30分钟；建议结合未完成车次人工评估预约时段。" } }] });
    }, { preconnect: original.preconnect }) as typeof fetch;
    const submitted = await send("/api/tasks", "POST", { request: "统计东入口2026年10月23日到达的车次、排队、周转和运输用电，保护三家承运商输入并生成签名报告。", requestId: randomUUID(), intent: "statistics" });
    const created = await submitted.json() as Task; let task = created; const deadline = Date.now() + 30000;
    while (["queued", "running"].includes(task.status) && Date.now() < deadline) { await Bun.sleep(30); task = live.app.store.task(task.id)!; }
    expect(task.error, JSON.stringify(task.error)).toBeUndefined(); expect(task.status).toBe("completed");
    expect(task.result?.groups?.[0]).toEqual(aggregate(visits())[0]); expect(task.plan.datasetVersion).toBe(catalog.version); expect(task.plan.parkContext?.settings.carriers).toHaveLength(3);
    expect(new Set(task.steps.filter(s => s.metadata.source === "worker").map(s => s.agent)).size).toBe(3);
    const registered = new Set(live.app.security.nodes().map(node => node.id));
    for (const step of task.steps) for (const identity of [step.agent, step.sender, step.recipient]) if (identity) expect(registered.has(identity)).toBeTrue();
    expect(new Set(task.steps.filter(step => step.kind === "model").map(step => step.agent))).toEqual(new Set(["coordinator", "planner", "analyst"]));
    expect(task.analysis).toBeDefined(); const report = live.app.report(task.id); expect(live.app.verifyReport(report).valid).toBeTrue();
    expect((report.payload.result as any).query.cohort).toBe("arrivals"); expect((report.payload.plan as any).parkContext).toEqual(task.plan.parkContext);
    const changed = structuredClone(report); (changed.payload.result as any).groups[0].coverage.visits++; expect(live.app.verifyReport(changed).valid).toBeFalse();
    const renamed = defaultParkSettings(); renamed.name = "后续新园区名"; live.app.park.configure(renamed, catalog.version); expect(live.app.verifyReport(report).valid).toBeTrue(); expect(task.result?.parkContext?.settings.name).not.toBe(renamed.name);
    const logs = ["conversations", "operations"].flatMap(channel => readdirSync(join(root, "logs", channel)).filter(f => f.endsWith(".jsonl")).map(f => readFileSync(join(root, "logs", channel, f), "utf8"))).join("");
    expect(logs).not.toContain("raw-visit-a1"); expect(logs).not.toContain("沪A12345"); expect(modelInput).not.toContain("raw-visit-a1"); expect(modelInput).not.toContain("沪A12345");
    expect(sanitizeLogValue({ visits: visits(), vehicleId: "沪A12345" })).toEqual({ visits: "[REDACTED]", vehicleId: "[REDACTED]" });
  } finally { globalThis.fetch = original; await live.close(); if (resolve(root).startsWith(resolve(tmpdir(), "vectra-park-flow-"))) rmSync(root, { recursive: true, force: true }); }
}, 45000);
