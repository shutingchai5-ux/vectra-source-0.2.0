import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BUSINESS_DOMAINS, BUSINESS_DOMAIN_FIELDS, PARK_ENTRANCES, shanghaiDay, statisticsFrames, reservationContextFor, coordinateReservations, summarizeBottleneck, chargeCapacityResult,
  type BusinessDomain, type StatisticsQuery, type ChargeCapacityWindow, type StatisticsRecord } from "@vectra/shared";
import { Security } from "../src/security";
import { ParkData, validateParkVisits, projectParkVisits } from "../src/park";
import { FleetData } from "../src/fleet";
import { ReservationData, validateReservationRows, projectReservations } from "../src/reservations";
import { BusinessData, validateChargeCapacities, projectBusiness } from "../src/business";
import { validateQuery, localVector, finishVector } from "../src/statistics";
import { buildStatisticsDay, statisticsDayQueries } from "../../../scripts/statistics-day";

test("the dated dataset is deterministic, complete by owner and entrance, and has coherent vehicle timelines", () => {
  const data = buildStatisticsDay("2026-11-05");
  expect(buildStatisticsDay("2026-11-05")).toEqual(data);
  expect(() => buildStatisticsDay("2026-02-30")).toThrow();
  expect(new Set(data.carriers.flatMap(carrier => carrier.vehicles.map(vehicle => vehicle.vehicleId))).size).toBe(96);
  expect(validateChargeCapacities(data.chargeCapacities, data.start)).toHaveLength(576);
  expect(validateReservationRows(data.capacities, true, data.start)).toHaveLength(192);
  for (const carrier of data.carriers) {
    expect(carrier.vehicles).toHaveLength(32); expect(carrier.visits).toHaveLength(100);
    expect(validateParkVisits(carrier.visits, data.end)).toEqual(carrier.visits);
    expect(carrier.visits.filter(visit => visit.departedAt !== undefined)).toHaveLength(84);
    expect(() => validateParkVisits(carrier.visits, data.start - 86400000)).toThrow(/未来/);
    expect(validateReservationRows(carrier.reservations, false, data.start)).toHaveLength(192);
    for (const road of PARK_ENTRANCES) {
      expect(carrier.visits.filter(visit => visit.road === road)).toHaveLength(25);
      expect(new Set(carrier.business.returns.filter(row => row.road === road).map(row => row.regionCode)).size).toBe(9);
    }
    for (const vehicle of carrier.vehicles) {
      const visits = carrier.visits.filter(visit => visit.vehicleId === vehicle.vehicleId).sort((a, b) => a.arrivedAt - b.arrivedAt);
      for (let i = 1; i < visits.length; i++) expect(visits[i].dispatchReadyAt ?? visits[i].arrivedAt).toBeGreaterThanOrEqual(visits[i - 1].departedAt!);
      const charges = carrier.business.charging.filter(row => row.vehicleId === vehicle.vehicleId).sort((a, b) => a.slotStart - b.slotStart);
      for (let i = 1; i < charges.length; i++) expect(charges[i].slotStart).toBeGreaterThanOrEqual(charges[i - 1].deadlineAt);
    }
    for (const haulage of carrier.business.haulage) {
      const source = carrier.visits.find(visit => visit.visitId === haulage.visitId)!;
      expect(haulage.recordedAt).toBe(source.departedAt!);
      if (source.distanceKm !== undefined && haulage.loadedDistanceKm !== undefined) expect(haulage.loadedDistanceKm + haulage.emptyDistanceKm!).toBeCloseTo(source.distanceKm, 8);
    }
  }
});

