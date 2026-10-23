import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent, JsonObject, Verification } from "@vectra/shared";
import { error } from "@vectra/shared";
import { atomicWrite, canonical, hash, Security } from "./security";
import { Store } from "./store";

export class Audit {
  lastVerification: (Verification & { verifiedAt: number; count: number }) | null = null;
  private checkpointPath: string;
  constructor(private store: Store, private security: Security, private observe?: (event: AuditEvent) => void) { this.checkpointPath = join(store.root, "audit.checkpoint.json"); }
  count() { return this.store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM audit").get()!.n; }
  list(limit = 80): AuditEvent[] { return this.store.db.query<{ body: string }, [number]>("SELECT body FROM audit ORDER BY id DESC LIMIT ?").all(limit).map(row => JSON.parse(row.body)); }
  private chain() {
    let head = "0".repeat(64), count = 0;
    for (const row of this.store.db.query<{ id: number; body: string }, []>("SELECT * FROM audit ORDER BY id").all()) {
      const event = JSON.parse(row.body) as AuditEvent, { hash: supplied, ...body } = event;
      if (row.id !== ++count || event.id !== count || event.prevHash !== head || hash(body) !== supplied) throw error("audit_invalid", "审计链序号或哈希验证失败。", 403);
      head = supplied;
    }
    return { count, head };
  }
  private checkAnchor(count: number, head: string) {
    if (!existsSync(this.checkpointPath)) { if (count) throw error("checkpoint_missing", "审计检查点缺失。", 403); return; }
    const payload = this.security.verify(JSON.parse(readFileSync(this.checkpointPath, "utf8")), "report");
    if (payload.type !== "audit-checkpoint-v1" || payload.count !== count || payload.head !== head) throw error("checkpoint_mismatch", "审计链与签名检查点不一致。", 403);
  }
  private saveAnchor(count: number, head: string) {
    const checkpoint = this.security.sign("report", { type: "audit-checkpoint-v1", count, head, at: Date.now() });
    atomicWrite(this.checkpointPath, canonical(checkpoint)); return checkpoint;
  }
  append(kind: string, details: JsonObject, claimedIdentity: string | null = null, verifiedIdentity: string | null = null) {
    const event = this.store.db.transaction(() => {
      const { count, head } = this.chain(); this.checkAnchor(count, head);
      const body = { id: count + 1, at: Date.now(), kind, details, claimedIdentity, verifiedIdentity, prevHash: head };
      const event: AuditEvent = { ...body, hash: hash(body) };
      this.store.db.query("INSERT INTO audit VALUES(?,?)").run(event.id, canonical(event));
      // Disk interruption fails closed on next verification; never silently re-anchor a mismatch.
      this.saveAnchor(event.id, event.hash); this.lastVerification = null; return event;
    }).immediate();
    this.observe?.(event);
    return event;
  }
  verify() {
    try { const { count, head } = this.chain(); this.checkAnchor(count, head); return this.lastVerification = { valid: true, reason: "审计哈希链与签名检查点验证通过。", verifiedAt: Date.now(), count }; }
    catch { return this.lastVerification = { valid: false, reason: "审计链或签名检查点验证失败。", verifiedAt: Date.now(), count: this.count() }; }
  }
  checkpoint() { const { count, head } = this.chain(); this.checkAnchor(count, head); return this.saveAnchor(count, head); }
}
