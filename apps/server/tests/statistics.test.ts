import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PARTICIPANTS, planTask, shanghaiDay, type StatisticsQuery, type Task } from "@vectra/shared";
import { localVector, finishVector, validateQuery, resolveRelativeQueryTime, approveStatisticsQuery } from "../src/statistics";
import { Telemetry } from "../src/telemetry";
import { shares, reconstruct, mod } from "../src/mpc/field";
import { Security, atomicWrite, canonical, seal } from "../src/security";
import { ModelSettings } from "../src/model";
import { Collaboration } from "../src/service";
import { startServer } from "../src/index";
import { config } from "../src/config";
import { configureFixture, fixtureRecords, fixtureProviderReply } from "./fixtures";

const queryAt = (now: number): StatisticsQuery => ({ roads: ["R202", "S102"], start: now - 600000, end: now, timeZone: "Asia/Shanghai", metrics: [
  { label: "均速", operation: "mean", field: "speed" }, { label: "车辆数", operation: "vehicle_count" }, { label: "样本数", operation: "count" },
  { label: "低于20样本占比", operation: "ratio", filter: { field: "speed", op: "lt", value: 20 } },
  { label: "速度标准差", operation: "stddev", field: "speed" }, { label: "总里程", operation: "sum", field: "distanceKm" },
  { label: "百公里能耗", operation: "ratio_of_sums", field: "energyKwh", denominatorField: "distanceKm", multiplier: 100 },
] });
function recordsAt(now: number) { return PARTICIPANTS.map((participant, i) => ({ participant, vehicleId: `car-${i}`, road: "R202", recordedAt: now - 30000, speed: [10, 20, 60][i], distanceKm: 1, energyKwh: 0.15 })); }

test("relative time uses the server clock instead of model arithmetic or an obsolete year", () => {
  const now = Date.parse("2026-10-23T02:49:06.989Z"), proposed = { ...queryAt(now), start: Date.parse("2023-10-23T01:49:06Z"), end: Date.parse("2023-10-23T02:49:06Z") };
  const cases: [string, number][] = [["过去一小时", 3600], ["过去一个小时", 3600], ["最近10分钟", 600], ["近半小时", 1800], ["过去一个半小时", 5400], ["过去1小时30分钟", 5400], ["过去一小时半", 5400]];
  for (const [request, seconds] of cases) {
    const resolved = validateQuery(resolveRelativeQueryTime(`统计 S101 ${request}的平均速度`, proposed, now));
    expect(resolved.end).toBe(now); expect(resolved.start).toBe(now - seconds * 1000);
  }
  expect(resolveRelativeQueryTime("统计2023-10-23指定时段的速度", proposed, now)).toEqual(proposed);
  expect(() => resolveRelativeQueryTime("过去32天", proposed, now)).toThrow();
});

test("today resolves to Shanghai midnight through now before validating the model time", () => {
  const now = Date.parse("2026-10-23T13:11:11.573+08:00"), midnight = Date.parse("2026-10-23T00:00:00+08:00");
  const proposed = { ...queryAt(now), roads: ["S101"], start: 1792684800000, end: 1792771200000 };
  expect(() => validateQuery(proposed, undefined, now)).toThrow(/晚于当前上海时间/);
  const approved = approveStatisticsQuery("统计 S101道路 今天的平均速度、总里程和总能耗。", proposed, undefined, now);
  expect(approved.start).toBe(midnight); expect(approved.end).toBe(now);
  expect(approved.timeZone).toBe("Asia/Shanghai"); expect(approved.metrics).toEqual(proposed.metrics);
  for (const [request, offset] of [["统计今日指标", 0], ["统计昨天指标", 1], ["统计昨日指标", 1], ["统计前天指标", 2]] as const) {
    const query = approveStatisticsQuery(request, proposed, undefined, now);
    expect(query.start).toBe(midnight - offset * 86400000);
    expect(query.end).toBe(offset === 0 ? now : midnight - (offset - 1) * 86400000);
  }
  const nearMidnight = Date.parse("2026-10-22T16:05:00Z");
  expect(approveStatisticsQuery("统计今天", proposed, undefined, nearMidnight).start).toBe(midnight);
  const relative = approveStatisticsQuery("统计最近10分钟", { ...proposed, start: -1, timeZone: "UTC" }, undefined, now);
  expect(relative.start).toBe(now - 600000); expect(relative.end).toBe(now); expect(relative.timeZone).toBe("Asia/Shanghai");
});

