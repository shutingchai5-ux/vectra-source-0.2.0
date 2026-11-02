import { randomBytes, createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { error, isCarrierId, type CarrierId, type CarrierRole } from "@vectra/shared";
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
/** A selectable local workspace role, not a carrier login or real-world identity proof. */
export class CarrierRoles {
  constructor(private db: Database) { db.exec("CREATE TABLE IF NOT EXISTS carrier_role_sessions(token_hash TEXT PRIMARY KEY,carrier_id TEXT NOT NULL,expires_at INTEGER NOT NULL)"); }
  select(raw: unknown): CarrierRole {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !["carrierId", "previousToken"].includes(key)) || !("carrierId" in raw) || !isCarrierId(raw.carrierId) || "previousToken" in raw && (typeof raw.previousToken !== "string" || raw.previousToken.length > 100)) throw error("invalid_carrier_role", "请选择已登记的承运商角色。", 422);
    const token = randomBytes(32).toString("base64url"), expiresAt = Date.now() + 12 * 3600000, carrierId = raw.carrierId;
    this.db.transaction(() => { this.db.query("DELETE FROM carrier_role_sessions WHERE expires_at<=?").run(Date.now()); if ("previousToken" in raw && typeof raw.previousToken === "string") this.db.query("DELETE FROM carrier_role_sessions WHERE token_hash=?").run(digest(raw.previousToken)); this.db.query("INSERT INTO carrier_role_sessions VALUES(?,?,?)").run(digest(token), carrierId, expiresAt); }).immediate();
    return { carrierId, token, expiresAt };
  }
  require(headers: Headers): { carrierId: CarrierId; expiresAt: number } {
    const token = headers.get("X-Carrier-Role") ?? "";
    const row = /^[A-Za-z0-9_-]{43}$/.test(token) ? this.db.query<{ carrier_id: string; expires_at: number }, [string]>("SELECT carrier_id,expires_at FROM carrier_role_sessions WHERE token_hash=?").get(digest(token)) : undefined;
    if (!row || row.expires_at <= Date.now() || !isCarrierId(row.carrier_id)) throw error("carrier_role_required", "当前承运商角色未选择或已失效，请在承运商工作台重新切换角色。", 403);
    return { carrierId: row.carrier_id, expiresAt: row.expires_at };
  }
}
