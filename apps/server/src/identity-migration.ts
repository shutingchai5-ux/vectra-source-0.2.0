import { Database } from "bun:sqlite";
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CARRIER_BINDINGS, error, type PublicNode } from "@vectra/shared";
import { Audit } from "./audit";
import type { Config } from "./config";
import { FleetData } from "./fleet";
import { runtimeLock } from "./lock";
import { ModelSettings } from "./model";
import { ParkData } from "./park";
import { atomicWrite, canonical, seal, Security, unseal } from "./security";
import { Store } from "./store";
import { Telemetry } from "./telemetry";

// These retired names are accepted only by the explicit, one-time migration command.
const retiredParticipants = ["vehicle-a", "vehicle-b", "vehicle-c"] as const;
const workspaceName = ".carrier-identity-migration";
interface Counts { conversations: number; tasks: number; reports: number; audit: number; events: number }
interface Retained { parkVehicles: number; parkVisits: number; vehicleProfiles: number; telemetryRecords: number; snapshotVersions: number; modelConfigured: boolean }
export interface IdentityMigrationReceipt { schemaVersion: 1; scheme: "carrier-v1"; completedAt: number; cleared: Counts; retained: Retained }
interface Prepared { schemaVersion: 1; phase: "prepared"; logDir: string; cleared: Counts; retained: Retained }
const invalid = (message: string): never => { throw error("identity_migration_invalid", message, 409); };
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function realPath(path: string) {
  const absolute = resolve(path);
  for (let current = absolute; ; ) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return invalid("迁移目录不能包含符号链接或目录联接。");
    const parent = resolve(current, ".."); if (parent === current) break; current = parent;
  }
  return absolute;
}
function child(root: string, path: string) {
  const target = realPath(path), part = relative(realPath(root), target);
  if (!part || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) return invalid("迁移目标超出指定目录。");
  return target;
}
function remove(root: string, path: string, recursive = false) { rmSync(child(root, path), { recursive, force: true }); }
function move(root: string, source: string, target: string) { renameSync(child(root, source), child(root, target)); }

export function requireCurrentIdentities(root: string) {
  const registry = join(root, "pki", "registry.json");
  if (existsSync(join(root, workspaceName)) || existsSync(registry) && retiredParticipants.some(id => json(registry).nodes?.[id])) {
    throw error("identity_migration_required", "计算身份需要迁移。请停止服务后运行 bun run migrate:identities；此操作保留业务数据与模型配置，清空旧对话、报告、协议材料、审计和对应诊断日志。", 409);
  }
}

function validateRetiredPki(root: string) {
  const registry = json(join(root, "registry.json")), ca = new X509Certificate(readFileSync(join(root, "ca.crt")));
  const expected = ["coordinator", "rsu", "report", ...retiredParticipants, ...["planner", "analyst"].filter(id => registry.nodes[id])];
  if (!ca.ca || !ca.verify(ca.publicKey) || ca.fingerprint256 !== registry.caFingerprint || Object.keys(registry.nodes).sort().join() !== [...expected].sort().join()) return invalid("旧登记表或本地证书机构无效，未清理任何历史数据。");
  for (const id of expected) {
    const node = registry.nodes[id] as PublicNode, folder = child(root, join(root, id)), cert = new X509Certificate(readFileSync(child(root, join(folder, "tls.crt"))));
    const publicKey = createPublicKey(createPrivateKey(readFileSync(child(root, join(folder, "signing.key"))))).export({ format: "pem", type: "spki" }).toString();
    if (node.id !== id || !cert.verify(ca.publicKey) || cert.fingerprint256 !== node.fingerprint || !cert.checkHost(id) || publicKey !== node.signingPublicKey || readFileSync(child(root, join(folder, "input.key"))).length !== 32) return invalid("旧身份、证书或数据密钥不一致，未清理任何历史数据。");
  }
  if (readFileSync(child(root, join(root, "storage.key"))).length !== 32) return invalid("旧存储密钥无效。");
}