test("time repair preserves explicit subperiods and still rejects future ranges and invalid contracts", () => {
  const now = Date.parse("2026-10-23T13:11:11.573+08:00"), query = queryAt(now);
  for (const request of ["统计今天上午", "统计今天9点到10点", "统计2026-10-22指定时段", "统计昨天和今天"]) expect(approveStatisticsQuery(request, query, undefined, now)).toEqual(query);
  for (const request of ["统计今天16:00到17:00", "统计今天至明天", "统计明天的指标"]) expect(() => approveStatisticsQuery(request, { ...query, end: now + 3600000 }, undefined, now)).toThrow(/未来/);
  expect(() => approveStatisticsQuery("统计过去32天", query, undefined, now)).toThrow(/31 天/);
  expect(() => approveStatisticsQuery("统计今天", { ...query, unsafe: true }, undefined, now)).toThrow(/字段无效/);
  expect(() => approveStatisticsQuery("统计今天", { ...query, metrics: [{ label: "执行代码", operation: "eval" }] }, undefined, now)).toThrow(/受控统计语言/);
  expect(() => validateQuery({ ...query, timeZone: "UTC" }, undefined, now)).toThrow(/Asia\/Shanghai/);
  expect(() => validateQuery({ ...query, end: query.start }, undefined, now)).toThrow(/晚于开始/);
  expect(() => validateQuery({ ...query, start: now - 32 * 86400000 }, undefined, now)).toThrow(/超过 31 天/);
});

test("today statistics complete real MPC and report delivery despite a model proposing tomorrow midnight", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-time-query-")), originalFetch = globalThis.fetch;
  const app = await Collaboration.open({ ...config(), dataDir: root, logDir: join(root, "logs"), cooldown: 0, mpcTimeout: 25000 });
  try {
    configureFixture(app);
    const submittedAt = Date.now(), midnight = Date.parse(`${shanghaiDay(submittedAt)}T00:00:00+08:00`);
    app.telemetry.import(fixtureRecords().map(row => ({ ...row, recordedAt: midnight + Math.floor((submittedAt - midnight) / 2) })));
    globalThis.fetch = Object.assign(async (_url: unknown, options?: RequestInit) => {
      const payload = JSON.parse(String(options?.body));
      if (payload.tools.some((tool: any) => tool.function.name === "submit_statistics_plan")) {
        return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name: "submit_statistics_plan", arguments: JSON.stringify({ roads: ["S101"], start: midnight, end: midnight + 86400000, timeZone: "Asia/Shanghai", metrics: [{ label: "平均速度", operation: "mean", field: "speed" }, { label: "总里程", operation: "sum", field: "distanceKm" }, { label: "总能耗", operation: "sum", field: "energyKwh" }] }) } }] } }] });
      }
      return fixtureProviderReply(payload);
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    const task = app.submit({ request: "统计 S101道路 今天的平均速度、总里程和总能耗。", requestId: randomUUID(), intent: "statistics" });
    const deadline = Date.now() + 30000;
    while (["queued", "running"].includes(app.store.task(task.id)!.status) && Date.now() < deadline) await Bun.sleep(30);
    const completed = app.store.task(task.id)!;
    expect(completed.error, JSON.stringify(completed.error)).toBeUndefined(); expect(completed.status).toBe("completed");
    expect(completed.plan.statistics!.start).toBe(midnight); expect(completed.plan.statistics!.end).toBeGreaterThanOrEqual(submittedAt);
    expect(completed.plan.statistics!.end).toBeLessThanOrEqual(Date.now());
    expect(completed.result?.groups?.[0].metrics.map(metric => metric.value)).toEqual([40, 3, 0.45]);
    expect(completed.analysis).toBeDefined();
    const report = app.report(task.id); expect(app.verifyReport(report).valid).toBeTrue(); expect((report.payload.plan as any).statistics).toEqual(completed.plan.statistics);
  } finally {
    globalThis.fetch = originalFetch; await app.close();
    if (resolve(root).startsWith(resolve(tmpdir(), "vectra-time-query-"))) rmSync(root, { recursive: true, force: true });
  }
}, 35000);

