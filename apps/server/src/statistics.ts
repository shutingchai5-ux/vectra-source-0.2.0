import { error, MAX_WINDOW_MS, MAX_TELEMETRY_RECORDS, TELEMETRY_FIELDS, PARK_FIELDS, PARK_ENTRANCES, isParkEntrance, STAT_OPERATIONS, metricUnit, shanghaiDay, shanghaiTime, type MetricSpec, type StatisticsQuery, type StatisticsRecord, type RoadStatistics, type DataCatalog } from "@vectra/shared";
import { RESERVATION_FIELDS, statisticsFrames, reservationMetrics, bottleneckMetrics } from "@vectra/shared";
import { BUSINESS_DOMAINS, BUSINESS_DOMAIN_FIELDS, BUSINESS_FIELDS, businessMetrics, RETURN_REGIONS, type BusinessDomain, type BusinessDeclaration } from "@vectra/shared";

export const SCALE = 10000n;
export const MAX_RECORDS = MAX_TELEMETRY_RECORDS;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
export function validateQuery(value: unknown, catalog?: DataCatalog, now = Date.now()): StatisticsQuery {
  const fail = (message: string): never => { throw error("invalid_statistics", message, 422); };
  if (!object(value) || !keys(value, ["roads", "start", "end", "timeZone", "metrics", "dataset", "cohort", "analysis", "bucketMinutes", "domain", "businessSelection"])) return fail("统计方案字段无效。");
  const park = value.dataset === "park_visits", planning = value.dataset === "reservation_plans", business = value.dataset === "carrier_business", organised = park || planning || business;
  if (business ? typeof value.domain !== "string" || !Object.hasOwn(BUSINESS_DOMAINS,value.domain) : value.domain !== undefined) return fail("经营统计须明确受支持的台账类型，其他数据不能设置domain。");
  if (value.businessSelection !== undefined && (!business || value.domain !== "demand" || !["planned","deadline"].includes(String(value.businessSelection)))) return fail("只有运输需求支持按计划到达或最晚到达选取。");
  const future = planning || business && value.domain !== "haulage";
  const fields: readonly string[] = business ? BUSINESS_DOMAIN_FIELDS[value.domain as BusinessDomain] : planning ? RESERVATION_FIELDS : park ? PARK_FIELDS : TELEMETRY_FIELDS;
  if (value.dataset !== undefined && !organised || (park ? !["arrivals", "departures"].includes(String(value.cohort)) : value.cohort !== undefined)) return fail("实际车次须明确到达或离园口径；预约计划使用 reservation_plans，不能设置实际车次口径。");
  if (value.analysis !== undefined && (!park || value.analysis !== "bottleneck")) return fail("跨企业瓶颈分析只接受实际车次数据。");
  if (future ? !Number.isSafeInteger(value.bucketMinutes) || ![30, 60, 120, 240, 720, 1440].includes(Number(value.bucketMinutes)) : value.bucketMinutes !== undefined) return fail("未来计划粒度须为30、60、120、240、720或1440分钟，实际事实不设置计划粒度。");
  if (catalog && "dataset" in catalog && catalog.dataset === "park_visits" && !park) return fail("本轮使用园区车次数据，不能采用车辆采样口径。");
  if (catalog && "dataset" in catalog && catalog.dataset === "reservation_plans" && !planning) return fail("本轮使用预约计划，不能作为实际车次执行。");
  if (catalog && "dataset" in catalog && catalog.dataset === "carrier_business" && (!business || "domain" in catalog && catalog.domain !== value.domain)) return fail("经营台账与批准的数据类型不一致。");
  if (!Array.isArray(value.roads) || !value.roads.length || value.roads.length > (organised ? PARK_ENTRANCES.length : 8) || !value.roads.every(r => typeof r === "string" && /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,40}$/.test(r)) || new Set(value.roads).size !== value.roads.length) return fail(organised ? "每次可选择1—4个不重复的固定入口。" : "每次可查询 1—8 个不重复的路段编号。");
  if (!park && catalog && value.roads.some(r => !catalog.roads.some(road => road.id === r))) return fail(`路段没有可用数据。已登记路段：${catalog.roads.map(r => r.id).join("、")}。请先在数据管理页导入该道路的对应数据。`);
  if (organised && value.roads.some(road => !isParkEntrance(road))) return fail("园区固定为东入口、南入口、西入口、北入口，请选择其中的入口。");
  if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)) return fail("统计起止时间必须为有效的 Unix 毫秒整数，模型提交的时间格式无效。");
  if (value.timeZone !== "Asia/Shanghai") return fail("统计时区必须为 Asia/Shanghai（中国上海时间 UTC+08:00）。");
  if (Number(value.start) < 0 || !Number.isFinite(new Date(Number(value.start)).getTime()) || !Number.isFinite(new Date(Number(value.end)).getTime())) return fail("统计日期超出有效范围，请检查起止日期。");
  if (Number(value.end) <= Number(value.start)) return fail("统计结束时间必须晚于开始时间。");
  if (Number(value.end) - Number(value.start) > MAX_WINDOW_MS) return fail("统计时间跨度超过 31 天，请缩小查询范围。");
  if (Number(value.end) > now + (future ? MAX_WINDOW_MS : park || business ? 0 : 60_000)) return fail(future ? "未来计划最多查询未来31天。" : `统计结束时间 ${shanghaiTime(Number(value.end))} 晚于当前上海时间 ${shanghaiTime(now)}，不能统计未来实际事件。`);
  if (!Array.isArray(value.metrics) || !value.metrics.length || value.metrics.length > (business || value.analysis === "bottleneck" ? 20 : 12)) return fail("普通查询每次支持1—12个指标；经营或瓶颈分析最多20项统计。");
  for (const m of value.metrics) {
    if (!object(m) || !keys(m, ["label", "operation", "field", "denominatorField", "multiplier", "filter"]) || typeof m.label !== "string" || !m.label.trim() || m.label.length > 60 || !STAT_OPERATIONS.includes(m.operation as MetricSpec["operation"])) return fail("指标名称或聚合操作不在受控统计语言中。");
    const needsField = ["sum", "mean", "variance", "stddev", "ratio_of_sums"].includes(String(m.operation));
    if (needsField !== (m.field !== undefined) || m.field !== undefined && !fields.includes(String(m.field))) return fail("求和、均值、方差、标准差及总量比值须指定该数据类型的有效数值字段；计数和比例不接受数值字段。");
    if (m.operation === "ratio_of_sums" ? !fields.includes(String(m.denominatorField)) : m.denominatorField !== undefined) return fail("总量比值须指定有效分母字段。");
    if (m.multiplier !== undefined && (m.operation !== "ratio_of_sums" || ![1, 100].includes(Number(m.multiplier)))) return fail("总量比值倍率只支持 1 或 100。");
    if (m.filter !== undefined && (!object(m.filter) || !keys(m.filter, ["field", "op", "value"]) || !fields.includes(String(m.filter.field)) || !["lt", "lte", "gt", "gte", "eq"].includes(String(m.filter.op)) || typeof m.filter.value !== "number" || !Number.isFinite(m.filter.value) || m.filter.value < 0 || m.filter.value > (organised ? 1_000_000 : 1000))) return fail("筛选条件须使用该数据类型的受控字段、比较操作及有效非负阈值。");
    if (park && ["completed", "appointmentOnTime", "completeJourney"].includes(String(m.field))) return fail("标记比例请使用 ratio 与对应标记等于1的条件。");
    if (m.operation === "ratio" && !m.filter) return fail("样本比例必须指定筛选条件。");
  }
  if (new Set(value.metrics.map(m => m.label)).size !== value.metrics.length) return fail("指标名称不能重复。");
  const signature = (metric: MetricSpec) => JSON.stringify([metric.label, metric.operation, metric.field, metric.denominatorField, metric.multiplier, metric.filter?.field, metric.filter?.op, metric.filter?.value]);
  const checkedMetrics = value.metrics as MetricSpec[];
  if (value.analysis === "bottleneck" && (checkedMetrics.length !== 20 || bottleneckMetrics().some((metric, index) => signature(metric) !== signature(checkedMetrics[index]))))
    return fail("瓶颈分析必须包含固定的各环节观察值、完整链路共同样本均值和端到端均值。");
  if (planning) {
    if (checkedMetrics.some(metric => metric.operation === "vehicle_count") || reservationMetrics().some(required => !checkedMetrics.some(metric => signature(metric) === signature(required))))
      return fail("预约协同须包含预计到园车次、可投入运输车次、预计作业量三项总和，不能将计划额度当作去重车辆。");
    const frames = statisticsFrames(value as unknown as StatisticsQuery);
    if (frames.length > 128 || frames.length * (value.metrics.length * 4 + 2) > 2048) return fail("预约分组过细，请增大bucketMinutes、减少入口或缩短时间；最多128组、2048个分享分量。");
  }
  if (business) {
    if (value.domain !== "haulage" && checkedMetrics.some(metric=>metric.operation==="vehicle_count")) return fail("计划额度不能当作去重车辆。");
    const frames=statisticsFrames(value as unknown as StatisticsQuery);
    if(frames.length>128 || frames.length*(checkedMetrics.length*4+3)>2048) return fail("经营分组过细，请增大时间粒度、减少入口或指标；最多128组、2048个分享分量。");
  }
  return structuredClone(value) as unknown as StatisticsQuery;
}
function statisticsParameters(park: boolean) {
const fieldSchema = { type: "string", enum: park ? PARK_FIELDS : TELEMETRY_FIELDS };
return { type: "object", additionalProperties: false, required: ["roads", "start", "end", "timeZone", "metrics", ...(park ? ["dataset", "cohort"] : [])], properties: {
  ...(park ? { dataset: { type: "string", enum: ["park_visits"] }, cohort: { type: "string", enum: ["arrivals", "departures"], description: "arrivals 按到达时间选取，包含尚未离园车次；departures 按离园时间选取，仅已完成车次。缺省采用 arrivals。" } } : {}),
  roads: { type: "array", minItems: 1, maxItems: park ? PARK_ENTRANCES.length : 8, uniqueItems: true, items: { type: "string", ...(park ? { enum: PARK_ENTRANCES } : {}) } },
  start: { type: "integer", description: "区间起点 Unix 毫秒，含起点；今天为上海零点" }, end: { type: "integer", description: "区间终点 Unix 毫秒，不含终点；今天截止服务端当前时刻，不能使用明天零点" }, timeZone: { type: "string", enum: ["Asia/Shanghai"] },
  metrics: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: false, required: ["label", "operation"], properties: {
    label: { type: "string", maxLength: 60 }, operation: { type: "string", enum: STAT_OPERATIONS }, field: fieldSchema, denominatorField: fieldSchema, multiplier: { type: "number", enum: [1, 100] },
    filter: { type: "object", additionalProperties: false, required: ["field", "op", "value"], properties: { field: fieldSchema, op: { type: "string", enum: ["lt", "lte", "gt", "gte", "eq"] }, value: { type: "number" } } },
  } } },
} };
}
export const queryParameters = statisticsParameters(false);
export const parkQueryParameters = statisticsParameters(true);
export const operationsQueryParameters = {
  ...parkQueryParameters, required: ["dataset", "roads", "start", "end", "timeZone", "metrics"],
  properties: { ...parkQueryParameters.properties, dataset: { type: "string", enum: ["park_visits", "reservation_plans", "carrier_business"] },
    domain: { type: "string", enum: Object.keys(BUSINESS_DOMAINS), description: "仅carrier_business使用，区分需求弹性、实际装载空驶、回程及充电" },
    businessSelection: { type: "string", enum: ["planned","deadline"], description: "仅demand，按计划到达或最晚到达选取需求，每条只计一次" },
    end: { type: "integer", description: "终点Unix毫秒，不含终点；实际车次不能在未来，预约计划可到当前时刻后31天" },
    analysis: { type: "string", enum: ["bottleneck"], description: "跨企业等待与周转瓶颈分析；服务端补齐各环节及完整链路统计" },
    bucketMinutes: { type: "integer", enum: [30, 60, 120, 240, 720, 1440], description: "预约和未来经营台账使用，按时段开始时间分组，长区间选较粗粒度" },
    metrics: { ...parkQueryParameters.properties.metrics, maxItems: 20, items: {
      ...parkQueryParameters.properties.metrics.items, properties: {
        ...parkQueryParameters.properties.metrics.items.properties,
        field: { type: "string", enum: [...PARK_FIELDS, ...RESERVATION_FIELDS, ...BUSINESS_FIELDS] },
        denominatorField: { type: "string", enum: [...PARK_FIELDS, ...RESERVATION_FIELDS, ...BUSINESS_FIELDS] },
        filter: { ...parkQueryParameters.properties.metrics.items.properties.filter, properties: {
          ...parkQueryParameters.properties.metrics.items.properties.filter.properties,
          field: { type: "string", enum: [...PARK_FIELDS, ...RESERVATION_FIELDS, ...BUSINESS_FIELDS] },
        } },
      },
    } },
  },
};

