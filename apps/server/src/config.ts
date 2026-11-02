import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { error } from "@vectra/shared";
import { configuredDeployment } from "./deployment";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEFAULT_MODEL_TIMEOUT_MS = 120_000;
export const DEFAULT_TASK_TIMEOUT_MS = 600_000;
function integer(value: string | undefined, fallback: number, min: number, max: number) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw error("invalid_config", "运行配置中的数值超出允许范围。", 500);
  return number;
}
export function config() {
  const deployment=configuredDeployment(ROOT),host = deployment?.host || process.env.VECTRA_HOST || "127.0.0.1";
  if (!deployment && !["127.0.0.1", "localhost", "::1"].includes(host)) throw error("invalid_host", "本地版本仅允许回环地址。", 500);
  return {
    root: ROOT, host, port: deployment?.port ?? integer(process.env.VECTRA_PORT, 8000, 1024, 65535), deployment,
    dataDir: resolve(ROOT, deployment?.dataDir || process.env.VECTRA_TS_DATA_DIR || "runtime-ts"),
    logDir: resolve(ROOT, deployment?.logDir || process.env.VECTRA_LOG_DIR || "logs"),
    cooldown: integer(process.env.VECTRA_QUERY_COOLDOWN, 30, 0, 3600),
    mpcTimeout: integer(process.env.VECTRA_MPC_TIMEOUT, 20, 1, 120) * 1000,
    modelTimeout: integer(process.env.VECTRA_MODEL_TIMEOUT, DEFAULT_MODEL_TIMEOUT_MS / 1000, 1, 600) * 1000,
    taskTimeout: integer(process.env.VECTRA_TASK_TIMEOUT, DEFAULT_TASK_TIMEOUT_MS / 1000, 10, 900) * 1000,
    webDir: resolve(ROOT, "apps/web/dist"), dev: process.env.VECTRA_DEV === "1",
  };
}
export type Config = ReturnType<typeof config>;