test("composed statistics use real time filters, missing data and independently shared vector components", () => {
  const now = Date.now(), query = validateQuery(queryAt(now)), rows = recordsAt(now);
  const vectors = PARTICIPANTS.map(id => localVector([...rows, { ...rows[0], recordedAt: query.start - 1, speed: 200 }].filter(r => r.participant === id), query));
  const totals = vectors[0].map((_, k) => {
    const pieces = vectors.map(v => shares(v[k]));
    return reconstruct([0, 1, 2].map(i => mod(pieces.reduce((sum, p) => sum + p[i], 0n))));
  });
  const groups = finishVector(totals, query);
  expect(groups[0].metrics.map(m => m.value)).toEqual([30, 3, 3, 33.333333, 21.602469, 3, 15]);
  expect(groups[1].metrics[0].value).toBeNull(); expect(groups[1].metrics[2].value).toBe(0);
  const vehicleQuery: StatisticsQuery = { ...query, roads: ["R202"], metrics: [{ label: "车辆数", operation: "vehicle_count" }] };
  const deduped = finishVector(localVector([...rows, { ...rows[0], recordedAt: now - 1000 }], vehicleQuery), vehicleQuery)[0].metrics[0];
  expect(deduped.value).toBe(3); expect(deduped.validSamples).toBe(4);
  expect(() => validateQuery({ ...query, metrics: [{ label: "任意代码", operation: "eval", code: "process.exit()" }] })).toThrow();
  expect(() => validateQuery({ ...query, start: now - 32 * 86400000 })).toThrow();
  expect(planTask("为什么上次平均速度是40", "auto").intent).toBe("explain");
});

test("telemetry validates ownership and publishes immutable encrypted versions", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-stat-data-"));
  try {
    const security = await Security.open(root), telemetry = new Telemetry(security), now = Date.now();
    expect(telemetry.catalog().roads).toEqual([]);
    const catalog = telemetry.import(recordsAt(now));
    expect(catalog.roads[0].id).toBe("R202");
    expect(() => telemetry.import([...recordsAt(now), { ...recordsAt(now)[0], participant: "vehicle-b", recordedAt: now - 1000 }])).toThrow();
    expect(() => telemetry.import([...recordsAt(now), recordsAt(now)[0]])).toThrow();
    expect(() => validateQuery({ ...queryAt(now), roads: ["S999"] }, catalog)).toThrow();
    expect(() => validateQuery({ ...queryAt(now), metrics: [{ label: "中位数", operation: "median", field: "speed" }] })).toThrow();
    expect(() => validateQuery({ ...queryAt(now), metrics: [{ label: "比例", operation: "ratio" }] })).toThrow();
  } finally { if (resolve(root).startsWith(resolve(tmpdir(), "vectra-stat-data-"))) rmSync(root, { recursive: true, force: true }); }
});

test("variable fleets auto-assign stable owners, count distinct cars and prevent stale editor saves", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-fleet-test-"));
  try {
    const telemetry = new Telemetry(await Security.open(root)), now = Date.now();
    const query: StatisticsQuery = { ...queryAt(now), roads: ["R202"], metrics: [{ label: "车辆数", operation: "vehicle_count" }, { label: "样本数", operation: "count" }, { label: "均速", operation: "mean", field: "speed" }] };
    for (const count of [1, 2, 7, 50]) {
      const rows = Array.from({ length: count }, (_, i) => [0, 1].map(j => ({ vehicleId: `fleet-${i}`, road: "R202", recordedAt: now - 30000 - j * 1000, speed: 20 + i }))).flat();
      const catalog = telemetry.import(rows), snapshot = telemetry.snapshot();
      expect(catalog.vehicleCount).toBe(count); expect(catalog.sampleCount).toBe(count * 2); expect(catalog.roads[0].vehicleCount).toBe(count);
      expect(catalog.nodes.reduce((sum, node) => sum + node.vehicleCount, 0)).toBe(count);
      const vectors = PARTICIPANTS.map(id => localVector(snapshot.records.filter(row => row.participant === id), query));
      const total = vectors[0].map((_, i) => vectors.reduce((sum, vector) => sum + vector[i], 0n));
      expect(finishVector(total, query)[0].metrics.map(m => m.value)).toEqual([count, count * 2, 20 + (count - 1) / 2]);
      for (const id of new Set(rows.map(row => row.vehicleId))) expect(new Set(snapshot.records.filter(row => row.vehicleId === id).map(row => row.participant)).size).toBe(1);
      const reversed = telemetry.import([...rows].reverse());
      expect(telemetry.snapshot().records.map(row => [row.vehicleId, row.participant]).sort()).toEqual(snapshot.records.map(row => [row.vehicleId, row.participant]).sort());
      expect(() => telemetry.import(rows, catalog.version)).toThrow("车辆数据已由其他操作更新"); expect(telemetry.catalog().version).toBe(reversed.version);
    }
    const rows = [0, 1].map(i => ({ vehicleId: "mixed-owner", road: "R202", recordedAt: now - 1000 - i, speed: 30, ...(i ? { participant: "vehicle-c" } : {}) }));
    telemetry.import(rows);
    expect(telemetry.snapshot().records.every(row => row.participant === "vehicle-c")).toBeTrue();
  } finally { if (resolve(root).startsWith(resolve(tmpdir(), "vectra-fleet-test-"))) rmSync(root, { recursive: true, force: true }); }
});

