import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CARRIER_BINDINGS, JOURNEY_STAGES, RESERVATION_SLOT_MS, reservationMetrics, reservationContextFor, coordinateReservations, summarizeBottleneck,
  shanghaiTimestamp, sanitizeLogValue, type ParkVisit, type StatisticsQuery, type Task, type ReservationSlot, type CapacitySlot } from "@vectra/shared";
import { validateParkVisits, projectParkVisits } from "../src/park";
import { approveStatisticsQuery, validateQuery, localVector, finishVector, validateStatisticsOutput } from "../src/statistics";
import { validateReservationRows, readReservationSlots, projectReservations } from "../src/reservations";
import { config } from "../src/config";
import { startServer } from "../src/index";
import { configureFixtureModels } from "./fixtures";

const now = Date.now(), slot = Math.ceil((now + 3600_000) / RESERVATION_SLOT_MS) * RESERVATION_SLOT_MS;
const planningQuery = (): StatisticsQuery => ({ dataset: "reservation_plans", roads: ["东入口"], start: slot, end: slot + 2 * RESERVATION_SLOT_MS, timeZone: "Asia/Shanghai", bucketMinutes: 30, metrics: reservationMetrics() });
function chain(index: number): ParkVisit {
  const row: Record<string, unknown> = { visitId: "private-chain-" + index, carrierId: CARRIER_BINDINGS[index].id, vehicleId: "沪" + String.fromCharCode(65 + index) + "12345", road: "东入口" };
  let at = now - 12 * 3600_000; row.dispatchReadyAt = at;
  for (const [i, stage] of JOURNEY_STAGES.entries()) { at += [10, 40, 20, 15, 5, 5, 25, 30, 10][i] * 60_000; row[stage.end] = at; }
  return row as unknown as ParkVisit;
}
function aggregate(rows: ReservationSlot[], query: StatisticsQuery) {
  const vectors = CARRIER_BINDINGS.map(carrier => localVector(projectReservations(rows.filter(row => row.carrierId === carrier.id)), query));
  return finishVector(vectors[0].map((_, index) => vectors.reduce((sum, vector) => sum + vector[index], 0n)), query);
}
const plans = (): ReservationSlot[] => CARRIER_BINDINGS.flatMap((carrier, index) => [
  { carrierId: carrier.id, road: "东入口", slotStart: slot, expectedTrips: 5 + index, availableTrips: 4, requiredWorkMinutes: 80 + index * 20 },
  { carrierId: carrier.id, road: "东入口", slotStart: slot + RESERVATION_SLOT_MS, expectedTrips: 0, availableTrips: 5, requiredWorkMinutes: 0 },
]);
const capacities = (): CapacitySlot[] => [
  { road: "东入口", slotStart: slot, entryCapacity: 10, serviceCapacityMinutes: 200 },
  { road: "东入口", slotStart: slot + RESERVATION_SLOT_MS, entryCapacity: 20, serviceCapacityMinutes: 300 },
];
test("cross-enterprise chronology and bottleneck ranking use a common complete cohort, not unrelated observed means", () => {
  const incomplete: ParkVisit = { visitId: "private-incomplete", carrierId: "carrier-a", vehicleId: "沪A90002", road: "东入口", arrivedAt: now - 20 * 3600_000, gateStartedAt: now - 5 * 3600_000 };
  const visits = validateParkVisits([...CARRIER_BINDINGS.map((_, index) => chain(index)), incomplete]);
  expect(() => validateParkVisits([{ ...chain(0), dispatchedAt: chain(0).dispatchReadyAt! - 1 }])).toThrow(/顺序/);
  expect(() => validateParkVisits([{ ...chain(0), dispatchReadyAt: Date.now() + 1000 }])).toThrow(/未来/);
  const query = approveStatisticsQuery("分析2026年跨企业瓶颈", { dataset: "park_visits", cohort: "arrivals", roads: ["东入口"], start: now - 86400_000, end: now, timeZone: "Asia/Shanghai", metrics: [] });
  expect(query.metrics).toHaveLength(20);
  const vectors = CARRIER_BINDINGS.map(carrier => localVector(projectParkVisits(visits.filter(visit => visit.carrierId === carrier.id), query), query));
  const groups = finishVector(vectors[0].map((_, index) => vectors.reduce((sum, vector) => sum + vector[index], 0n)), query);
  expect(validateStatisticsOutput(groups, query)).toEqual(groups);
  const result = summarizeBottleneck(groups[0]);
  expect(result.complete).toBe(3); expect(result.total).toBe(160);
  expect(result.ranking[0].label).toBe("运输在途"); expect(result.ranking[0].comparable).toBe(40);
  expect(result.stages.find(stage => stage.field === "queueMinutes")!.observed).toBeGreaterThan(200);
  expect(result.stages.find(stage => stage.field === "queueMinutes")!.comparable).toBe(15);
  const partial = projectParkVisits([incomplete], query)[0]; expect(partial.completeJourney).toBe(0); expect(partial.offsiteWaitMinutes).toBeUndefined();
  const zero = chain(0); for (const stage of JOURNEY_STAGES) zero[stage.end] = zero.dispatchReadyAt!;
  const zeroResult = summarizeBottleneck(finishVector(localVector(projectParkVisits(validateParkVisits([zero]), query), query), query)[0]);
  expect(zeroResult.complete).toBe(1); expect(zeroResult.total).toBe(0); expect(zeroResult.ranking).toEqual([]);
});
test("future plans have separate time policy, bounded frames, complete declarations and conservative capacity suggestions", () => {
  const query = validateQuery(planningQuery()), groups = aggregate(plans(), query), context = reservationContextFor(capacities(), query);
  expect(groups.map(group => group.metrics.map(metric => metric.value))).toEqual([[18, 12, 300], [0, 15, 0]]);
  expect(groups[0].planCoverage).toEqual({ declaredSlots: 3, contributingCarriers: 3 });
  expect(validateStatisticsOutput(groups, query)).toEqual(groups);
  const result = coordinateReservations(groups, context);
  expect(result.rows[0]).toMatchObject({ recommendedTrips: 10, transportGap: 6, entryGap: 8, workGapMinutes: 100, unarrangedTrips: 8 });
  expect(result.suggestions).toMatchObject([{ road: "东入口", from: slot, to: slot + RESERVATION_SLOT_MS, trips: 8 }]);
  expect(coordinateReservations(groups, reservationContextFor([], query)).rows[0].recommendedTrips).toBeNull();
  const missing = aggregate(plans().filter(row => row.carrierId !== "carrier-c"), query);
  expect(coordinateReservations(missing, context).rows.every(row => row.recommendedTrips === null)).toBeTrue();
  const hourly = { ...query, bucketMinutes: 60 };
  const partiallyDeclared = aggregate(plans().filter(row => !(row.carrierId === "carrier-c" && row.slotStart !== slot)), hourly);
  expect(coordinateReservations(partiallyDeclared, reservationContextFor(capacities(), hourly)).rows.some(row => row.inputMissing)).toBeTrue();
  expect(() => validateQuery({ ...query, dataset: "park_visits", cohort: "arrivals", bucketMinutes: undefined })).toThrow(/未来/);
  expect(() => validateQuery({ ...query, end: Date.now() + 32 * 86400_000 })).toThrow();
  expect(() => validateQuery({ ...query, roads: ["东入口", "南入口", "西入口", "北入口"], end: slot + 10 * 86400_000 })).toThrow(/分组过细/);
  expect(() => validateReservationRows([{ ...plans()[0], slotStart: slot + 1 }])).toThrow(/半点/);
  expect(() => validateReservationRows([{ ...plans()[0], expectedTrips: 0 }])).toThrow(/零需求/);
  const future = approveStatisticsQuery("统计东入口未来两小时预约需求与运力", { ...query, start: 0, end: 1 }, undefined, now);
  expect(future.start).toBe(now); expect(future.end).toBe(now + 2 * 3600_000);
  const tomorrow = approveStatisticsQuery("统计明天预约计划", query, undefined, now);
  expect(shanghaiTimestamp(tomorrow.start).slice(11, 16)).toBe("00:00"); expect(tomorrow.end - tomorrow.start).toBe(86400_000);
});
test("both scenarios run through role-scoped storage, three real MPC workers, independent Agent calls and signed frozen reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-operations-")), native = globalThis.fetch;
  const live = await startServer({ ...config(), dataDir: root, logDir: join(root, "logs"), port: 0, cooldown: 0, mpcTimeout: 30000, taskTimeout: 60000 });
  let chosen = planningQuery(), modelInputs = "";
  try {
    const url = "http://127.0.0.1:" + live.server.port, cookie = (await native(url + "/api/session")).headers.get("set-cookie")!.split(";")[0];
    const send = (path: string, method = "GET", value?: unknown, token?: string) => native(url + path, { method, headers: { Cookie: cookie, "Content-Type": "application/json", ...(token ? { "X-Carrier-Role": token } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    expect((await send("/api/carrier/reservations")).status).toBe(403);
    let lastVersion = live.app.reservations.catalog().version;
    for (const carrier of CARRIER_BINDINGS) {
      const role = await (await send("/api/carrier-role", "POST", { carrierId: carrier.id })).json();
      const snapshot = await (await send("/api/carrier/reservations", "GET", undefined, role.token)).json();
      const own = plans().filter(row => row.carrierId === carrier.id);
      expect((await send("/api/carrier/reservations", "PUT", { slots: plans().filter(row => row.carrierId !== carrier.id), baseVersion: snapshot.version }, role.token)).status).toBe(403);
      const saved = await send("/api/carrier/reservations", "PUT", { slots: own, baseVersion: snapshot.version }, role.token);
      expect(saved.status).toBe(200); lastVersion = (await saved.json()).version;
      expect((await (await send("/api/carrier/reservations", "GET", undefined, role.token)).json()).slots).toEqual(own);
      expect((await send("/api/carrier/reservations", "PUT", { slots: [], baseVersion: snapshot.version }, role.token)).status).toBe(409);
    }
    expect((await send("/api/reservations/capacity", "PUT", { capacitySlots: capacities(), baseVersion: lastVersion })).status).toBe(200);
    const frozen = live.app.reservations.catalog().version;
    expect(readFileSync(join(live.app.security.root, "reservations", frozen, "carrier-a.enc.json"), "utf8")).not.toContain("expectedTrips");
    expect(readReservationSlots(live.app.security, frozen, "carrier-a")).toEqual(plans().filter(row => row.carrierId === "carrier-a"));
    configureFixtureModels(live.app, "operations-fixture-key");
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!String(input).startsWith("https://example.invalid/")) return native(input, init);
      const body = String(init?.body); modelInputs += body; const payload = JSON.parse(body), names = payload.tools.map((tool: any) => tool.function.name), last = payload.messages.at(-1);
      const call = (name: string, args: unknown = {}) => Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
      if (names.includes("submit_statistics_plan")) return call("submit_statistics_plan", chosen);
      if (names.includes("submit_analysis")) return last.role === "user" ? call("query_events") : call("submit_analysis", { facts: ["已核对本轮批准的联合结果"], possibleCauses: [], recommendations: ["由相关承运商与园区人工核对"], uncertainties: ["申报计划不代表实际到园，观察耗时不能直接证明因果"], evidenceIds: [JSON.parse(last.content).events[0].id] });
      return last.role === "user" ? call("compute_statistics") : Response.json({ choices: [{ message: { role: "assistant", content: "本轮联合计算与证据分析已返回，协调建议尚未执行。" } }] });
    }, { preconnect: native.preconnect }) as typeof fetch;
    const run = async (request: string) => {
      const response = await send("/api/tasks", "POST", { request, requestId: randomUUID(), intent: "statistics" }); expect(response.status).toBe(202);
      let task = await response.json() as Task; const end = Date.now() + 45000;
      while (["queued", "running"].includes(task.status) && Date.now() < end) { await Bun.sleep(40); task = live.app.store.task(task.id)!; }
      expect(task.error).toBeUndefined(); expect(task.status).toBe("completed");
      expect(live.app.verifyReport(live.app.report(task.id)).valid).toBeTrue();
      expect(new Set(task.steps.filter(step => step.kind === "mpc" && step.action === "生成秘密分享多项式").map(step => step.agent))).toEqual(new Set(CARRIER_BINDINGS.map(carrier => carrier.id)));
      return task;
    };
    const futureTask = await run("分析东入口从" + shanghaiTimestamp(slot) + "至" + shanghaiTimestamp(slot + 2 * RESERVATION_SLOT_MS) + "的预约需求与运力协同");
    expect(futureTask.result?.coordination?.suggestions[0].trips).toBe(8);
    expect(live.app.park.snapshot().visits).toHaveLength(0);
    live.app.reservations.replaceCapacity(capacities().map(row => ({ ...row, entryCapacity: 0 })), frozen);
    expect(futureTask.result?.reservationContext?.capacities[0].entryCapacity).toBe(10);
    expect(live.app.report(futureTask.id).payload.plan).toEqual(futureTask.plan);
    const actual = live.app.park.import([...CARRIER_BINDINGS.map((_, index) => chain(index))], live.app.park.catalog().version);
    chosen = { dataset: "park_visits", cohort: "arrivals", roads: ["东入口"], start: now - 86400_000, end: now, timeZone: "Asia/Shanghai", metrics: [{ label: "车次数", operation: "count" }] };
    const task = await run("分析东入口从" + shanghaiTimestamp(chosen.start) + "至" + shanghaiTimestamp(chosen.end) + "到达车次的跨企业等待与周转瓶颈");
    expect(task.plan.datasetVersion).toBe(actual.version); expect(task.result?.query?.analysis).toBe("bottleneck");
    expect(summarizeBottleneck(task.result!.groups![0]).ranking[0].label).toBe("运输在途");
    expect(modelInputs).not.toContain("private-chain-"); expect(modelInputs).not.toContain('"slots":['); expect(modelInputs).not.toContain("PRIVATE KEY");
    const old = plans()[0], pastNow = slot + 1;
    expect(() => live.app.reservations.replaceCarrier("carrier-a", [], live.app.reservations.catalog().version, slot)).toThrow(/只读/);
    expect(() => live.app.reservations.replaceCarrier("carrier-a", [], live.app.reservations.catalog().version, pastNow)).toThrow(/只读/);
    const archiveVersion = live.app.reservations.catalog().version, archiveNow = slot + RESERVATION_SLOT_MS + 1;
    const remaining = plans().filter(row => row.carrierId === "carrier-a" && row.slotStart !== slot);
    const archived = live.app.reservations.replaceCarrier("carrier-a", remaining, archiveVersion, archiveNow);
    expect(archived.slots).toEqual(remaining);
    expect(live.app.reservations.forCarrier("carrier-a", archiveVersion).slots).toHaveLength(2);
    expect(live.app.reservations.versions("carrier-a").some(version => version.version === archiveVersion && version.rowCount === 2)).toBeTrue();
    expect(() => live.app.reservations.replaceCarrier("carrier-a", [{ ...old, expectedTrips: 99 }, ...remaining], archived.version, archiveNow)).toThrow(/只读/);
    const role = await (await send("/api/carrier-role", "POST", { carrierId: "carrier-b" })).json();
    const history = await (await send("/api/carrier/reservations?version=" + archiveVersion, "GET", undefined, role.token)).json();
    expect(history.slots).toHaveLength(2);
    expect(history.slots.every((row: ReservationSlot) => row.carrierId === "carrier-b")).toBeTrue();
    expect((await send("/api/carrier/reservations/versions", "GET", undefined, role.token)).status).toBe(200);
    expect(live.app.verifyReport(live.app.report(futureTask.id)).valid).toBeTrue();
    expect(sanitizeLogValue({ slots: [old], dispatchReadyAt: chain(0).dispatchReadyAt })).toEqual({ slots: "[REDACTED]", dispatchReadyAt: "[REDACTED]" });
  } finally {
    globalThis.fetch = native; await live.close();
    if (!resolve(root).startsWith(resolve(tmpdir(), "vectra-operations-"))) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
