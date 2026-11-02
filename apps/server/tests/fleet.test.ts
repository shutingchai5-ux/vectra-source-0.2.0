import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { defaultParkSettings, REGISTERED_IDENTITIES, type ParkVehicle, type ParkVisit } from "@vectra/shared";
import { FleetData } from "../src/fleet";
import { ParkData } from "../src/park";
import { atomicWrite, canonical, seal, Security } from "../src/security";
import { readParkVisits } from "../src/park";
import { startServer } from "../src/index";
import { config } from "../src/config";

function cleanup(root: string, prefix: string) { if (!resolve(root).startsWith(resolve(tmpdir(), prefix))) throw new Error("Unexpected test path"); rmSync(root, { recursive: true, force: true }); }
const at = Date.parse("2026-10-23T00:00:00+08:00"), hour = 3600000;
const trips = (): ParkVisit[] => [
  { visitId: "a-old", carrierId: "carrier-a", vehicleId: "沪A12345", road: "东入口", arrivedAt: at + 7 * hour, departedAt: at + 8 * hour },
  { visitId: "a-latest", carrierId: "carrier-a", vehicleId: "沪A12345", road: "西入口", arrivedAt: at + 9 * hour, gateStartedAt: at + 9.25 * hour },
  { visitId: "b-inside", carrierId: "carrier-b", vehicleId: "沪B12345", road: "东入口", arrivedAt: at + 8 * hour, enteredAt: at + 8.1 * hour, serviceStartedAt: at + 8.5 * hour },
  { visitId: "c-outside", carrierId: "carrier-c", vehicleId: "沪C12345", road: "东入口", arrivedAt: at + 7 * hour, departedAt: at + 7.5 * hour },
];
const vehicle = (vehicleId: string, carrierId: ParkVehicle["carrierId"]): ParkVehicle => ({ vehicleId, carrierId, allowedRoads: ["东入口", "西入口"], plateNumber: vehicleId, energyType: "electric", capacityTonnes: 0 });

test("unique plates replace legacy references without changing events or frozen snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-fleet-plates-"));
  try {
    const security = await Security.open(join(root, "pki")), park = new ParkData(security), fleet = new FleetData(security, park);
    const original = trips().filter(v => v.carrierId === "carrier-a"), published = park.import(original, park.catalog().version), legacy = original.map(v => ({ ...v, vehicleId: "old-truck" }));
    const key = readFileSync(join(security.root, "carrier-a", "input.key"));
    atomicWrite(join(security.root, "park", published.version, "carrier-a.enc.json"), canonical(seal(legacy, key, "park:" + published.version + ":carrier-a")));
    const saved = fleet.save("carrier-a", [{ sourceVehicleId: "old-truck", carrierId: "carrier-a", plateNumber: " 沪ａ·１２３４５ ", allowedRoads: ["东入口"] }], fleet.catalog().version);
    expect(saved.vehicles).toHaveLength(1); expect(saved.vehicles[0]).toMatchObject({ vehicleId: "沪A12345", plateNumber: "沪A12345", profiled: true });
    expect(park.snapshot().visits).toEqual(original); expect(park.catalog().vehicleCount).toBe(1); expect(readParkVisits(security, published.version, "carrier-a")).toEqual(legacy);
    const version = park.catalog().version; expect(new FleetData(security, new ParkData(security)).overview().vehicles).toHaveLength(1); expect(park.catalog().version).toBe(version);
    expect(() => fleet.save("carrier-a", [vehicle("沪A12345", "carrier-a"), { ...vehicle("沪A12345", "carrier-a"), plateNumber: "沪a·12345" }], saved.version)).toThrow(/重复/);
    expect(() => fleet.save("carrier-b", [{ plateNumber: "沪a·12345", carrierId: "carrier-b", allowedRoads: ["东入口"] }], saved.version)).toThrow(/另一家/);
    expect(() => fleet.save("carrier-a", [{ ...vehicle("沪A12345", "carrier-a"), vehicleId: "another-id" }], saved.version)).toThrow(/无需另填/);
    expect(() => fleet.save("carrier-a", [{ plateNumber: "沪A12I45", carrierId: "carrier-a", allowedRoads: ["东入口"] }], saved.version)).toThrow(/I、O/);
  } finally { cleanup(root, "vectra-fleet-plates-"); }
});

