import { error, MAX_WINDOW_MS, MAX_TELEMETRY_RECORDS, STAT_FIELDS, STAT_OPERATIONS, metricUnit, shanghaiDay, shanghaiTime, type MetricSpec, type StatisticsQuery, type TelemetryRecord, type RoadStatistics, type DataCatalog } from "@vectra/shared";

export const SCALE = 10000n;
export const MAX_RECORDS = MAX_TELEMETRY_RECORDS;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
export function validateQuery(value: unknown, catalog?: DataCatalog, now = Date.now()): StatisticsQuery {
  const fail = (message: string): never => { throw error("invalid_statistics", message, 422); };
  if (!object(value) || !keys(value, ["roads", "start", "end", "timeZone", "metrics"])) return fail("统计方案字段无效。");
  if (!Array.isArray(value.roads) || !value.roads.length || value.roads.length > 8 || !value.roads.every(r => typeof r === "string" && /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,40}$/.test(r)) || new Set(value.roads).size !== value.roads.length) return fail("每次可查询 1—8 个不重复的路段编号。");
  if (catalog && value.roads.some(r => !catalog.roads.some(road => road.id === r))) return fail(`路段没有可用数据。已登记路段：${catalog.roads.map(r => r.id).join("、")}。请先在车辆数据页导入该路段。`);
  if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)) return fail("统计起止时间必须为有效的 Unix 毫秒整数，模型提交的时间格式无效。");
  if (value.timeZone !== "Asia/Shanghai") return fail("统计时区必须为 Asia/Shanghai（中国上海时间 UTC+08:00）。");
  if (Number(value.start) < 0 || !Number.isFinite(new Date(Number(value.start)).getTime()) || !Number.isFinite(new Date(Number(value.end)).getTime())) return fail("统计日期超出有效范围，请检查起止日期。");
  if (Number(value.end) <= Number(value.start)) return fail("统计结束时间必须晚于开始时间。");
  if (Number(value.end) - Number(value.start) > MAX_WINDOW_MS) return fail("统计时间跨度超过 31 天，请缩小查询范围。");
  if (Number(value.end) > now + 60_000) return fail(`统计结束时间 ${shanghaiTime(Number(value.end))} 晚于当前上海时间 ${shanghaiTime(now)}，不能统计未来时段。`);
  if (!Array.isArray(value.metrics) || !value.metrics.length || value.metrics.length > 12) return fail("每次支持 1—12 个指标。");
  for (const m of value.metrics) {
    if (!object(m) || !keys(m, ["label", "operation", "field", "denominatorField", "multiplier", "filter"]) || typeof m.label !== "string" || !m.label.trim() || m.label.length > 60 || !STAT_OPERATIONS.includes(m.operation as MetricSpec["operation"])) return fail("指标名称或聚合操作不在受控统计语言中。");
    const needsField = ["sum", "mean", "variance", "stddev", "ratio_of_sums"].includes(String(m.operation));
    if (needsField !== (m.field !== undefined) || m.field !== undefined && !STAT_FIELDS.includes(m.field as any)) return fail("求和、均值、方差、标准差及总量比值须指定有效数值字段；计数和比例不接受数值字段。");
    if (m.operation === "ratio_of_sums" ? !STAT_FIELDS.includes(m.denominatorField as any) : m.denominatorField !== undefined) return fail("总量比值须指定有效分母字段。");
    if (m.multiplier !== undefined && (m.operation !== "ratio_of_sums" || ![1, 100].includes(Number(m.multiplier)))) return fail("总量比值倍率只支持 1 或 100。");
    if (m.filter !== undefined && (!object(m.filter) || !keys(m.filter, ["field", "op", "value"]) || !STAT_FIELDS.includes(m.filter.field as any) || !["lt", "lte", "gt", "gte", "eq"].includes(String(m.filter.op)) || typeof m.filter.value !== "number" || !Number.isFinite(m.filter.value) || m.filter.value < 0 || m.filter.value > 1000)) return fail("筛选条件须使用受控字段、比较操作和 0—1000 的阈值。");
    if (m.operation === "ratio" && !m.filter) return fail("样本比例必须指定筛选条件。");
  }
  if (new Set(value.metrics.map(m => m.label)).size !== value.metrics.length) return fail("指标名称不能重复。");
  return structuredClone(value) as unknown as StatisticsQuery;
}
const fieldSchema = { type: "string", enum: STAT_FIELDS };
export const queryParameters = { type: "object", additionalProperties: false, required: ["roads", "start", "end", "timeZone", "metrics"], properties: {
  roads: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string" } },
  start: { type: "integer", description: "区间起点 Unix 毫秒，含起点；今天为上海零点" }, end: { type: "integer", description: "区间终点 Unix 毫秒，不含终点；今天截止服务端当前时刻，不能使用明天零点" }, timeZone: { type: "string", enum: ["Asia/Shanghai"] },
  metrics: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: false, required: ["label", "operation"], properties: {
    label: { type: "string", maxLength: 60 }, operation: { type: "string", enum: STAT_OPERATIONS }, field: fieldSchema, denominatorField: fieldSchema, multiplier: { type: "number", enum: [1, 100] },
    filter: { type: "object", additionalProperties: false, required: ["field", "op", "value"], properties: { field: fieldSchema, op: { type: "string", enum: ["lt", "lte", "gt", "gte", "eq"] }, value: { type: "number" } } },
  } } },
} };