// The request controls unambiguous time semantics; the model continues to choose the metric DSL.
function resolveQueryTime(request: string, query: Record<string, unknown>, now: number): Record<string, unknown> {
  if (/\d{4}[-/年]\d{1,2}/.test(request)) return query;
  const calendarDays = [...request.matchAll(/今天|今日|昨天|昨日|前天/g)];
  if (calendarDays.length) {
    // Preserve explicit subperiods, comparisons and multiple-day expressions for normal validation.
    const timeRequest = request.replace(/截至(?:当前|现在|此刻|目前)/g, "");
    // Arrival verbs and metric thresholds such as "排队超过30分钟" are not query subperiods.
    if (calendarDays.length !== 1 || /凌晨|早上|早晨|清晨|上午|中午|下午|傍晚|晚上|夜间|白天|[\d零〇一二两三四五六七八九十半]\s*[:：点]|[\d零〇一二两三四五六七八九十]\s*时(?!长)|之前|以前|之后|以后|明天|明日|后天|后日|未来|过去|最近|本周|上周|下周|本月|上月|下月|今年|去年|明年|周[一二三四五六日天]|从|截至/.test(timeRequest)) return query;
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
  if(object(value)&&value.dataset==="carrier_business"&&typeof value.domain==="string"&&Object.hasOwn(BUSINESS_DOMAINS,value.domain)) {
    const regions=Object.entries(RETURN_REGIONS).filter(([,name])=>request.includes(name));
    const requested=Array.isArray(value.metrics)&&value.metrics.length?value.metrics:businessMetrics(value.domain as BusinessDomain);
    const metrics=value.domain==="returns"&&regions.length===1?requested.map(metric=>{if(object(metric)&&metric.filter&&object(metric.filter)&&metric.filter.field!=="returnRegionCode")throw error("invalid_statistics","回程单次每指标仅支持一个筛选条件，请分别查询粗区域和其他阈值。",422);return {...metric,filter:{field:"returnRegionCode",op:"eq",value:Number(regions[0][0])}};}):requested;
    const next={...value,metrics,...(value.domain!=="haulage"?{bucketMinutes:value.bucketMinutes??120}:{})};
    return validateQuery(value.domain==="haulage"?resolveQueryTime(request,next,now):resolveReservationTime(request,next,now),catalog,now);
  }
  if (object(value) && value.dataset === "reservation_plans") {
    const metrics = Array.isArray(value.metrics) ? [...value.metrics] : [];
    for (const required of reservationMetrics()) if (!metrics.some(metric => object(metric) && metric.label === required.label)) metrics.push(required);
    return validateQuery(resolveReservationTime(request, { ...value, metrics, bucketMinutes: value.bucketMinutes ?? 60 }, now), catalog, now);
  }
  if (object(value) && value.dataset === "park_visits" && (value.analysis === "bottleneck" || /瓶颈|跨企业|全链路|完整链路/.test(request)))
    value = { ...value, analysis: "bottleneck", metrics: bottleneckMetrics() };
  // Resolve trusted request semantics before validation; the final query always passes every policy check.
  const timeRequest = object(value) && value.dataset === "park_visits" && !/今天|今日|昨天|昨日|前天|过去|最近|近\s*[\d零一二三四五六七八九十半]|明天|明日|后天|未来|\d{4}[-/年]|\d{1,2}[:：]\d{2}|本周|上周|下周|本月|上月|下月|今年|去年|明年|周[一二三四五六日天]|之前|以前|之后|以后/.test(request) ? "今天" : request;
  return validateQuery(object(value) ? resolveQueryTime(timeRequest, value, now) : value, catalog, now);
}
function resolveReservationTime(request: string, query: Record<string, unknown>, now: number) {
  if (/\d{4}[-/年]\d{1,2}/.test(request)) return query;
  const future = request.match(/(?:未来|接下来|今后)\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)\s*(?:个)?(小时|天|分钟)/);
  if (future) {
    const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 半: 0.5 };
    const amount = /^\d/.test(future[1]) ? Number(future[1]) : future[1].includes("十") ?
      (digits[future[1].split("十")[0]] ?? 1) * 10 + (digits[future[1].split("十")[1]] ?? 0) : digits[future[1]];
    const duration = amount * ({ 小时: 3600_000, 天: 86400_000, 分钟: 60_000 }[future[2]] ?? 0);
    return { ...query, start: now, end: now + duration, timeZone: "Asia/Shanghai" };
  }
  const day = request.match(/明天|明日|后天|今天|今日/);
  if (day && !/凌晨|上午|下午|晚上|\d\s*[:：点]|截至|之前|之后/.test(request)) {
    const offset = /后天/.test(day[0]) ? 2 : /明/.test(day[0]) ? 1 : 0;
    const start = Date.parse(shanghaiDay(now) + "T00:00:00+08:00") + offset * 86400_000;
    return { ...query, start: offset ? start : now, end: start + 86400_000, timeZone: "Asia/Shanghai" };
  }
  return query;
}