function catalogWithCurrentIdentities(catalog: any) {
  const result = structuredClone(catalog);
  if (Array.isArray(result.nodes)) result.nodes = result.nodes.map((node: any) => ({ ...node, id: CARRIER_BINDINGS[retiredParticipants.indexOf(node.id)]?.id ?? node.id }));
  if (Array.isArray(result.settings?.carriers)) result.settings.carriers = result.settings.carriers.map((carrier: any) => ({ ...carrier, participant: CARRIER_BINDINGS.find(c => c.id === carrier.id)?.participant ?? carrier.participant }));
  return result;
}

function migrateSnapshots(oldPki: string, security: Security): number {
  let versions = 0;
  for (const kind of ["park", "telemetry", "fleet"] as const) {
    const source = join(oldPki, kind); if (!existsSync(source)) continue;
    child(oldPki, source); const target = join(security.root, kind); mkdirSync(target);
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const version = entry.name, folder = child(oldPki, join(source, version)), catalogFile = join(folder, "catalog.json");
      if (!existsSync(catalogFile)) continue; // Unpublished interrupted writes are not business snapshots.
      const output = join(target, version); mkdirSync(output); versions++;
      for (const [i, carrier] of CARRIER_BINDINGS.entries()) {
        const previous = retiredParticipants[i], oldId = kind === "fleet" ? carrier.id : previous, nextId = kind === "fleet" ? carrier.id : carrier.participant;
        const oldKey = readFileSync(child(oldPki, join(oldPki, previous, "input.key"))), newKey = readFileSync(join(security.root, carrier.participant, "input.key"));
        const original = unseal(json(child(oldPki, join(folder, `${oldId}.enc.json`))), oldKey, `${kind}:${version}:${oldId}`);
        if (!Array.isArray(original)) return invalid("业务快照内容不是记录数组，迁移未进入清理阶段。");
        const records = kind === "telemetry" ? original.map(row => {
          if (row.participant !== previous) return invalid("采样快照的所有权不一致。");
          return { ...row, participant: carrier.participant };
        }) : original;
        atomicWrite(join(output, `${nextId}.enc.json`), canonical(seal(records, newKey, `${kind}:${version}:${nextId}`)));
        if (kind === "fleet") {
          const aliasesFile = join(folder, carrier.id + ".identity-aliases.enc.json"), aad = "fleet-identities:" + version + ":" + carrier.id;
          if (existsSync(aliasesFile)) atomicWrite(join(output, carrier.id + ".identity-aliases.enc.json"), canonical(seal(unseal(json(child(oldPki, aliasesFile)), oldKey, aad), newKey, aad)));
        }
      }
      atomicWrite(join(output, "catalog.json"), canonical(catalogWithCurrentIdentities(json(child(oldPki, catalogFile)))));
    }
    if (existsSync(join(source, "catalog.json"))) atomicWrite(join(target, "catalog.json"), canonical(catalogWithCurrentIdentities(json(child(oldPki, join(source, "catalog.json"))))));
  }
  return versions;
}

