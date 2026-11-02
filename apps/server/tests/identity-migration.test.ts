import "reflect-metadata";
import { test, expect } from "bun:test";
import { createPrivateKey, sign, X509Certificate, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import * as x509 from "@peculiar/x509";
import { CARRIER_BINDINGS, PARTICIPANTS, REGISTERED_IDENTITIES, defaultParkSettings } from "@vectra/shared";
import { Audit } from "../src/audit";
import { FleetData } from "../src/fleet";
import { migrateCarrierIdentities, requireCurrentIdentities } from "../src/identity-migration";
import { runtimeLock } from "../src/lock";
import { ModelSettings } from "../src/model";
import { ParkData, readParkVisits } from "../src/park";
import { atomicWrite, canonical, seal, Security, unseal } from "../src/security";
import { Store } from "../src/store";
import { Telemetry } from "../src/telemetry";

const previous = ["vehicle-a", "vehicle-b", "vehicle-c"];
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function cleanup(root: string) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes("vectra-identity-migration-")) throw new Error("Unexpected test path");
  rmSync(root, { recursive: true, force: true });
}
function move(root: string, source: string, target: string) {
  for (const path of [source, target]) if (relative(root, path).startsWith("..") || !relative(root, path)) throw new Error("Unexpected fixture path");
  renameSync(source, target);
}
function oldCatalog(value: any) {
  const result = structuredClone(value), oldId = (id: string) => previous[PARTICIPANTS.indexOf(id as any)] ?? id;
  if (result.nodes) result.nodes = result.nodes.map((node: any) => ({ ...node, id: oldId(node.id) }));
  if (result.settings) result.settings.carriers = result.settings.carriers.map((c: any) => ({ ...c, participant: oldId(c.participant) }));
  return result;
}