test("model-only setup migrates legacy settings, rejects unconfigured tasks and requires imported data", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-model-only-")), app = await Collaboration.open({ ...config(), dataDir: root, logDir: join(root, "logs"), cooldown: 0 });
  try {
    app.settings.save({ provider: "custom", baseUrl: "https://example.invalid/v1", model: "", clearApiKey: true });
    expect(app.settings.public().ready).toBeFalse();
    expect(() => app.submit({ request: "介绍系统", requestId: randomUUID(), intent: "explain" })).toThrow("请先在模型设置");
    expect(app.store.tasks()).toHaveLength(0);
    expect(() => app.settings.save({ mode: "demo", provider: "custom", baseUrl: "https://example.invalid/v1", model: "test" })).toThrow();
    atomicWrite(join(root, "model-settings.enc.json"), canonical(seal({ mode: "demo", provider: "custom", baseUrl: "https://example.invalid/v1", model: "test", apiKey: "migration-key" }, app.security.storageKey(), "model-settings")));
    const migrated = new ModelSettings(root, app.security);
    expect(migrated.public().mode).toBe("llm"); expect(migrated.public().ready).toBeTrue(); expect(migrated.snapshot().apiKey).toBe("migration-key");
    app.settings.save({ provider: "custom", baseUrl: "https://example.invalid/v1", model: "test", apiKey: "migration-key" });
    const task = app.submit({ request: "统计 S101 平均速度", requestId: randomUUID(), intent: "statistics" });
    const deadline = Date.now() + 2000;
    while (["queued", "running"].includes(app.store.task(task.id)!.status) && Date.now() < deadline) await Bun.sleep(10);
    expect(app.store.task(task.id)?.error?.code).toBe("dataset_missing"); expect(app.store.report(task.id)).toBeUndefined();
  } finally { await app.close(); if (resolve(root).startsWith(resolve(tmpdir(), "vectra-model-only-"))) rmSync(root, { recursive: true, force: true }); }
});