// The request controls unambiguous time semantics; the model continues to choose the metric DSL.
function resolveQueryTime(request: string, query: Record<string, unknown>, now: number): Record<string, unknown> {
  if (/\d{4}[-/年]\d{1,2}/.test(request)) return query;
  const calendarDays = [...request.matchAll(/今天|今日|昨天|昨日|前天/g)];
  if (calendarDays.length) {
    // Preserve explicit subperiods, comparisons and multiple-day expressions for normal validation.
    if (calendarDays.length !== 1 || /凌晨|早上|早晨|清晨|上午|中午|下午|傍晚|晚上|夜间|白天|[\d零〇一二两三四五六七八九十半]\s*[:：点时]|小时|分钟|秒|之前|以前|之后|以后|明天|明日|后天|后日|未来|过去|最近|本周|上周|下周|本月|上月|下月|今年|去年|明年|周[一二三四五六日天]|从|截至|至|到/.test(request)) return query;
    const day = calendarDays[0][0], offset = /今天|今日/.test(day) ? 0 : /昨天|昨日/.test(day) ? 1 : 2;
    const start = Date.parse(`${shanghaiDay(now)}T00:00:00+08:00`) - offset * 86400000;
    return { ...query, start, end: offset === 0 ? now : start + 86400000, timeZone: "Asia/Shanghai" };
  }
  const amount = "(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百半]+)";
  const part = `${amount}\\s*(?:个)?(?:半)?\\s*(?:小时|分钟|秒钟|天|分|秒)\\s*`;
  const matches = [...request.matchAll(new RegExp(`(?:过去|最近|近)\\s*((?:${part})+)`, "g"))];
  if (matches.length !== 1) return query;
  const match = matches[0];
  if (/^\s*(?:之前|以前|之后|以后|至|到)/.test(request.slice(match.index! + match[0].length))) return query;
  const units: Record<string, number> = { 秒: 1000, 秒钟: 1000, 分: 60000, 分钟: 60000, 小时: 3600000, 天: 86400000 };
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const number = (text: string) => {
    if (text === "半") return 0.5;
    if (/^\d/.test(text)) return Number(text);
    let sum = 0, digit = 0;
    for (const char of text) { if (char in digits) digit = digits[char]; else if (char === "十" || char === "百") { sum += (digit || 1) * (char === "十" ? 10 : 100); digit = 0; } else return NaN; }
    return sum + digit;
  };
  let duration = 0, lastUnit = 0;
  for (const token of match[1].matchAll(new RegExp(`(${amount})\\s*(?:个)?(半)?\\s*(小时|分钟|秒钟|天|分|秒)`, "g"))) {
    lastUnit = units[token[3]]; duration += (number(token[1]) + (token[2] ? 0.5 : 0)) * lastUnit;
  }
  if (/^\s*半/.test(request.slice(match.index! + match[0].length))) duration += lastUnit / 2;
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_WINDOW_MS) throw error("invalid_statistics", "相对时间范围须大于零且最多 31 天。", 422);
  return { ...query, start: now - duration, end: now, timeZone: "Asia/Shanghai" };
}