function historyCounts(root: string): Counts {
  const result: Counts = { conversations: 0, tasks: 0, reports: 0, audit: 0, events: 0 }, path = join(root, "vectra.sqlite3");
  if (!existsSync(path)) return result;
  const db = new Database(child(root, path), { readonly: true });
  try { for (const table of Object.keys(result) as (keyof Counts)[]) result[table] = (db.query(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n; } finally { db.close(); }
  return result;
}

function clearHistory(root: string, logDir: string) {
  for (const name of ["vectra.sqlite3", "vectra.sqlite3-wal", "vectra.sqlite3-shm", "audit.checkpoint.json", "diagnostic-log-cursor.json", "server-control.json", "session.key"]) remove(root, join(root, name));
  for (const entry of readdirSync(root)) if (/^(?:audit\.checkpoint\.json|diagnostic-log-cursor\.json|server-control\.json|model-settings\.enc\.json)\..+\.tmp$/.test(entry)) remove(root, join(root, entry));
  remove(root, join(root, "mpc-runs"), true);
  for (const channel of ["conversations", "operations"]) {
    const folder = join(logDir, channel); if (!existsSync(folder)) continue;
    child(logDir, folder);
    for (const entry of readdirSync(folder, { withFileTypes: true })) if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) remove(logDir, join(folder, entry.name));
  }
}

/** Explicit destructive migration; both CLI and tests acquire the real application directory lock. */
export async function migrateCarrierIdentities(config: Pick<Config, "dataDir" | "logDir">): Promise<IdentityMigrationReceipt | undefined> {
  const root = realPath(config.dataDir), logDir = realPath(config.logDir), unlock = runtimeLock(root);
  try {
    const active = join(root, "pki"), workspace = join(root, workspaceName), staged = join(workspace, "pki"), retired = join(workspace, "retired-pki"), statePath = join(workspace, "state.json"), modelPath = join(root, "model-settings.enc.json");
    let state: Prepared;
    if (existsSync(statePath)) {
      state = json(child(root, statePath));
      if (state.schemaVersion !== 1 || state.phase !== "prepared" || state.logDir !== logDir) return invalid("迁移进度无效，或日志目录与准备时不同。");
    } else {
      if (existsSync(retired)) return invalid("发现未确认的旧密钥目录，请检查迁移进度。");
      if (!existsSync(join(active, "registry.json")) || !retiredParticipants.some(id => json(join(active, "registry.json")).nodes?.[id])) return undefined;
      validateRetiredPki(active);
      if (existsSync(workspace)) remove(root, workspace, true);
      mkdirSync(workspace);
      try {
        const security = await Security.open(staged), snapshotVersions = migrateSnapshots(active, security);
        if (existsSync(modelPath)) atomicWrite(join(workspace, "model-settings.enc.json"), canonical(seal(unseal(json(child(root, modelPath)), readFileSync(child(root, join(active, "storage.key"))), "model-settings"), security.storageKey(), "model-settings")));
        const park = new ParkData(security), fleet = new FleetData(security, park), telemetry = new Telemetry(security);
        const visits = park.snapshot(), profiles = fleet.profiles(), samples = telemetry.snapshot(); security.configureIdentities(visits.catalog.settings);
        if (existsSync(join(workspace, "model-settings.enc.json"))) new ModelSettings(workspace, security);
        state = { schemaVersion: 1, phase: "prepared", logDir, cleared: historyCounts(root), retained: { parkVehicles: visits.catalog.vehicleCount, parkVisits: visits.visits.length, vehicleProfiles: profiles.length, telemetryRecords: samples.records.length, snapshotVersions, modelConfigured: existsSync(modelPath) } };
        atomicWrite(statePath, canonical(state));
      } catch (cause) { remove(root, workspace, true); throw cause; }
    }
    // Preparation and authenticated read-back finish before any original record is removed.
    clearHistory(root, logDir);
    if (!existsSync(retired) && existsSync(staged)) move(root, active, retired);
    if (existsSync(staged)) move(root, staged, active);
    const security = await Security.open(active);
    if (existsSync(join(workspace, "model-settings.enc.json"))) move(root, join(workspace, "model-settings.enc.json"), modelPath);
    if (existsSync(modelPath)) new ModelSettings(root, security);
    const store = new Store(root);
    try { new Audit(store, security).append("identity_generation_started", { scheme: "carrier-v1", cleared: state.cleared, retained: state.retained }); } finally { store.close(); }
    const receipt: IdentityMigrationReceipt = { schemaVersion: 1, scheme: "carrier-v1", completedAt: Date.now(), cleared: state.cleared, retained: state.retained };
    atomicWrite(join(root, "identity-generation.json"), canonical(receipt));
    remove(root, workspace, true);
    return receipt;
  } finally { unlock(); }
}