// Genuine retired certificates and authenticated files exercise the migration boundary.
async function legacyFixture(root: string) {
  const pki = join(root, "pki"), security = await Security.open(pki), park = new ParkData(security), fleet = new FleetData(security, park), telemetry = new Telemetry(security);
  const now = Date.now(), settings = defaultParkSettings(); settings.name = "迁移保留园区"; settings.carriers[0].name = "联合承运";
  park.configure(settings, park.catalog().version);
  const catalog = park.import([{ visitId: "real-visit-001", carrierId: "carrier-a", vehicleId: "沪A12345", road: "东入口", arrivedAt: now - 5 * 3600000, enteredAt: now - 4 * 3600000, departedAt: now - 3 * 3600000 }], park.catalog().version);
  fleet.save("carrier-a", [{ vehicleId: "沪A12345", carrierId: "carrier-a", plateNumber: "沪A12345", allowedRoads: ["东入口", "西入口"], capacityTonnes: 0 }], fleet.catalog().version);
  telemetry.import(PARTICIPANTS.map((participant, i) => ({ participant, vehicleId: "actual-truck-" + i, road: "S101", recordedAt: now - 60000, speed: 30 + i })));
  new ModelSettings(root, security).save({ provider: "custom", baseUrl: "https://example.invalid/v1", model: "migration-model", apiKey: "migration-secret-key" });
  const registry = json(join(pki, "registry.json")), oldReport = security.sign("report", { participants: previous, explanation: "retired report" });
  const ca = new X509Certificate(readFileSync(join(pki, "ca.crt"))), algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const signingKey = await crypto.subtle.importKey("pkcs8", new Uint8Array(createPrivateKey(readFileSync(join(pki, "ca.key"))).export({ format: "der", type: "pkcs8" })), algorithm, true, ["sign"]);
  for (const [i, carrier] of CARRIER_BINDINGS.entries()) {
    const id = previous[i], folder = join(pki, id), before = registry.nodes[carrier.id];
    move(root, join(pki, carrier.id), folder);
    const publicKey = await crypto.subtle.importKey("spki", new Uint8Array(new X509Certificate(readFileSync(join(folder, "tls.crt"))).publicKey.export({ format: "der", type: "spki" })), algorithm, true, ["verify"]);
    const cert = await x509.X509CertificateGenerator.create({ subject: "CN=" + id, issuer: ca.subject, publicKey, signingKey, signingAlgorithm: algorithm, notBefore: new Date(now - 60000), notAfter: new Date(now + 86400000), extensions: [new x509.BasicConstraintsExtension(false, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true), new x509.SubjectAlternativeNameExtension([{ type: "dns", value: id }, { type: "url", value: "urn:vectra:" + id }])] });
    atomicWrite(join(folder, "tls.crt"), cert.toString("pem"));
    registry.nodes[id] = { ...before, id, fingerprint: new X509Certificate(cert.toString("pem")).fingerprint256 }; delete registry.nodes[carrier.id];
  }
  atomicWrite(join(pki, "registry.json"), canonical(registry));
  for (const kind of ["park", "telemetry"]) {
    const source = join(pki, kind);
    for (const version of readdirSync(source, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
      for (const [i, carrier] of CARRIER_BINDINGS.entries()) {
        const key = readFileSync(join(pki, previous[i], "input.key")), path = join(source, version, carrier.id + ".enc.json");
        const rows = unseal(json(path), key, kind + ":" + version + ":" + carrier.id) as any[];
        const records = kind === "telemetry" ? rows.map(row => ({ ...row, participant: previous[i] })) : rows;
        atomicWrite(join(source, version, previous[i] + ".enc.json"), canonical(seal(records, key, kind + ":" + version + ":" + previous[i]))); rmSync(path);
      }
      atomicWrite(join(source, version, "catalog.json"), canonical(oldCatalog(json(join(source, version, "catalog.json")))));
    }
    atomicWrite(join(source, "catalog.json"), canonical(oldCatalog(json(join(source, "catalog.json")))));
  }
  const payload = { participants: previous, taskId: "old-task-output" }, oldOutput = { signer: previous[0], payload, signature: sign(null, Buffer.from(canonical(payload)), createPrivateKey(readFileSync(join(pki, previous[0], "signing.key")))).toString("base64url") };
  const store = new Store(root), task = store.create({ request: "保留前的旧任务", requestId: randomUUID(), intent: "explain" }, "llm").task;
  store.step(task.id, { agent: previous[0], kind: "security", action: "旧签名", detail: "旧协议材料", hasPrivateDetails: true, protocolDetails: { objective: "旧证据", operations: [], sections: [{ title: "旧签名", data: oldOutput }] } }, seal({ certificate: readFileSync(join(pki, previous[0], "tls.crt"), "utf8") }, security.storageKey(), "protocol:" + task.id + ":old"));
  store.update(task.id, { status: "completed", summary: "旧任务已完成" }, "task.completed", seal(oldReport, security.storageKey(), "report:" + task.id));
  new Audit(store, security).append("request_accepted", { participants: previous }, previous[0], previous[0]); store.close();
  const logDir = join(root, "logs"); for (const channel of ["conversations", "operations"]) { mkdirSync(join(logDir, channel), { recursive: true }); writeFileSync(join(logDir, channel, "2026-10-30.jsonl"), JSON.stringify(oldOutput) + "\n"); }
  writeFileSync(join(logDir, "README.md"), "keep documentation"); mkdirSync(join(root, "mpc-runs", "old-run"), { recursive: true }); writeFileSync(join(root, "mpc-runs", "old-run", "task.json"), JSON.stringify(oldOutput));
  return { pki, logDir, version: catalog.version, oldOutput, oldReport, oldCa: ca.fingerprint256 };
}

test("explicit migration reissues carrier certificates and keys, preserves business/config and removes retired evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-identity-migration-success-"));
  try {
    const before = await legacyFixture(root); expect(() => requireCurrentIdentities(root)).toThrow(/migrate:identities/);
    const result = await migrateCarrierIdentities({ dataDir: root, logDir: before.logDir });
    expect(result?.cleared).toMatchObject({ conversations: 1, tasks: 1, reports: 1, audit: 1 }); expect(result?.retained).toMatchObject({ parkVehicles: 1, parkVisits: 1, vehicleProfiles: 1, telemetryRecords: 3, modelConfigured: true });
    const security = await Security.open(before.pki); expect(security.nodes().map(n => n.id)).toEqual([...REGISTERED_IDENTITIES]); expect(new X509Certificate(security.ca()).fingerprint256).not.toBe(before.oldCa);
    for (const carrier of CARRIER_BINDINGS) { const cert = new X509Certificate(security.tls(carrier.id).cert); expect(cert.subject).toBe("CN=" + carrier.id); expect(cert.checkHost(carrier.id)).toBe(carrier.id); expect(cert.subjectAltName).toContain("urn:vectra:" + carrier.id); }
    for (const id of previous) expect(existsSync(join(before.pki, id))).toBeFalse();
    expect(() => security.verify(before.oldOutput)).toThrow(); expect(() => security.verify(before.oldReport, "report")).toThrow();
    const park = new ParkData(security); expect(park.catalog().version).toBe(before.version); expect(park.catalog().settings.name).toBe("迁移保留园区"); expect(park.catalog().settings.carriers[0].participant).toBe("carrier-a"); expect(readParkVisits(security, before.version, "carrier-a")[0].vehicleId).toBe("沪A12345");
    expect(new FleetData(security, park).profiles()[0]).toMatchObject({ plateNumber: "沪A12345", capacityTonnes: 0, allowedRoads: ["东入口", "西入口"] }); expect(new Telemetry(security).snapshot().records.every(row => PARTICIPANTS.some(id => id === row.participant))).toBeTrue();
    expect(new ModelSettings(root, security).snapshot()).toMatchObject({ model: "migration-model", apiKey: "migration-secret-key" });
    expect(existsSync(join(root, ".carrier-identity-migration"))).toBeFalse(); expect(existsSync(join(root, "mpc-runs"))).toBeFalse(); expect(readFileSync(join(before.logDir, "README.md"), "utf8")).toBe("keep documentation");
    for (const channel of ["conversations", "operations"]) expect(readdirSync(join(before.logDir, channel))).toEqual([]);
    const store = new Store(root); try { for (const table of ["tasks", "conversations", "steps", "protocol_materials", "reports", "events"]) expect((store.db.query("SELECT COUNT(*) n FROM " + table).get() as any).n).toBe(0); const audit = new Audit(store, security); expect(audit.list()[0].kind).toBe("identity_generation_started"); expect(audit.verify().valid).toBeTrue(); } finally { store.close(); }
    const signed = security.sign("carrier-a", { participants: PARTICIPANTS }); expect(security.verify(signed, "carrier-a").participants).toEqual(PARTICIPANTS); expect(() => requireCurrentIdentities(root)).not.toThrow();
    expect(await migrateCarrierIdentities({ dataDir: root, logDir: before.logDir })).toBeUndefined(); expect((await Security.open(before.pki)).nodes()).toEqual(security.nodes());
  } finally { cleanup(root); }
});

