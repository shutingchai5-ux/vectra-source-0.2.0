import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const children = [
  Bun.spawn([process.execPath, "--watch", "apps/server/src/index.ts"], { cwd: root, env: { ...process.env, VECTRA_DEV: "1" }, stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
  Bun.spawn([process.execPath, "node_modules/vite/bin/vite.js", "--config", "apps/web/vite.config.ts"], { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
];
console.log(`VECTRA 开发环境：http://127.0.0.1:${process.env.VECTRA_WEB_PORT || 5173} · Vue HMR + Bun watch`);
let closing = false;
async function close(code = 0) {
  if (closing) return; closing = true;
  for (const child of children) child.kill("SIGTERM");
  await Promise.allSettled(children.map(child => child.exited)); process.exit(code);
}
process.on("SIGINT", () => close()); process.on("SIGTERM", () => close());
const exits = await Promise.race(children.map(async child => ({ child, code: await child.exited })));
await close(exits.code);
