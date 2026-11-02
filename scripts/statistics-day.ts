import { PARK_ENTRANCES, CARRIER_BINDINGS, JOURNEY_STAGES, PARK_FIELDS, BUSINESS_DOMAINS, BUSINESS_DOMAIN_FIELDS, businessMetrics, bottleneckMetrics, reservationMetrics,
  type ParkVehicle, type ParkVisit, type ReservationSlot, type CapacitySlot, type ChargeCapacitySlot, type BusinessRecordMap, type BusinessDomain, type CarrierId, type StatisticsQuery, type MetricSpec } from "@vectra/shared";

const minute = 60_000, halfHour = 30 * minute, hour = 60 * minute;
const round = (value: number) => Math.round(value * 100) / 100;
export type DayLedger = { [D in BusinessDomain]: BusinessRecordMap[D][] };
export interface CarrierDay {
  owner: CarrierId; vehicles: ParkVehicle[]; visits: ParkVisit[]; reservations: ReservationSlot[]; business: DayLedger;
}
export function buildStatisticsDay(day: string) {
  const start = Date.parse(day + "T00:00:00+08:00"), end = start + 24 * hour;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(start) || new Date(start + 8 * hour).toISOString().slice(0, 10) !== day) throw new Error("日期须为有效的 YYYY-MM-DD 上海日期。");
  const code = day.replaceAll("-", "");
  const carriers: CarrierDay[] = CARRIER_BINDINGS.map((binding, company) => {
    const vehicles: ParkVehicle[] = [], visits: ParkVisit[] = [], reservations: ReservationSlot[] = [];
    const business: DayLedger = { demand: [], haulage: [], returns: [], charging: [] };
    for (const [roadIndex, road] of PARK_ENTRANCES.entries()) {
      const roadVehicles = Array.from({ length: 8 }, (_, index): ParkVehicle => {
        const plate = ["沪A", "苏B", "浙C"][company] + String(51001 + roadIndex * 8 + index);
        return { vehicleId: plate, plateNumber: plate, carrierId: binding.id, allowedRoads: [], vehicleType: (["heavy_truck", "light_truck", "tractor", "van", "other"] as const)[index % 5],
          energyType: index < 6 ? "electric" : index === 6 ? "diesel" : roadIndex % 2 ? "other" : "hybrid",
          ...(index === 7 ? {} : { capacityTonnes: index === 6 ? 0 : [8, 12, 18, 24, 30, 40][index] }) };
      });
      vehicles.push(...roadVehicles);
      for (let trip = 0; trip < 25; trip++) {
        const atHour = trip === 24 ? 12 : trip, vehicle = roadVehicles[trip === 24 ? 6 : trip % 6];
        const arrivedAt = start + atHour * hour + (company * 2 + roadIndex + (trip === 24 ? 15 : 0)) * minute;
        const durations = [10 + company * 5 + trip % 4 * 7, 25 + company * 10 + roadIndex * 5, 8 + trip % 4 * 6,
          [5, 15, 35, 55, 0, 25][(trip + company + roadIndex) % 6], 3 + trip % 3 * 2, 7 + company * 2, [5, 20, 40, 65][trip % 4], 15 + trip % 4 * 10, 5 + trip % 3 * 6];
        const visit: ParkVisit = { visitId: `${code}-${company + 1}-${roadIndex + 1}-${String(trip + 1).padStart(3, "0")}`, carrierId: binding.id, vehicleId: vehicle.vehicleId, road, arrivedAt };
        let time = arrivedAt - durations.slice(0, 3).reduce((sum, value) => sum + value, 0) * minute;
        visit.dispatchReadyAt = time;
        for (const [index, stage] of JOURNEY_STAGES.entries()) { time += durations[index] * minute; visit[stage.end] = time; }
        if (trip % 4 !== 3) {
          visit.appointmentStart = arrivedAt + (trip % 4 === 2 ? 10 : trip % 4 === 1 ? -45 : -15) * minute;
          visit.appointmentEnd = arrivedAt + (trip % 4 === 2 ? 30 : trip % 4 === 1 ? 0 : 15) * minute;
        }
        if (trip === 20) delete visit.departedAt;
        if (trip === 21) for (const field of ["readyAt", "serviceStartedAt", "serviceEndedAt", "departedAt"] as const) delete visit[field];
        if (trip === 22) for (const field of ["serviceEndedAt", "departedAt"] as const) delete visit[field];
        if (trip === 23) for (const stage of JOURNEY_STAGES.slice(3)) delete visit[stage.end];
        if (trip % 8 === 1) delete visit.dispatchReadyAt;
        if (trip % 8 === 2) delete visit.gateStartedAt;
        if (trip % 8 === 3) delete visit.readyAt;
        const distance = trip === 18 ? 0 : 80 + trip * 7 + company * 10 + roadIndex * 5;
        if (visit.departedAt !== undefined) {
          if (trip !== 8) visit.distanceKm = distance;
          if (trip !== 7 && trip !== 24) visit.energyKwh = round(distance * (0.9 + company * 0.2 + trip % 3 * 0.15));
        }
        visits.push(visit);
        if (visit.departedAt !== undefined) {
          const utilization = [0.2, 0.45, 0.7, 1, 0, 0.85][trip % 6], volumeCapacity = 38 + roadIndex * 12, palletCapacity = 20 + roadIndex * 4;
          const loaded = round(distance * (1 - [0, 0.15, 0.35, 0.7, 1][trip % 5]));
          business.haulage.push({ id: "H-" + visit.visitId, visitId: visit.visitId, vehicleId: visit.vehicleId, road, recordedAt: visit.departedAt, sourceParkVersion: "",
            ...(vehicle.capacityTonnes === undefined ? {} : { loadCapacityTonnes: vehicle.capacityTonnes }),
            ...(trip === 5 ? {} : { actualLoadTonnes: round((vehicle.capacityTonnes ?? 0) * utilization) }),
            ...(trip === 9 ? {} : { actualVolumeM3: round(volumeCapacity * utilization), loadCapacityVolumeM3: volumeCapacity }),
            ...(trip === 11 ? {} : { pallets: Math.floor(palletCapacity * utilization), loadCapacityPallets: palletCapacity }),
            ...(trip === 6 ? {} : { loadedDistanceKm: loaded, emptyDistanceKm: round(distance - loaded) }) });
        }
      }
      for (let slot = 0; slot < 48; slot++) {
        const slotStart = start + slot * halfHour, peak = slot >= 14 && slot <= 20 || slot >= 32 && slot <= 38;
        const expectedTrips = slot < 6 ? 0 : 2 + (slot + company + roadIndex) % 5 + (peak ? 8 : 0);
        reservations.push({ carrierId: binding.id, road, slotStart, expectedTrips, availableTrips: Math.max(0, expectedTrips + (company - 1) * 2 + (slot % 3 === 0 ? -4 : 2)), requiredWorkMinutes: expectedTrips * (25 + company * 5 + roadIndex * 3) });
        const id = `${code}-${company + 1}-${roadIndex + 1}-${String(slot + 1).padStart(3, "0")}`;
        business.demand.push({ id: "D-" + id, road, slotStart, earliestAt: slotStart - (slot % 4 < 2 ? hour : 0), latestAt: slotStart + (slot % 4 % 2 === 0 ? hour : 0),
          expectedTrips, reservedTrips: Math.floor(expectedTrips * (slot % 3 + 1) / 3), minimumCommittedTrips: Math.floor(expectedTrips * (slot % 3 + 1) / 4), expectedWorkMinutes: expectedTrips * (25 + company * 5),
          ...(slot % 11 === 1 ? {} : { cargoTonnes: expectedTrips * 12, cargoVolumeM3: expectedTrips * 25, pallets: expectedTrips * 16 }) });
        business.returns.push({ id: "R-" + id, road, slotStart, availableUntil: slotStart + (1 + slot % 3) * hour, availableTrips: (slot + company + roadIndex) % 7, regionCode: (1 + (slot + company + roadIndex) % 9) as BusinessRecordMap["returns"]["regionCode"] });
        business.charging.push({ id: "C-" + id, road, slotStart, vehicleId: roadVehicles[slot % 6].vehicleId, deadlineAt: slotStart + [0.5, 1, 2, 2.5][slot % 4] * hour,
          connector: (["dc", "ac", "other"] as const)[(slot + roadIndex) % 3], batteryCapacityKwh: [180, 240, 300, 420][(slot + company) % 4], socPercent: [10, 30, 50, 70][slot % 4], targetSocPercent: 90,
          ...(slot % 6 === 5 ? {} : { maxPowerKw: [20, 60, 180, 350][slot % 4] }) });
      }
    }
    return { owner: binding.id, vehicles, visits, reservations, business };
  });
  const capacities: CapacitySlot[] = [], chargeCapacities: ChargeCapacitySlot[] = [];
  for (const [roadIndex, road] of PARK_ENTRANCES.entries()) for (let slot = 0; slot < 48; slot++) {
    const slotStart = start + slot * halfHour, entryCapacity = slot < 6 ? 0 : [8, 20, 35, 60][(slot + roadIndex) % 4];
    capacities.push({ road, slotStart, entryCapacity, serviceCapacityMinutes: entryCapacity * [15, 25, 40, 60][slot % 4] });
    for (const [connectorIndex, connector] of (["dc", "ac", "other"] as const).entries()) {
      const ports = slot < 6 ? 0 : connector === "dc" ? [1, 3, 8, 16][slot % 4] : connector === "ac" ? 4 : slot % 4 === 0 ? 0 : 2;
      const maxPowerKw = [180, 22, 60][connectorIndex];
      chargeCapacities.push({ road, slotStart, connector, ports, maxPowerKw, capacityKwh: round(ports * maxPowerKw * 0.5 * (slot % 2 ? 1 : 0.7)) });
    }
  }
  return { day, start, end, carriers, capacities, chargeCapacities };
}
export type StatisticsDay = ReturnType<typeof buildStatisticsDay>;