test("migration refuses a live directory and leaves originals intact when authenticated preparation fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-identity-migration-failure-"));
  try {
    const before = await legacyFixture(root), unlock = runtimeLock(root);
    try { await expect(migrateCarrierIdentities({ dataDir: root, logDir: before.logDir })).rejects.toMatchObject({ code: "runtime_locked" }); } finally { unlock(); }
    const path = join(before.pki, "park", before.version, "vehicle-a.enc.json"), damaged = json(path); damaged.tag = "AAAAAAAAAAAAAAAAAAAAAA"; atomicWrite(path, canonical(damaged));
    await expect(migrateCarrierIdentities({ dataDir: root, logDir: before.logDir })).rejects.toMatchObject({ code: "ciphertext_invalid" });
    expect(new X509Certificate(readFileSync(join(before.pki, "ca.crt"))).fingerprint256).toBe(before.oldCa); expect(json(join(before.pki, "registry.json")).nodes["vehicle-a"].id).toBe("vehicle-a"); expect(existsSync(join(root, ".carrier-identity-migration"))).toBeFalse();
    const store = new Store(root); try { expect(store.conversations()).toHaveLength(1); expect((store.db.query("SELECT COUNT(*) n FROM reports").get() as any).n).toBe(1); expect((store.db.query("SELECT COUNT(*) n FROM audit").get() as any).n).toBe(1); } finally { store.close(); }
    expect(existsSync(join(before.logDir, "conversations", "2026-10-30.jsonl"))).toBeTrue();
  } finally { cleanup(root); }
});