export function parseShanghaiDate(text: string) {
  const normalized = text.replace(" ", "T");
  return Date.parse(/[Zz]$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`);
}
function matches(record: StatisticsRecord, filter?: MetricSpec["filter"]) {
  if (!filter) return true;
  const value = record[filter.field]; if (value === undefined) return false;
  switch (filter.op) { case "lt": return value < filter.value; case "lte": return value <= filter.value; case "gt": return value > filter.value; case "gte": return value >= filter.value; case "eq": return value === filter.value; }
}
// Four additive sufficient statistics per road/metric: valid count, sum, square sum, denominator.
export function localVector(records: StatisticsRecord[], query: StatisticsQuery, declaration?: BusinessDeclaration): bigint[] {
  return statisticsFrames(query).flatMap(({ road, start, end }) => {
    const cohort = records.filter(r => r.road === road && r.recordedAt >= start && r.recordedAt < end);
    const metrics = query.metrics.flatMap(metric => {
    const base = records.filter(r => r.road === road && r.recordedAt >= start && r.recordedAt < end &&
      (!metric.field || r[metric.field] !== undefined) && (!metric.denominatorField || r[metric.denominatorField] !== undefined) && (!metric.filter || r[metric.filter.field] !== undefined));
    const selected = base.filter(r => matches(r, metric.filter));
    if (metric.operation === "vehicle_count" && selected.some(row => !row.vehicleId)) throw error("invalid_statistics", "去重车辆统计需要实际车辆标识，不能用于预约额度。", 422);
    const count = metric.operation === "vehicle_count" ? new Set(selected.map(r => r.vehicleId)).size : selected.length;
    let sum = 0n, square = 0n, denominator = 0n;
    for (const row of selected) {
      if (metric.field) { const encoded = BigInt(Math.round(row[metric.field]! * Number(SCALE))); sum += encoded; if (["variance", "stddev"].includes(metric.operation)) square += encoded * encoded; }
      if (metric.denominatorField) denominator += BigInt(Math.round(row[metric.denominatorField]! * Number(SCALE)));
    }
    if (metric.operation === "ratio" || query.dataset === "carrier_business" && metric.operation === "sum") denominator = BigInt(base.length);
    if (metric.operation === "vehicle_count") denominator = BigInt(selected.length);
    return [BigInt(count), sum, square, denominator];
    });
    if (query.dataset === "carrier_business") return [...metrics, BigInt(cohort.length), BigInt(cohort.length > 0 ? 1 : 0), BigInt(declaration && declaration.start<=start && declaration.end>=end ? 1 : 0)];
    if (query.dataset === "reservation_plans") return [...metrics, BigInt(cohort.length), BigInt(cohort.length > 0 ? 1 : 0)];
    if (query.dataset !== "park_visits") return metrics;
    const completed = cohort.filter(r => r.completed === 1).length;
    return [...metrics, BigInt(cohort.length), BigInt(completed), BigInt(cohort.length - completed), BigInt(cohort.length > 0 ? 1 : 0)];
  });
}
export function finishVector(vector: bigint[], query: StatisticsQuery): RoadStatistics[] {
  const park = query.dataset === "park_visits";
  const frames = statisticsFrames(query);
  if (vector.length !== frames.length * (query.metrics.length * 4 + (park ? 4 : query.dataset === "reservation_plans" ? 2 : query.dataset === "carrier_business" ? 3 : 0)) || vector.some(v => v < 0n || v > 18000n * (query.dataset ? 10000000000000n : 10000000n) ** 2n)) throw error("mpc_output_invalid", "统计向量维数或范围无效。", 403);
  let index = 0;
  return frames.map(({ road, start, end }) => {
    const businessRecords=vector[index+query.metrics.length*4];
    const completeBusiness=query.dataset==="carrier_business"&&vector[index+query.metrics.length*4+2]===3n;
    const metrics = query.metrics.map(metric => {
    const [n, s, sq, d] = vector.slice(index, index += 4).map(Number);
    if (n > MAX_RECORDS * 3) throw error("mpc_output_invalid", "统计样本数量超出批准范围。", 403);
    const mean = n ? s / Number(SCALE) / n : null;
    let value: number | null;
    switch (metric.operation) {
      case "count": case "vehicle_count": value = query.dataset === "carrier_business" && n===0 && !completeBusiness ? null : n; break;
      case "sum": value = n ? s / Number(SCALE) : query.dataset === "carrier_business" && (d>0 || completeBusiness && businessRecords===0n) ? 0 : null; break;
      case "mean": value = mean; break;
      case "variance": case "stddev": { const variance = n ? Math.max(0, sq / Number(SCALE * SCALE) / n - mean! ** 2) : null; value = variance === null ? null : metric.operation === "stddev" ? Math.sqrt(variance) : variance; break; }
      case "ratio": value = d ? n / d * 100 : null; break;
      case "ratio_of_sums": value = d ? s / d * (metric.multiplier ?? 1) : null; break;
    }
    return { label: metric.label, value: value === null ? null : Number(value.toFixed(6)), unit: metricUnit(metric, query.dataset), validSamples: ["ratio", "vehicle_count"].includes(metric.operation) ? d : n, ...(value === null ? { note: park ? "所选车次没有完整的对应数据或分母为零；缺失时间和用电量未补零。" : "区间内没有完整有效样本或分母为零；未补零。" } : {}) };
    });
    if (query.dataset === "carrier_business") {
      const [records,contributingCarriers,declaredCarriers]=vector.slice(index,index+=3).map(Number);
      if(![records,contributingCarriers,declaredCarriers].every(Number.isSafeInteger)||records>MAX_RECORDS*3||contributingCarriers>3||declaredCarriers>3||(records===0)!==(contributingCarriers===0)) throw error("mpc_output_invalid","经营资料覆盖无效。",403);
      return {road,metrics,slotStart:start,slotEnd:end,businessCoverage:{records,contributingCarriers,declaredCarriers}};
    }
    if (query.dataset === "reservation_plans") {
      const [declaredSlots, contributingCarriers] = vector.slice(index, index += 2).map(Number);
      if (!Number.isSafeInteger(declaredSlots) || declaredSlots > MAX_RECORDS * 3 || !Number.isSafeInteger(contributingCarriers) || contributingCarriers > 3 ||
        (declaredSlots === 0) !== (contributingCarriers === 0)) throw error("mpc_output_invalid", "预约申报覆盖不一致。", 403);
      return { road, metrics, slotStart: start, slotEnd: end, planCoverage: { declaredSlots, contributingCarriers } };
    }
    if (!park) return { road, metrics };
    const [visits, completed, unfinished, contributingCarriers] = vector.slice(index, index += 4).map(Number);
    if (![visits, completed, unfinished, contributingCarriers].every(Number.isSafeInteger) || visits > MAX_RECORDS * 3 || completed + unfinished !== visits || contributingCarriers > 3 || (visits === 0) !== (contributingCarriers === 0)) throw error("mpc_output_invalid", "车次覆盖范围不一致。", 403);
    return { road, metrics, coverage: { visits, completed, unfinished, contributingCarriers } };
  });
}

export function validateStatisticsOutput(value: unknown, query: StatisticsQuery): RoadStatistics[] {
  const fail = (): never => { throw error("mpc_output_invalid", "联合统计结果的指标、单位或车次覆盖与批准口径不一致。", 403); };
  const frames = statisticsFrames(query);
  if (!Array.isArray(value) || value.length !== frames.length) return fail();
  for (const [i, group] of value.entries()) {
    if (!object(group) || group.road !== frames[i].road || !Array.isArray(group.metrics) || group.metrics.length !== query.metrics.length ||
      ["reservation_plans","carrier_business"].includes(query.dataset??"") && (group.slotStart !== frames[i].start || group.slotEnd !== frames[i].end)) return fail();
    let visits = MAX_RECORDS * 3;
    if(query.dataset==="carrier_business"){
      const coverage=group.businessCoverage;
      if(!object(coverage)||![coverage.records,coverage.contributingCarriers,coverage.declaredCarriers].every(v=>Number.isSafeInteger(v)&&Number(v)>=0)||Number(coverage.records)>MAX_RECORDS*3||Number(coverage.contributingCarriers)>3||Number(coverage.declaredCarriers)>3||(coverage.records===0)!==(coverage.contributingCarriers===0))return fail();
      visits=Number(coverage.records);
    }
    if (query.dataset === "reservation_plans") {
      const coverage = group.planCoverage;
      if (!object(coverage) || !Number.isSafeInteger(coverage.declaredSlots) || Number(coverage.declaredSlots) < 0 || Number(coverage.declaredSlots) > MAX_RECORDS * 3 ||
        !Number.isSafeInteger(coverage.contributingCarriers) || Number(coverage.contributingCarriers) < 0 || Number(coverage.contributingCarriers) > 3 ||
        (coverage.declaredSlots === 0) !== (coverage.contributingCarriers === 0)) return fail();
      visits = Number(coverage.declaredSlots);
    }
    if (query.dataset === "park_visits") {
      const c = group.coverage;
      if (!object(c) || ![c.visits, c.completed, c.unfinished, c.contributingCarriers].every(v => Number.isSafeInteger(v) && Number(v) >= 0) || Number(c.visits) > MAX_RECORDS * 3 || Number(c.completed) + Number(c.unfinished) !== c.visits || Number(c.contributingCarriers) > 3 || (c.visits === 0) !== (c.contributingCarriers === 0) || query.cohort === "departures" && c.unfinished !== 0) return fail();
      visits = Number(c.visits);
    }
    for (const [j, result] of group.metrics.entries()) {
      const metric = query.metrics[j];
      if (!object(result) || result.label !== metric.label || result.unit !== metricUnit(metric, query.dataset) || !Number.isSafeInteger(result.validSamples) || Number(result.validSamples) < 0 || Number(result.validSamples) > visits || result.value !== null && (typeof result.value !== "number" || !Number.isFinite(result.value) || result.value < 0)) return fail();
      if (["count", "vehicle_count"].includes(metric.operation) && !(query.dataset === "carrier_business" && result.value === null) && (!Number.isSafeInteger(result.value) || Number(result.value) > Number(result.validSamples)) || metric.operation === "ratio" && result.value !== null && Number(result.value) > 100) return fail();
    }
  }
  return value as RoadStatistics[];
}
