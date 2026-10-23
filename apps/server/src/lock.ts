import { existsSync, readFileSync, lstatSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { error } from "@vectra/shared";

export function runtimeLock(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "server.lock.json"), token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(path, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 }); break; }
    catch {
      if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw error("runtime_locked", "数据目录锁无效或正在被其他服务使用。", 409);
      let existing: { pid?: number };
      try { existing = JSON.parse(readFileSync(path, "utf8")); } catch { throw error("runtime_locked", "数据目录锁损坏，请确认服务已停止。", 409); }
      if (!Number.isSafeInteger(existing.pid) || Number(existing.pid) <= 0) throw error("runtime_locked", "数据目录锁无效。", 409);
      let alive = true; try { process.kill(existing.pid!, 0); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      if (alive || attempt) throw error("runtime_locked", "同一数据目录已有服务运行，请使用独立数据目录。", 409);
      unlinkSync(path);
    }
  }
  return () => { try { const value = JSON.parse(readFileSync(path, "utf8")); if (value.token === token) unlinkSync(path); } catch {} };
}