export function resolveRelativeQueryTime(request: string, query: StatisticsQuery, now: number): StatisticsQuery {
  return resolveQueryTime(request, query as unknown as Record<string, unknown>, now) as unknown as StatisticsQuery;
}

export function approveStatisticsQuery(request: string, value: unknown, catalog?: DataCatalog, now = Date.now()): StatisticsQuery {
  // Resolve trusted request semantics before validation; the final query always passes every policy check.
  return validateQuery(object(value) ? resolveQueryTime(request, value, now) : value, catalog, now);
}

export function parseShanghaiDate(text: string) {
  const normalized = text.replace(" ", "T");
  return Date.parse(/[Zz]$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`);
}
function matches(record: TelemetryRecord, filter?: MetricSpec["filter"]) {
  if (!filter) return true;
  const value = record[filter.field]; if (value === undefined) return false;
  switch (filter.op) { case "lt": return value < filter.value; case "lte": return value <= filter.value; case "gt": return value > filter.value; case "gte": return value >= filter.value; case "eq": return value === filter.value; }
}
// Four additive sufficient statistics per road/metric: valid count, sum, square sum, denominator.
export function localVector(records: TelemetryRecord[], query: StatisticsQuery): bigint[] {
  return query.roads.flatMap(road => query.metrics.flatMap(metric => {
    const base = records.filter(r => r.road === road && r.recordedAt >= query.start && r.recordedAt < query.end &&
      (!metric.field || r[metric.field] !== undefined) && (!metric.denominatorField || r[metric.denominatorField] !== undefined) && (!metric.filter || r[metric.filter.field] !== undefined));
    const selected = base.filter(r => matches(r, metric.filter));
    const count = metric.operation === "vehicle_count" ? new Set(selected.map(r => r.vehicleId)).size : selected.length;
    let sum = 0n, square = 0n, denominator = 0n;
    for (const row of selected) {
      if (metric.field) { const encoded = BigInt(Math.round(row[metric.field]! * Number(SCALE))); sum += encoded; if (["variance", "stddev"].includes(metric.operation)) square += encoded * encoded; }
      if (metric.denominatorField) denominator += BigInt(Math.round(row[metric.denominatorField]! * Number(SCALE)));
    }
    if (metric.operation === "ratio") denominator = BigInt(base.length);
    if (metric.operation === "vehicle_count") denominator = BigInt(selected.length);
    return [BigInt(count), sum, square, denominator];
  }));
}
export function finishVector(vector: bigint[], query: StatisticsQuery): RoadStatistics[] {
  if (vector.length !== query.roads.length * query.metrics.length * 4 || vector.some(v => v < 0n || v > 6000n * 10000000n ** 2n)) throw error("mpc_output_invalid", "统计向量维数或范围无效。", 403);
  let index = 0;
  return query.roads.map(road => ({ road, metrics: query.metrics.map(metric => {
    const [n, s, sq, d] = vector.slice(index, index += 4).map(Number);
    if (n > MAX_RECORDS) throw error("mpc_output_invalid", "统计样本数量超出批准范围。", 403);
    const mean = n ? s / Number(SCALE) / n : null;
    let value: number | null;
    switch (metric.operation) {
      case "count": case "vehicle_count": value = n; break;
      case "sum": value = n ? s / Number(SCALE) : null; break;
      case "mean": value = mean; break;
      case "variance": case "stddev": { const variance = n ? Math.max(0, sq / Number(SCALE * SCALE) / n - mean! ** 2) : null; value = variance === null ? null : metric.operation === "stddev" ? Math.sqrt(variance) : variance; break; }
      case "ratio": value = d ? n / d * 100 : null; break;
      case "ratio_of_sums": value = d ? s / d * (metric.multiplier ?? 1) : null; break;
    }
    return { label: metric.label, value: value === null ? null : Number(value.toFixed(6)), unit: metricUnit(metric), validSamples: ["ratio", "vehicle_count"].includes(metric.operation) ? d : n, ...(value === null ? { note: "区间内没有完整有效样本或分母为零；未补零。" } : {}) };
  }) }));
}
