import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startServer } from "../src/index";
import { config } from "../src/config";
import type { ParkSnapshot } from "@vectra/shared";

test("complete admission, scoped lifecycle, safe retries and record-level concurrency preserve all other visits", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-visit-operations-")), live = await startServer({ ...config(), dataDir: root, logDir: join(root, "logs"), port: 0, cooldown: 0 });
  try {
    const base = "http://127.0.0.1:" + live.server.port, cookie = (await fetch(base + "/api/session")).headers.get("set-cookie")!.split(";")[0];
    const send = (path: string, method = "GET", value?: unknown, token?: string) => fetch(base + path, { method, headers: { Cookie: cookie, "Content-Type": "application/json", ...(token ? { "X-Carrier-Role": token } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const roleA = (await (await send("/api/carrier-role", "POST", { carrierId: "carrier-a" })).json()).token, roleB = (await (await send("/api/carrier-role", "POST", { carrierId: "carrier-b" })).json()).token;
    for (const [carrierId, token, plates] of [["carrier-a", roleA, ["沪A12345", "沪A23456"]], ["carrier-b", roleB, ["沪B12345"]]] as const) {
      const fleet = await (await send("/api/carrier/fleet", "GET", undefined, token)).json();
      expect((await send("/api/fleet", "POST", { carrierId, baseVersion: fleet.version, vehicles: plates.map(plateNumber => ({ plateNumber, carrierId, allowedRoads: ["东入口", "西入口"] })) }, token)).status).toBe(201);
    }
    expect(live.app.park.snapshot().visits).toHaveLength(0);
    const input = { visitId: randomUUID(), vehicleId: "沪A12345", road: "东入口" }, admissions = "/api/carrier/visits/admissions";
    expect((await send(admissions, "POST", input)).status).toBe(403);
    for (const invalid of [{ visitId: randomUUID(), vehicleId: "沪A12345" }, { ...input, vehicleId: "" }, { ...input, road: "第五入口" }, { ...input, vehicleId: "沪B12345" }, { ...input, carrierId: "carrier-b" }, { ...input, enteredAt: Date.now() + 86400000 }]) expect((await send(admissions, "POST", invalid, roleA)).status).toBeGreaterThanOrEqual(400);
    expect(live.app.park.snapshot().visits).toHaveLength(0);
    const before = Date.now(), admittedResponse = await send(admissions, "POST", input, roleA); expect(admittedResponse.status).toBe(201);
    const admitted = await admittedResponse.json() as ParkSnapshot, first = admitted.visits[0];
    expect(first).toMatchObject({ visitId: input.visitId, carrierId: "carrier-a", vehicleId: "沪A12345", road: "东入口" }); expect(first.enteredAt).toBeGreaterThanOrEqual(before); expect(first.enteredAt).toBeLessThanOrEqual(Date.now()); expect(first.arrivedAt).toBe(first.enteredAt!);
    const repeated = await (await send(admissions, "POST", input, roleA)).json() as ParkSnapshot; expect(repeated.version).toBe(admitted.version); expect(repeated.visits).toEqual(admitted.visits);
    expect((await send(admissions, "POST", { ...input, visitId: randomUUID() }, roleA)).status).toBe(409);
    const path = "/api/carrier/visits/" + input.visitId;
    expect((await send(path + "/lifecycle", "POST", { field: "serviceEndedAt", baseVersion: admitted.version }, roleA)).status).toBe(422);
    expect((await send(path + "/lifecycle", "POST", { field: "serviceStartedAt", baseVersion: admitted.version }, roleB)).status).toBe(404);
    expect(live.app.park.snapshot().version).toBe(admitted.version);
    const secondInput = { visitId: randomUUID(), vehicleId: "沪A23456", road: "西入口" }, second = await (await send(admissions, "POST", secondInput, roleA)).json() as ParkSnapshot;
    const startedResponse = await send(path + "/lifecycle", "POST", { field: "serviceStartedAt", baseVersion: admitted.version }, roleA); expect(startedResponse.status).toBe(200);
    let current = await startedResponse.json() as ParkSnapshot;
    expect(current.visits).toHaveLength(2); expect(current.visits.find(row => row.visitId === secondInput.visitId)).toEqual(second.visits.find(row => row.visitId === secondInput.visitId));
    const started = current.visits.find(row => row.visitId === input.visitId)!;
    const retried = await (await send(path + "/lifecycle", "POST", { field: "serviceStartedAt", baseVersion: admitted.version }, roleA)).json() as ParkSnapshot;
    expect(retried.version).toBe(current.version); expect(retried.visits.find(row => row.visitId === input.visitId)?.serviceStartedAt).toBe(started.serviceStartedAt);
    expect((await send(path, "PUT", { visit: first, baseVersion: admitted.version }, roleA)).status).toBe(409);
    for (const field of ["serviceEndedAt", "departedAt"]) {
      const response = await send(path + "/lifecycle", "POST", { field, baseVersion: current.version, ...(field === "departedAt" ? { distanceKm: 0, energyKwh: 0 } : {}) }, roleA); expect(response.status).toBe(200); current = await response.json() as ParkSnapshot;
    }
    const finished = current.visits.find(row => row.visitId === input.visitId)!; expect(finished).toMatchObject({ road: "东入口", distanceKm: 0, energyKwh: 0 }); expect(finished.departedAt).toBeDefined();
    expect((await send(path, "PUT", { visit: { ...finished, vehicleId: "沪A23456" }, baseVersion: current.version }, roleA)).status).toBe(422);
    const history = { visitId: "历史车次", vehicleId: "沪A34567", carrierId: "carrier-a", road: "北入口", arrivedAt: Date.now() - 86400000, departedAt: Date.now() - 82800000 };
    const imported = await send("/api/carrier/visits/import", "POST", { visits: [history], baseVersion: current.version }, roleA); expect(imported.status).toBe(201); current = await imported.json() as ParkSnapshot;
    expect(current.visits).toHaveLength(3); expect(current.visits.find(row => row.visitId === input.visitId)).toEqual(finished);
    expect((await send("/api/carrier/visits/import", "POST", { visits: [history], baseVersion: current.version }, roleA)).status).toBe(422);
    const correction = await send("/api/carrier/visits/" + encodeURIComponent(history.visitId), "PUT", { visit: { ...history, road: "南入口" }, baseVersion: current.version }, roleA); expect(correction.status).toBe(200);
    expect((await correction.json() as ParkSnapshot).visits.find(row => row.visitId === history.visitId)?.road).toBe("南入口");
    expect((await (await send("/api/carrier/visits", "GET", undefined, roleB)).json() as ParkSnapshot).visits).toHaveLength(0);
    const queuePath = "/api/carrier/visits/queue", queuedInput = { visitId: randomUUID(), vehicleId: "沪A12345", road: "西入口" };
    expect((await send(queuePath, "POST", queuedInput)).status).toBe(403);
    for (const invalid of [{ ...queuedInput, enteredAt: Date.now() }, { ...queuedInput, arrivedAt: Date.now() + 60000 }, { ...queuedInput, vehicleId: "沪B12345" }, { ...queuedInput, road: "第五入口" }])
      expect((await send(queuePath, "POST", invalid, roleA)).status).toBeGreaterThanOrEqual(400);
    const queueStarted = Date.now(), queuedResponse = await send(queuePath, "POST", queuedInput, roleA);
    expect(queuedResponse.status).toBe(201);
    const queuedSnapshot = await queuedResponse.json() as ParkSnapshot, queued = queuedSnapshot.visits.find(row => row.visitId === queuedInput.visitId)!;
    expect(queued.arrivedAt).toBeGreaterThanOrEqual(queueStarted); expect(queued.enteredAt).toBeUndefined();
    expect(live.app.fleet.overview().vehicles.find(row => row.vehicleId === queued.vehicleId)?.status).toBe("queued");
    const repeatedQueue = await (await send(queuePath, "POST", queuedInput, roleA)).json() as ParkSnapshot;
    expect(repeatedQueue.version).toBe(queuedSnapshot.version); expect(repeatedQueue.visits).toEqual(queuedSnapshot.visits);
    expect((await send(queuePath, "POST", { ...queuedInput, visitId: randomUUID() }, roleA)).status).toBe(409);
    expect((await send(admissions, "POST", { ...queuedInput, visitId: randomUUID() }, roleA)).status).toBe(409);
    const queuedLifecycle = "/api/carrier/visits/" + queued.visitId + "/lifecycle";
    expect((await send(queuedLifecycle, "POST", { field: "serviceStartedAt", baseVersion: queuedSnapshot.version }, roleA)).status).toBe(422);
    expect((await send(queuedLifecycle, "POST", { field: "enteredAt", baseVersion: queuedSnapshot.version }, roleB)).status).toBe(404);
    const enterFromQueue = await send(queuedLifecycle, "POST", { field: "enteredAt", baseVersion: queuedSnapshot.version }, roleA);
    expect(enterFromQueue.status).toBe(200);
    const enteredSnapshot = await enterFromQueue.json() as ParkSnapshot, entered = enteredSnapshot.visits.find(row => row.visitId === queued.visitId)!;
    expect(typeof entered.enteredAt).toBe("number"); expect(entered.enteredAt).toBeGreaterThanOrEqual(queued.arrivedAt);
    expect(entered.arrivedAt).toBe(queued.arrivedAt); expect(entered.road).toBe(queued.road); expect(entered.visitId).toBe(queued.visitId);
    expect(live.app.fleet.overview().vehicles.find(row => row.vehicleId === queued.vehicleId)?.status).toBe("in_park");
    const lateQueueRetry = await (await send(queuePath, "POST", queuedInput, roleA)).json() as ParkSnapshot;
    expect(lateQueueRetry.version).toBe(enteredSnapshot.version); expect(lateQueueRetry.visits).toEqual(enteredSnapshot.visits);
  } finally {
    await live.close(); const target = resolve(root), expected = resolve(tmpdir(), "vectra-visit-operations-"); if (!target.startsWith(expected)) throw new Error("Unexpected test path"); rmSync(target, { recursive: true, force: true });
  }
});
