import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { error } from "@vectra/shared";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function integer(value: string | undefined, fallback: number, min: number, max: number) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw error("invalid_config", "运行配置中的数值超出允许范围。", 500);
  return number;
}
export function config() {
  const host = process.env.VECTRA_HOST || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw error("invalid_host", "本地版本仅允许回环地址。", 500);
  return {
    root: ROOT, host, port: integer(process.env.VECTRA_PORT, 8000, 1024, 65535),
    dataDir: resolve(ROOT, process.env.VECTRA_TS_DATA_DIR || "runtime-ts"),
    logDir: resolve(ROOT, process.env.VECTRA_LOG_DIR || "logs"),
    cooldown: integer(process.env.VECTRA_QUERY_COOLDOWN, 30, 0, 3600),
    mpcTimeout: integer(process.env.VECTRA_MPC_TIMEOUT, 20, 1, 120) * 1000,
    taskTimeout: integer(process.env.VECTRA_TASK_TIMEOUT, 180, 10, 900) * 1000,
    webDir: resolve(ROOT, "apps/web/dist"), dev: process.env.VECTRA_DEV === "1",
  };
}
export type Config = ReturnType<typeof config>;