test("LLM plans a custom metric DSL then real three-party API computation signs the exact query and version", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-stat-api-")), originalFetch = globalThis.fetch;
  const live = await startServer({ ...config(), dataDir: root, logDir: join(root, "logs"), port: 0, cooldown: 0, mpcTimeout: 25000 });
  const base = `http://127.0.0.1:${live.server.port}`;
  const session = await originalFetch(`${base}/api/session`), cookie = session.headers.get("set-cookie")!.split(";")[0];
  const request = async (path: string, method = "GET", value?: unknown) => originalFetch(base + path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const now = Date.now(), query = queryAt(now);
  let rejectAnalysis = false;
  try {
    expect((await request("/api/telemetry", "POST", recordsAt(now))).status).toBe(201);
    const catalog = await (await request("/api/telemetry")).json();
    // The second road is present in the catalog but has no records in the selected interval.
    const fleet = Array.from({ length: 12 }, (_, i) => { const { participant, ...record } = recordsAt(now)[i % 3]; return { ...record, vehicleId: `fleet-${i}` }; });
    const imported = live.app.telemetry.import([...fleet, { ...fleet[0], road: "S102", recordedAt: now - 700000 }]);
    const privatePath = "/api/telemetry/records";
    expect((await originalFetch(base + privatePath)).status).toBe(401);
    expect((await originalFetch(base + privatePath, { headers: { Cookie: cookie, Origin: "https://attacker.invalid" } })).status).toBe(403);
    const snapshotResponse = await request(privatePath), snapshot = await snapshotResponse.json();
    expect(snapshotResponse.headers.get("cache-control")).toBe("no-store"); expect(snapshot.records).toHaveLength(13); expect(snapshot.version).toBe(imported.version);
    expect((await request("/api/telemetry", "POST", { records: fleet, baseVersion: catalog.version })).status).toBe(409);
    live.app.settings.save({ mode: "llm", provider: "custom", baseUrl: "https://example.invalid/v1", model: "test", apiKey: "statistics-test-key" });
    globalThis.fetch = Object.assign(async (_url: unknown, options?: RequestInit) => {
      const payload = JSON.parse(String(options?.body)), names = payload.tools.map((t: any) => t.function.name), last = payload.messages.at(-1);
      const call = (name: string, args: unknown = {}) => Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
      if (names.includes("submit_statistics_plan")) return call("submit_statistics_plan", query);
      if (names.includes("submit_analysis")) {
        if (last.role === "user") return call("query_events");
        const events = JSON.parse(last.content).events;
        return call("submit_analysis", { facts: ["真实聚合已完成"], possibleCauses: [], recommendations: [], uncertainties: ["导入数据不证明传感器真实性"], evidenceIds: [rejectAnalysis ? -1 : events[0].id] });
      }
      if (last.role === "user") return call("compute_statistics");
      // Reproduce a coordinator that stops immediately after statistics and never requests investigate.
      expect(JSON.parse(last.content).analysis.evidenceIds.length).toBeGreaterThan(0);
      return Response.json({ choices: [{ message: { role: "assistant", content: "已完成批准方案；R202均速30、低速比例33.333333%。" } }] });
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    const created = live.app.submit({ request: "统计 R202、S102 最近10分钟均速、车辆数、样本数、速度低于20的占比、波动、总里程与每百公里能耗", requestId: randomUUID(), intent: "statistics" });
    const end = Date.now() + 30000; let task: Task;
    do { await Bun.sleep(30); task = live.app.store.task(created.id)!; } while (["queued", "running"].includes(task.status) && Date.now() < end);
    expect(task.error, JSON.stringify(task.error)).toBeUndefined(); expect(task.status).toBe("completed");
    expect(task.result?.groups?.[0].metrics.map(m => m.value)).toEqual([30, 12, 12, 33.333333, 21.602469, 12, 15]);
    expect(task.plan.datasetVersion).toBe(imported.version);
    expect(task.plan.statistics!.end - task.plan.statistics!.start).toBe(600000); expect(task.plan.statistics!.end).toBeGreaterThanOrEqual(now);
    expect(task.plan.statistics!.roads).toEqual(query.roads); expect(task.plan.statistics!.metrics).toEqual(query.metrics);
    expect(task.result?.groups?.[1].metrics[0].value).toBeNull();
    const report = live.app.report(task.id); expect(live.app.verifyReport(report).valid).toBeTrue();
    expect((report.payload.plan as any).statistics).toEqual(task.plan.statistics);
    expect(task.analysis?.evidenceIds.length).toBeGreaterThan(0); expect(report.payload.analysis).toEqual(task.analysis);
    expect(task.steps.filter(step => step.action === "query_events" && step.status === "completed")).toHaveLength(1);
    expect(task.steps.filter(step => step.action === "submit_analysis" && step.status === "completed")).toHaveLength(1);
    expect(task.steps.some(step => step.action === "investigate")).toBeFalse();
    expect(live.app.audit.list(200).filter(event => event.kind === "statistics_completed" && event.details.taskId === task.id)).toHaveLength(1);
    expect(catalog.version).not.toBe(imported.version);

    rejectAnalysis = true;
    const refused = live.app.submit({ request: "统计 R202 最近10分钟的指标", requestId: randomUUID(), intent: "statistics" });
    const failedBy = Date.now() + 30000;
    while (["queued", "running"].includes(live.app.store.task(refused.id)!.status) && Date.now() < failedBy) await Bun.sleep(30);
    const failed = live.app.store.task(refused.id)!;
    expect(failed.status).toBe("failed"); expect(failed.error?.code).toBe("analysis_invalid");
    expect(failed.result).toBeDefined(); expect(failed.analysis).toBeUndefined(); expect(live.app.store.report(refused.id)).toBeUndefined();
    globalThis.fetch = originalFetch;
  } finally {
    globalThis.fetch = originalFetch; await live.close();
    if (resolve(root).startsWith(resolve(tmpdir(), "vectra-stat-api-"))) rmSync(root, { recursive: true, force: true });
  }
}, 45000);