export function statisticsDayQueries(data: StatisticsDay): StatisticsQuery[] {
  const base = { roads: [...PARK_ENTRANCES], start: data.start, end: data.end, timeZone: "Asia/Shanghai" as const };
  const park: StatisticsQuery = { ...base, dataset: "park_visits", cohort: "arrivals", metrics: [
    { label: "到达车次数", operation: "count" }, { label: "车辆数", operation: "vehicle_count" },
    { label: "未离园车次数", operation: "count", filter: { field: "completed", op: "eq", value: 0 } },
    { label: "完成率", operation: "ratio", filter: { field: "completed", op: "eq", value: 1 } },
    { label: "预约准点率", operation: "ratio", filter: { field: "appointmentOnTime", op: "eq", value: 1 } },
    { label: "排队超30分钟比例", operation: "ratio", filter: { field: "queueMinutes", op: "gt", value: 30 } },
    { label: "平均排队", operation: "mean", field: "queueMinutes" }, { label: "排队方差", operation: "variance", field: "queueMinutes" },
    { label: "排队标准差", operation: "stddev", field: "queueMinutes" }, { label: "平均周转", operation: "mean", field: "turnaroundMinutes" },
    { label: "完整行程里程", operation: "sum", field: "distanceKm" }, { label: "完整行程用电", operation: "sum", field: "energyKwh" },
  ] };
  const queries: StatisticsQuery[] = [park, { ...park, cohort: "departures" }, { ...park, analysis: "bottleneck", metrics: bottleneckMetrics() },
    { ...base, dataset: "reservation_plans", bucketMinutes: 240, metrics: [...reservationMetrics(), ...["expectedTrips", "availableTrips", "requiredWorkMinutes"].flatMap(field =>
      (["mean", "variance", "stddev"] as const).map(operation => ({ label: field + ":" + operation, field: field as MetricSpec["field"], operation }))) ] }];
  const numericMetrics = (fields: readonly string[]) => fields.flatMap(field => (["sum", "mean", "variance", "stddev"] as const).map(operation => ({ label: field + ":" + operation, field: field as MetricSpec["field"], operation })));
  const parkMetrics = numericMetrics(PARK_FIELDS.filter(field => !["completed", "appointmentOnTime", "completeJourney"].includes(field)));
  for (let i = 0; i < parkMetrics.length; i += 12) queries.push({ ...park, metrics: parkMetrics.slice(i, i + 12) });
  queries.push({ ...park, metrics: [{ label: "百公里用电", operation: "ratio_of_sums", field: "energyKwh", denominatorField: "distanceKm", multiplier: 100 }] });
  for (const domain of Object.keys(BUSINESS_DOMAINS) as BusinessDomain[]) {
    const business: StatisticsQuery = { ...base, dataset: "carrier_business", domain, ...(domain === "haulage" ? {} : { bucketMinutes: 240 }), metrics: businessMetrics(domain) };
    queries.push(business);
    if (domain === "demand") queries.push({ ...business, businessSelection: "deadline" });
    const metrics = numericMetrics(BUSINESS_DOMAIN_FIELDS[domain]);
    for (let i = 0; i < metrics.length; i += 20) queries.push({ ...business, metrics: metrics.slice(i, i + 20) });
    if (domain === "returns") queries.push({ ...business, metrics: Array.from({ length: 9 }, (_, i): MetricSpec => ({ label: "区域" + (i + 1), operation: "sum", field: "availableReturnTrips", filter: { field: "returnRegionCode", op: "eq", value: i + 1 } })) });
  }
  return queries;
}
