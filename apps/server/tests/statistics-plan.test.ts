import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { shanghaiDay, type StatisticsQuery, type StatisticsRecord } from "@vectra/shared";
import { approveStatisticsQuery, validateQuery, localVector, finishVector } from "../src/statistics";
import { Collaboration } from "../src/service";
import { config } from "../src/config";
import { configureFixtureModels, fixtureVisits, fixtureProviderReply } from "./fixtures";
import { taskRecovery } from "../../web/src/step-explanations";

// The actual plans rejected on 2026-11-02, with the redundant top-level fields intact.
const failures: { request: string; query: StatisticsQuery }[] = [
  {
    request: "统计 东入口 今天到达的车次数、车辆数和未离园车次数。",
    query: {
      dataset: "park_visits", cohort: "arrivals", roads: ["东入口"], start: 1793548800000, end: 1793606011740, timeZone: "Asia/Shanghai",
      metrics: [
        { label: "车次数", operation: "count" },
        { label: "车辆数", operation: "vehicle_count" },
        { label: "未离园车次数", operation: "count", field: "completed", filter: { field: "completed", op: "eq", value: 0 } },
      ],
    },
  },
  {
    request: "统计 东入口 今天到达车次的预约准点率和平均排队时长，给出人工调整预约时段的建议。",
    query: {
      dataset: "park_visits", cohort: "arrivals", roads: ["东入口"], start: 1793548800000, end: 1793606080399, timeZone: "Asia/Shanghai",
      metrics: [
        { label: "到达车次数", operation: "count" },
        { label: "去重车辆数", operation: "vehicle_count" },
        { label: "预约准点比例", operation: "ratio", field: "appointmentOnTime", filter: { field: "appointmentOnTime", op: "eq", value: 1 } },
        { label: "平均入口排队时长（分钟）", operation: "mean", field: "queueMinutes" },
      ],
    },
  },
];

test("planner approval canonicalizes both rejected count and ratio plans without mutating their input", () => {
  for (const { request, query } of failures) {
    const before = structuredClone(query);
    expect(() => validateQuery(query, undefined, query.end)).toThrow(/不能设置数值字段/);
    const approved = approveStatisticsQuery(request, query, undefined, query.end);
    expect(query).toEqual(before);
    expect(approved).toEqual({ ...query, metrics: query.metrics.map(metric => {
      const { field, ...rest } = metric;
      return metric.filter ? rest : metric;
    }) });
    expect(validateQuery(approved, undefined, query.end)).toEqual(approved);
  }
});

test("canonical plans preserve selected samples, missing values, deduplication and ratio denominators", () => {
  const original: StatisticsQuery = { ...failures[0].query, metrics: [...failures[0].query.metrics, ...failures[1].query.metrics.slice(2)] };
  const approved = approveStatisticsQuery(failures[0].request, original, undefined, original.end);
  const base = { road: "东入口", recordedAt: original.start };
  const rows: StatisticsRecord[] = [
    { ...base, vehicleId: "same-car", completed: 0, appointmentOnTime: 1, queueMinutes: 10 },
    { ...base, vehicleId: "same-car", completed: 1, appointmentOnTime: 0, queueMinutes: 20 },
    { ...base, vehicleId: "other-car", completed: 0 },
  ];
  const result = finishVector(localVector(rows, approved), approved);
  expect(result).toEqual(finishVector(localVector(rows, original), original));
  expect(result[0].metrics.map(metric => metric.value)).toEqual([3, 2, 2, 50, 15]);
  expect(result[0].metrics.map(metric => metric.validSamples)).toEqual([3, 3, 2, 2, 2]);
  expect(result[0].coverage).toEqual({ visits: 3, completed: 1, unfinished: 2, contributingCarriers: 1 });
  const vehicleQuery = { ...approved, metrics: [{ label: "未离园车辆数", operation: "vehicle_count", field: "completed", filter: { field: "completed", op: "eq", value: 0 } }] };
  const canonicalVehicles = approveStatisticsQuery(failures[0].request, vehicleQuery, undefined, original.end);
  expect(canonicalVehicles.metrics[0]).not.toHaveProperty("field");
  expect(finishVector(localVector(rows, canonicalVehicles), canonicalVehicles)[0].metrics[0].value).toBe(2);
});