test("fleet profiles keep owner partitions, multiple roads and separate latest visit state", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-fleet-domain-"));
  try {
    const security = await Security.open(join(root, "pki")), park = new ParkData(security), fleet = new FleetData(security, park);
    park.import(trips(), park.catalog().version);
    const inferred = fleet.overview(); expect(inferred.vehicles.map(v => v.status)).toEqual(["queued", "working", "departed"]);
    expect(inferred.vehicles.every(v => !v.profiled && !v.allowedRoads.length)).toBeTrue(); expect(inferred.vehicles[0].lastVisit?.visitId).toBe("a-latest");
    const a = fleet.save("carrier-a", [vehicle("沪A12345", "carrier-a"), { vehicleId: "沪A23456", plateNumber: "沪A23456", carrierId: "carrier-a" }], inferred.version);
    expect(a.vehicles.find(v => v.vehicleId === "沪A23456")).toMatchObject({ status: "no_visit", allowedRoads: [] }); expect(a.vehicles.find(v => v.vehicleId === "沪A12345")).toMatchObject({ profiled: true, allowedRoads: ["东入口", "西入口"], capacityTonnes: 0 });
    expect(() => fleet.save("carrier-b", [], inferred.version)).toThrow(/更新/);
    const b = fleet.save("carrier-b", [{ ...vehicle("沪B12345", "carrier-b"), plateNumber: "沪B12345" }], a.version); expect(b.vehicles.filter(v => v.profiled)).toHaveLength(3);
    expect(() => fleet.save("carrier-b", [vehicle("沪A12345", "carrier-b")], b.version)).toThrow(/另一家/);
    for (const bad of [{ ...vehicle("沪C23456", "carrier-c"), allowedRoads: ["未配置入口"] }, { ...vehicle("沪C23456", "carrier-c"), capacityTonnes: -1 }]) expect(() => fleet.save("carrier-c", [bad], b.version)).toThrow();
    expect(() => fleet.assertVisitOwners([{ vehicleId: "沪A12345", carrierId: "carrier-b" }])).toThrow(/归属/);
    const text = readFileSync(join(root, "pki", "fleet", b.version, "carrier-a.enc.json"), "utf8"); expect(text).not.toContain("沪A12345"); expect(text).not.toContain("沪A12345");
    const removed = fleet.save("carrier-a", [], b.version); expect(removed.vehicles.find(v => v.vehicleId === "沪A12345")?.profiled).toBeFalse(); expect(removed.vehicles.find(v => v.vehicleId === "沪B12345")?.profiled).toBeTrue();
    for (const [fields, status] of [
      [{ enteredAt: at + 8.1 * hour }, "in_park"],
      [{ enteredAt: at + 8.1 * hour, serviceStartedAt: at + 8.5 * hour }, "working"],
      [{ enteredAt: at + 8.1 * hour, serviceStartedAt: at + 8.5 * hour, serviceEndedAt: at + 9 * hour }, "work_completed"],
      [{ enteredAt: at + 8.1 * hour, serviceStartedAt: at + 8.5 * hour, serviceEndedAt: at + 9 * hour, departedAt: at + 10 * hour }, "departed"],
    ] as const) {
      park.import([{ visitId: "same-lifecycle", carrierId: "carrier-b", vehicleId: "沪B12345", road: "东入口", arrivedAt: at + 8.1 * hour, ...fields }], park.catalog().version);
      expect(fleet.overview().vehicles.find(v => v.vehicleId === "沪B12345")).toMatchObject({ status, lastVisit: { visitId: "same-lifecycle", road: "东入口" } });
    }
  } finally { cleanup(root, "vectra-fleet-domain-"); }
});

