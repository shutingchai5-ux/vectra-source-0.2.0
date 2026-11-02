import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../src/index";
import { config } from "../src/config";
import { readParkVisits } from "../src/park";
import type { ParkVisit } from "@vectra/shared";

test("selected carrier scope prevents cross-owner writes and preserves other carriers through concurrent saves", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-carrier-role-")), options = { ...config(), dataDir: root, logDir: join(root, "logs"), port: 0, cooldown: 0 };
  let live = await startServer(options);
  try {
    let base = "http://127.0.0.1:" + live.server.port;
    const cookie = (await fetch(base + "/api/session")).headers.get("set-cookie")!.split(";")[0];
    const send = (path: string, method = "GET", value?: unknown, token?: string, extra = {}) => fetch(base + path, { method, headers: { Cookie: cookie, "Content-Type": "application/json", ...(token ? { "X-Carrier-Role": token } : {}), ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const role = async (carrierId: string, previousToken?: string) => (await send("/api/carrier-role", "POST", { carrierId, ...(previousToken ? { previousToken } : {}) })).json();
    const now = Date.now(), a: ParkVisit = { visitId: "visit-a", carrierId: "carrier-a", vehicleId: "沪A12345", road: "东入口", arrivedAt: now - 3600000 }, b: ParkVisit = { ...a, visitId: "visit-b", carrierId: "carrier-b", vehicleId: "沪B12345" };
    const frozen = live.app.park.import([a, b], live.app.park.catalog().version);
    const ra = await role("carrier-a"), rb = await role("carrier-b");
    const readA = await (await send("/api/carrier/visits", "GET", undefined, ra.token)).json(), readB = await (await send("/api/carrier/visits", "GET", undefined, rb.token)).json();
    expect(readA.visits).toEqual([a]); expect(readA.catalog.vehicleCount).toBe(1); expect(readA.catalog.nodes.map((node: any) => node.id)).toEqual(["carrier-a"]);
    expect(readB.visits).toEqual([b]); expect((await send("/api/carrier/fleet")).status).toBe(403);
    expect((await send("/api/carrier/fleet", "GET", undefined, "carrier-b")).status).toBe(403);
    expect((await send("/api/carrier/fleet", "GET", undefined, ra.token, { Origin: "https://other.invalid" })).status).toBe(403);
    const fleetA = await (await send("/api/carrier/fleet", "GET", undefined, ra.token)).json(), fleetB = await (await send("/api/carrier/fleet", "GET", undefined, rb.token)).json();
    expect(fleetA.vehicles.every((vehicle: any) => vehicle.carrierId === "carrier-a")).toBeTrue();
    const va = { carrierId: "carrier-a", plateNumber: "沪A12345", allowedRoads: ["东入口"], capacityTonnes: 0 }, vb = { carrierId: "carrier-b", plateNumber: "沪B12345", allowedRoads: ["西入口"] };
    expect((await send("/api/fleet", "POST", { carrierId: "carrier-b", vehicles: [vb], baseVersion: fleetA.version }, ra.token)).status).toBe(403);
    expect((await send("/api/fleet", "POST", { carrierId: "carrier-a", vehicles: [vb], baseVersion: fleetA.version }, ra.token)).status).toBe(422);
    expect((await send("/api/fleet", "POST", { carrierId: "carrier-a", vehicles: [va], baseVersion: fleetA.version })).status).toBe(403);
    expect((await send("/api/fleet", "POST", { carrierId: "carrier-a", vehicles: [va], baseVersion: fleetA.version }, ra.token)).status).toBe(201);
    // A changed, but B's own profile scope did not: merging B's older snapshot is safe.
    expect((await send("/api/fleet", "POST", { carrierId: "carrier-b", vehicles: [vb], baseVersion: fleetB.version }, rb.token)).status).toBe(201);
    expect(live.app.fleet.profiles()).toHaveLength(2);
    expect((await send("/api/fleet", "POST", { carrierId: "carrier-a", vehicles: [], baseVersion: fleetA.version }, ra.token)).status).toBe(409);
    expect((await send("/api/carrier/visits", "POST", { visits: [b], baseVersion: readA.version }, ra.token)).status).toBe(403);
    expect((await send("/api/park", "POST", { visits: [b], baseVersion: readA.version }, ra.token)).status).toBe(403);
    const extraA = { ...a, visitId: "visit-a-next", arrivedAt: now - 1800000 };
    expect((await send("/api/carrier/visits", "POST", { visits: [a, extraA], baseVersion: readA.version }, ra.token)).status).toBe(201);
    expect((await send("/api/carrier/visits", "POST", { visits: [], baseVersion: readB.version }, rb.token)).status).toBe(201);
    expect(live.app.park.snapshot().visits).toEqual([a, extraA]);
    expect(readParkVisits(live.app.security, frozen.version, "carrier-b")).toEqual([b]);
    expect((await send("/api/carrier/visits", "POST", { visits: [], baseVersion: readA.version }, ra.token)).status).toBe(409);
    const rc = await role("carrier-c", ra.token); expect((await send("/api/carrier/fleet", "GET", undefined, ra.token)).status).toBe(403);
    const record = { vehicleId: "legacy-truck-c", road: "S101", recordedAt: now - 1000, speed: 40 };
    expect((await send("/api/telemetry", "POST", [{ ...record, participant: "carrier-b" }], rc.token)).status).toBe(403);
    expect((await send("/api/telemetry", "POST", [record], rc.token)).status).toBe(201);
    expect(live.app.telemetry.snapshot().records[0].participant).toBe("carrier-c");
    expect((await send("/api/telemetry", "POST", [{ ...record, vehicleId: "legacy-truck-b" }], rb.token)).status).toBe(201);
    expect(live.app.telemetry.snapshot().records).toHaveLength(2);
    await live.close(); live = await startServer(options); base = "http://127.0.0.1:" + live.server.port;
    expect((await send("/api/carrier/fleet", "GET", undefined, rb.token)).status).toBe(200);
    live.app.store.db.query("UPDATE carrier_role_sessions SET expires_at=0 WHERE carrier_id=?").run("carrier-b");
    expect((await send("/api/carrier/fleet", "GET", undefined, rb.token)).status).toBe(403);
  } finally { await live.close(); if (!resolve(root).startsWith(resolve(tmpdir(), "vectra-carrier-role-"))) throw new Error("Unexpected test path"); rmSync(root, { recursive: true, force: true }); }
});