test("planner canonicalization cannot drop an independent field or bypass strict query validation", () => {
  const query = failures[0].query, now = query.end;
  const invalid = (metric: unknown) => () => approveStatisticsQuery(failures[0].request, { ...query, metrics: [metric] }, undefined, now);
  for (const operation of ["count", "vehicle_count", "ratio"]) {
    expect(invalid({ label: "独立字段", operation, field: "queueMinutes", filter: { field: "completed", op: "eq", value: 0 } })).toThrow(/独立字段.*不能设置数值字段/);
    expect(invalid({ label: "无筛选", operation, field: "completed" })).toThrow(/不能设置数值字段/);
  }
  for (const operation of ["sum", "mean", "variance", "stddev", "ratio_of_sums"]) {
    expect(invalid({ label: "缺少字段", operation })).toThrow(/缺少字段.*缺少数值字段/);
    expect(invalid({ label: "错误字段", operation, field: "speed" })).toThrow(/错误字段.*不属于所选数据类型/);
  }
  expect(invalid({ label: "无筛选比例", operation: "ratio" })).toThrow(/必须指定筛选条件/);
  expect(invalid({ label: "非法筛选", operation: "count", field: "unsafe", filter: { field: "unsafe", op: "eq", value: 0 } })).toThrow(/筛选条件/);
  expect(invalid({ label: "非法阈值", operation: "count", field: "completed", filter: { field: "completed", op: "eq", value: -1 } })).toThrow(/筛选条件/);
  expect(invalid({ ...query.metrics[2], unsafe: true })).toThrow(/受控统计语言/);
  expect(invalid({ ...query.metrics[2], denominatorField: "distanceKm" })).toThrow(/分母字段/);
  const canonical = approveStatisticsQuery(failures[0].request, query, undefined, now);
  expect(() => approveStatisticsQuery("统计2026-11-02指定时段", { ...canonical, start: now - 32 * 86400000 }, undefined, now)).toThrow(/31 天/);
  expect(() => approveStatisticsQuery("统计明天", { ...canonical, end: now + 60000 }, undefined, now)).toThrow(/未来/);
  expect(() => approveStatisticsQuery(failures[0].request, { ...query, roads: ["无效入口"] }, undefined, now)).toThrow(/固定/);
});

test("statistics recovery uses the specific rejection instead of blaming time for metric errors", () => {
  for (const message of [
    "求和、均值、方差、标准差及总量比值须指定该数据类型的有效数值字段；计数和比例不接受数值字段。",
    "指标“预约准点比例”（ratio）不能设置数值字段 field；筛选字段请放在 filter.field 中。",
  ]) {
    expect(taskRecovery("invalid_statistics", message)).toContain("统计指标未通过校验");
    expect(taskRecovery("invalid_statistics", message)).not.toContain("结束时间");
  }
  expect(taskRecovery("invalid_statistics", "统计结束时间晚于当前上海时间")).toContain("上海时区");
  expect(taskRecovery("invalid_statistics", "未来计划最多查询未来31天。")).toContain("未来计划最多查询未来 31 天");
  expect(taskRecovery("invalid_statistics", "经营分组过细，请增大时间粒度")).toContain("增大时间粒度");
  expect(taskRecovery("invalid_statistics", "园区固定为东入口、南入口、西入口、北入口")).toContain("具体错误检查入口");
});

test("both rejected planner outputs complete real MPC, analysis and a report signing the canonical plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-metric-plan-")), originalFetch = globalThis.fetch;
  const app = await Collaboration.open({ ...config(), dataDir: root, logDir: join(root, "logs"), cooldown: 0, mpcTimeout: 25000 });
  try {
    configureFixtureModels(app);
    const midnight = Date.parse(`${shanghaiDay(Date.now())}T00:00:00+08:00`);
    app.park.import(fixtureVisits().map(({ departedAt, gateStartedAt, distanceKm, energyKwh, ...row }, index) => ({
      ...row, arrivedAt: midnight,
      ...(index < 2 ? { gateStartedAt: midnight, appointmentStart: midnight - 60000, appointmentEnd: midnight + (index === 0 ? 60000 : 0) } : {}),
      ...(index === 1 ? { departedAt: midnight, distanceKm, energyKwh } : {}),
    })), app.park.catalog().version);
    let planIndex = 0;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      if (!String(input).startsWith("https://example.invalid/")) return originalFetch(input, options);
      const payload = JSON.parse(String(options?.body));
      if (payload.tools.some((tool: any) => tool.function.name === "submit_statistics_plan")) {
        const query = { ...failures[planIndex++].query, start: midnight, end: Date.now() };
        return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name: "submit_statistics_plan", arguments: JSON.stringify(query) } }] } }] });
      }
      return fixtureProviderReply(payload);
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    for (const [index, { request }] of failures.entries()) {
      const task = app.submit({ request, requestId: randomUUID(), intent: "statistics" });
      const deadline = Date.now() + 30000;
      while (["queued", "running"].includes(app.store.task(task.id)!.status) && Date.now() < deadline) await Bun.sleep(30);
      const completed = app.store.task(task.id)!;
      expect(completed.error, JSON.stringify(completed.error)).toBeUndefined();
      expect(completed.status).toBe("completed");
      expect(completed.result?.groups?.[0].metrics.map(metric => metric.value)).toEqual(index === 0 ? [3, 3, 2] : [3, 3, 50, 0]);
      expect(completed.result?.groups?.[0].coverage).toEqual({ visits: 3, completed: 1, unfinished: 2, contributingCarriers: 3 });
      expect(completed.plan.statistics!.metrics.filter(metric => ["count", "vehicle_count", "ratio"].includes(metric.operation)).every(metric => metric.field === undefined)).toBeTrue();
      expect(completed.analysis).toBeDefined();
      const report = app.report(task.id);
      expect(app.verifyReport(report).valid).toBeTrue();
      expect((report.payload.plan as any).statistics).toEqual(completed.plan.statistics);
    }
    expect(planIndex).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    if (resolve(root).startsWith(resolve(tmpdir(), "vectra-metric-plan-"))) rmSync(root, { recursive: true, force: true });
  }
}, 65000);