test("registry upgrades business roles and model capability while retaining all keys and old signatures", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-identity-profile-"));
  try {
    const security = await Security.open(root), original = security.nodes(), signed = security.sign("report", { previous: "signed before metadata migration" });
    const keys = REGISTERED_IDENTITIES.map(id => readFileSync(join(root, id, "signing.key")));
    const legacy = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
    for (const node of Object.values(legacy.nodes) as any[]) { node.role = node.id.startsWith("carrier-") ? "vehicle" : node.id; for (const field of ["displayName", "displayCode", "usesLlm", "level", "duties"]) delete node[field]; }
    atomicWrite(join(root, "registry.json"), canonical(legacy));
    const reopened = await Security.open(root), settings = defaultParkSettings(); settings.carriers[0].name = "联合运输";
    const nodes = reopened.configureIdentities(settings); expect(nodes).toHaveLength(8);
    expect(nodes.filter(n => n.usesLlm).map(n => n.id)).toEqual(["coordinator", "planner", "analyst"]);
    for (const [i, id] of REGISTERED_IDENTITIES.entries()) {
      const node = nodes.find(n => n.id === id)!; expect(node.displayName?.endsWith("Agent")).toBe(node.usesLlm); expect(node.fingerprint).toBe(original[i].fingerprint); expect(node.signingPublicKey).toBe(original[i].signingPublicKey); expect(readFileSync(join(root, id, "signing.key")).equals(keys[i])).toBeTrue();
    }
    expect(nodes.find(n => n.id === "carrier-a")).toMatchObject({ displayName: "联合运输协作节点", displayCode: "carrier-a", level: 2, usesLlm: false });
    expect(reopened.verify(signed, "report")).toEqual(signed.payload);
    expect(JSON.parse(readFileSync(join(root, "registry.json"), "utf8")).nodes["carrier-a"].role).toBe("承运商数据与隐私计算");
  } finally { cleanup(root, "vectra-identity-profile-"); }
});

test("vehicle APIs enforce session, origin, version and carrier ownership; names agree with registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-fleet-api-")), live = await startServer({ ...config(), dataDir: root, logDir: join(root, "logs"), port: 0, cooldown: 0 });
  const base = `http://127.0.0.1:${live.server.port}`;
  try {
    expect((await fetch(base + "/api/fleet")).status).toBe(401);
    const cookie = (await fetch(base + "/api/session")).headers.get("set-cookie")!.split(";")[0];
    let carrierToken = "";
    const send = (path: string, method = "GET", body?: unknown, extra = {}) => fetch(base + path, { method, headers: { Cookie: cookie, "Content-Type": "application/json", "X-Carrier-Role": carrierToken, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect((await send("/api/fleet", "GET", undefined, { Origin: "https://attacker.invalid" })).status).toBe(403);
    carrierToken = (await (await send("/api/carrier-role", "POST", { carrierId: "carrier-a" })).json()).token;
    let overview = await (await send("/api/fleet")).json(); const saved = await send("/api/fleet", "POST", { carrierId: "carrier-a", vehicles: [vehicle("沪A12345", "carrier-a")], baseVersion: overview.version }); expect(saved.status).toBe(201); overview = await saved.json();
    const updated = await send("/api/fleet", "POST", { carrierId: "carrier-a", vehicles: [{ carrierId: "carrier-a", plateNumber: "沪A12345", capacityTonnes: 8 }, { carrierId: "carrier-a", plateNumber: "沪A23456", capacityTonnes: 0 }], baseVersion: overview.version });
    expect(updated.status).toBe(201); overview = await updated.json();
    expect(overview.vehicles.find((item: any) => item.vehicleId === "沪A12345")).toMatchObject({ capacityTonnes: 8, allowedRoads: ["东入口", "西入口"] });
    expect(overview.vehicles.find((item: any) => item.vehicleId === "沪A23456")).toMatchObject({ capacityTonnes: 0, allowedRoads: [], status: "no_visit" });
    expect(live.app.park.snapshot().visits).toHaveLength(0);
    expect((await send("/api/fleet", "POST", { carrierId: "carrier-b", vehicles: [], baseVersion: "stale" })).status).toBe(403);
    const catalog = await (await send("/api/park")).json();
    expect((await send("/api/park", "POST", { visits: [{ ...trips()[0], carrierId: "carrier-b" }], baseVersion: catalog.version })).status).toBe(403);
    const settings = defaultParkSettings(); settings.carriers[0].name = "运输一部"; settings.entranceRoads = ["东入口", "南入口", "西入口", "北入口"];
    expect((await send("/api/park/settings", "PUT", { settings, baseVersion: catalog.version })).status).toBe(201);
    const nodes = await (await send("/api/identities")).json(); expect(nodes.find((n: any) => n.displayCode === "carrier-a").displayName).toBe("运输一部协作节点"); expect(nodes.filter((n: any) => n.displayName.endsWith("Agent"))).toHaveLength(3);
    const events = live.app.audit.list(100); expect(events.some(e => e.kind === "carrier_vehicles_saved")).toBeTrue(); expect(JSON.stringify(events)).not.toContain("沪A12345");
  } finally { await live.close(); cleanup(root, "vectra-fleet-api-"); }
});
