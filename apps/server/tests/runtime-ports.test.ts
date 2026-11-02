import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer, resolveConfig, type ViteDevServer } from "vite";
import { PARTICIPANTS } from "@vectra/shared";
import { ROOT } from "../src/config";
import { developmentPorts, runtimeDeployment } from "../../../scripts/runtime";

test("development backend ports support overrides and high public ports without sharing the public listener", () => {
  expect(developmentPorts(8000, "18001")).toEqual({ publicPort: 8000, apiPort: 18001 });
  expect(developmentPorts(65535, undefined).apiPort).toBe(55535);
  for (const port of ["8000", "0", "1023", "65536", "18000.5", "invalid", ""]) {
    expect(() => developmentPorts(8000, port)).toThrow("开发后端端口");
  }
});

for (const identity of ["park", "companies"] as const) {
  test(`${identity} serves Vue, API, login cookies, events and HMR through the deployment's public port`, async () => {
    const root = mkdtempSync(join(tmpdir(), "vectra-runtime-ports-"));
    const keys = ["VECTRA_DEPLOYMENT_FILE", "VECTRA_RUNTIME_IDENTITY", "VECTRA_DEV_API_PORT", "VECTRA_WEB_PORT"] as const;
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/events") return new Response("data: ready\n\n", { headers: { "Content-Type": "text/event-stream" } });
      return Response.json({ identity, origin: url.origin, requestOrigin: request.headers.get("Origin"), cookie: request.headers.get("Cookie") },
        { headers: { "Set-Cookie": "vectra_test=session; Path=/; HttpOnly; SameSite=Strict" } });
    } });
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!, origin = `http://127.0.0.1:${port}`;
    probe.stop(true);
    let web: ViteDevServer | undefined;
    let socket: WebSocket | undefined;
    try {
      const file = join(root, "deployment.json");
      const common = { role: identity, host: "127.0.0.1", port, publicUrl: origin, dataDir: ".", logDir: "logs" };
      writeFileSync(file, JSON.stringify(identity === "park" ? {
        ...common, identity: "coordinator", username: "test", passwordHash: "$argon2id$fixture",
        federation: { port: 8500, peers: Object.fromEntries(["coordinator", ...PARTICIPANTS].map(id => [id, "tls://127.0.0.1:8500"])) },
      } : { ...common, parkUrl: "http://127.0.0.1:8000", companies: Object.fromEntries(PARTICIPANTS.map(id => [id, `../${id}/deployment.json`])) }));
      process.env.VECTRA_DEPLOYMENT_FILE = file;
      process.env.VECTRA_RUNTIME_IDENTITY = identity;
      process.env.VECTRA_DEV_API_PORT = String(api.port);
      process.env.VECTRA_WEB_PORT = "5173";
      expect(runtimeDeployment(identity).deployment.port).toBe(port);
      const resolved = await resolveConfig({ configFile: resolve(ROOT, "apps/web/vite.config.ts"), logLevel: "silent" }, "serve");
      expect(resolved.cacheDir.endsWith(`/node_modules/.vite/${identity}`)).toBeTrue();
      web = await createServer({ configFile: resolve(ROOT, "apps/web/vite.config.ts"), cacheDir: join(root, "vite-cache"), logLevel: "silent", server: { watch: null } });
      expect(web.config.server.port).toBe(port);
      expect(web.config.server.strictPort).toBeTrue();
      await web.listen();
      const page = await fetch(origin);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("/@vite/client");
      const visits = await fetch(origin + "/src/components/ParkVisitEditor.vue");
      expect(visits.status).toBe(200);
      const visitModule = await visits.text();
      for (const style of ["element-plus_es_components_table_style_css", "element-plus_es_components_pagination_style_css"]) {
        const dependency = visitModule.match(new RegExp(`import ["']([^"']*${style}[^"']*)["']`))?.[1];
        expect(dependency).toBeDefined();
        expect((await fetch(new URL(dependency!, origin))).status).toBe(200);
      }
      const health = await fetch(origin + "/api/health");
      expect(await health.json()).toMatchObject({ identity, origin });
      const login = await fetch(origin + "/api/portal/login", { method: "POST", headers: { Origin: origin }, body: "{}" });
      expect(await login.json()).toMatchObject({ requestOrigin: origin, origin });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const session = await fetch(origin + "/api/portal", { headers: { Cookie: cookie } });
      expect(await session.json()).toMatchObject({ cookie });
      expect(await (await fetch(origin + "/api/events")).text()).toBe("data: ready\n\n");
      socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${web.config.webSocketToken}`, "vite-hmr");
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error("HMR did not connect through the public port")), 3000);
        socket!.addEventListener("message", event => {
          if (JSON.parse(String(event.data)).type === "connected") { clearTimeout(timer); done(); }
        });
        socket!.addEventListener("error", () => { clearTimeout(timer); reject(new Error("HMR WebSocket failed")); });
      });
    } finally {
      socket?.close();
      await web?.close();
      api.stop(true);
      for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes("vectra-runtime-ports-")) throw new Error("Unexpected test cleanup path");
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
}