test("dated datasets persist with linked source versions and cover every metric family without relaxing real-clock defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-statistics-day-"));
  const data = buildStatisticsDay(shanghaiDay(Date.now() + 3 * 86400000));
  const sources: { park: ParkData; reservations: ReservationData; business: BusinessData }[] = [];
  try {
    for (const carrier of data.carriers) {
      const security = await Security.open(join(root, carrier.owner)), park = new ParkData(security, [carrier.owner]), fleet = new FleetData(security, park, [carrier.owner]);
      fleet.save(carrier.owner, carrier.vehicles, fleet.catalog().version, true);
      expect(() => park.import(carrier.visits, park.catalog().version)).toThrow(/未来/);
      park.import(carrier.visits, park.catalog().version, data.end);
      expect(park.catalog().updatedAt).toBeLessThan(data.start);
      const reservations = new ReservationData(security, () => park.catalog().settings, [carrier.owner]), business = new BusinessData(security, carrier.owner, park, fleet);
      reservations.replaceCarrier(carrier.owner, carrier.reservations, reservations.catalog().version);
      for (const domain of Object.keys(BUSINESS_DOMAINS) as BusinessDomain[]) {
        const records = domain === "haulage" ? carrier.business.haulage.map(row => ({ ...row, sourceParkVersion: park.catalog().version })) : carrier.business[domain];
        const declaration = { start: data.start, end: data.end };
        if (domain === "haulage") expect(() => business.replace(domain, records, declaration, business.catalog(domain).version)).toThrow(/实际事实不能在未来/);
        business.replace(domain, records, declaration, business.catalog(domain).version, domain === "haulage" ? data.end : Date.now());
        expect(business.snapshot(domain).records).toEqual(records);
      }
      sources.push({ park, reservations, business });
    }
    const compute = (query: StatisticsQuery) => {
      validateQuery(query, undefined, data.end);
      const vectors = sources.map(source => {
        const records = query.dataset === "park_visits" ? projectParkVisits(source.park.snapshot().visits, query) : query.dataset === "reservation_plans" ? projectReservations(source.reservations.forCarrier(source.business.owner).slots) : projectBusiness(source.business.snapshot(query.domain!).records, query);
        return localVector(records, query, query.domain ? source.business.catalog(query.domain).declaration : undefined);
      });
      return finishVector(vectors[0].map((_, index) => vectors.reduce((sum, vector) => sum + vector[index], 0n)), query);
    };
    const queries = statisticsDayQueries(data);
    expect(queries).toHaveLength(25);
    for (const query of queries) for (const group of compute(query)) {
      expect(group.metrics.every(metric => metric.value === null || Number.isFinite(metric.value))).toBeTrue();
      if (query.dataset === "carrier_business") expect(group.businessCoverage?.declaredCarriers).toBe(3);
      if (query.dataset === "reservation_plans") expect(group.planCoverage).toEqual({ declaredSlots: 24, contributingCarriers: 3 });
    }
    for (const group of compute(queries[0])) {
      expect(group.metrics.slice(0, 4).map(metric => metric.value)).toEqual([75, 21, 12, 84]);
      expect(group.coverage).toEqual({ visits: 75, completed: 63, unfinished: 12, contributingCarriers: 3 });
    }
    for (const group of compute(queries[1])) expect(group.metrics.slice(0, 4).map(metric => metric.value)).toEqual([63, 21, 0, 100]);
    for (const group of compute(queries[2])) {
      const bottleneck = summarizeBottleneck(group);
      expect(bottleneck.complete).toBe(36);
      expect(bottleneck.stages.reduce((sum, stage) => sum + stage.comparable!, 0)).toBeCloseTo(bottleneck.total!, 4);
    }
    for (const domain of Object.keys(BUSINESS_DOMAINS) as BusinessDomain[]) {
      const query = queries.find(query => query.domain === domain)!;
      const records: StatisticsRecord[] = sources.flatMap(source => projectBusiness(source.business.snapshot(domain).records, query));
      for (const field of BUSINESS_DOMAIN_FIELDS[domain]) expect(records.some(record => record[field] !== undefined)).toBeTrue();
    }
    const reservationQuery = queries[3], coordination = coordinateReservations(compute(reservationQuery), reservationContextFor(data.capacities, reservationQuery));
    expect(coordination.rows.every(row => !row.inputMissing && row.entryCapacity !== null)).toBeTrue();
    expect(coordination.rows.some(row => row.transportGap > 0 || (row.entryGap ?? 0) > 0 || (row.workGapMinutes ?? 0) > 0)).toBeTrue();
    const chargeQuery = queries.find(query => query.domain === "charging")!;
    const windows: ChargeCapacityWindow[] = statisticsFrames(chargeQuery).flatMap(frame => (["dc", "ac", "other"] as const).map(connector => {
      const slots = data.chargeCapacities.filter(slot => slot.road === frame.road && slot.connector === connector && slot.slotStart >= frame.start && slot.slotStart < frame.end);
      return { ...frame, connector, capacityKwh: slots.reduce((sum, slot) => sum + slot.capacityKwh, 0), coveredSlots: slots.length, expectedSlots: 8 };
    }));
    const pressures = chargeCapacityResult(compute(chargeQuery), windows, chargeQuery.metrics).flatMap(row => row.connectors);
    expect(pressures.some(connector => connector.gapKwh !== null && connector.gapKwh > 0)).toBeTrue();
    expect(pressures.some(connector => connector.gapKwh === 0)).toBeTrue();
  } finally { if (resolve(root).startsWith(resolve(tmpdir(), "vectra-statistics-day-"))) rmSync(root, { recursive: true, force: true }); }
}, 20000);
