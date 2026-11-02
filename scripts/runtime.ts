import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
type RuntimeIdentity = "park" | "companies";

export function runtimeIdentity(requested = "park") {
  const identity = ["carrier-a", "carrier-b", "carrier-c"].includes(requested) ? "companies" : requested;
  if (identity !== "park" && identity !== "companies") throw new Error("请选择 park 或 companies；企业由登录账号区分。");
  return identity;
}

export function runtimeDeployment(requested = "park", env = process.env) {
  const identity = runtimeIdentity(requested);
  const file = resolve(root, env.VECTRA_DEPLOYMENT_FILE ?? `runtime-deploy/${identity}/deployment.json`);
  if (!existsSync(file)) throw new Error("部署尚未初始化，请先运行 bun run deploy:init。");
  const deployment = JSON.parse(readFileSync(file, "utf8")) as { role: RuntimeIdentity; host: string; port: number };
  if (deployment.role !== identity) throw new Error("部署文件与启动端不一致，请检查 VECTRA_DEPLOYMENT_FILE。");
  if (!Number.isInteger(deployment.port) || deployment.port < 1024 || deployment.port > 65535 || typeof deployment.host !== "string" || !deployment.host) {
    throw new Error("部署监听地址或端口无效。");
  }
  return { identity, file, deployment };
}

export function developmentPorts(publicPort: number, apiPort?: string) {
  const port = apiPort === undefined ? publicPort + (publicPort <= 55535 ? 10000 : -10000) : Number(apiPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === publicPort) {
    throw new Error("开发后端端口须为 1024—65535，且不能与公开入口相同；请检查 VECTRA_DEV_API_PORT。");
  }
  return { publicPort, apiPort: port };
}
