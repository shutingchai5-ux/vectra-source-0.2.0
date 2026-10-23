import { Effect } from "effect";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { error, asError, decode, CreateTaskSchema, ClientLogsSchema, type PublicEvent } from "@vectra/shared";
import { config } from "./config";
import { Collaboration } from "./service";
import { atomicWrite } from "./security";

export async function startServer(options = config()) {
  const app = await Collaboration.open(options);
  const sessionFile = join(options.dataDir, "session.key");
  if (!existsSync(sessionFile)) writeFileSync(sessionFile, randomBytes(32).toString("base64url"), { mode: 0o600 });
  const session = readFileSync(sessionFile, "utf8");
  const instanceId = app.logs.runId, controlToken = randomBytes(32).toString("base64url"), controlPath = join(options.dataDir, "server-control.json");
  app.logs.remember(session, controlToken);
  let clientWindow = Date.now(), clientEntries = 0;
  let stopping = false;
  const feeds = new Set<() => void>();
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const integer = (value: string | null, fallback = 0, max = 1_000_000_000) => {
    const n = value === null ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > max) throw error("invalid_cursor", "分页参数或事件序号无效。", 422); return n;
  };
  async function body(request: Request, maxBytes = 131072) {
    if (!request.body) throw error("invalid_request", "请求正文缺失。", 422);
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > maxBytes) { await reader.cancel(); throw error("body_too_large", "请求过大。", 413); } chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw error("invalid_json", "请求须使用有效 JSON。", 422); }
  }
  function eventStream(request: Request, after: number) {
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let cursor = after, closed = false;
        const encoder = new TextEncoder();
        const close = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); request.signal.removeEventListener("abort", close); feeds.delete(close); try { controller.close(); } catch {} };
        const write = (event: PublicEvent) => {
          if (closed || event.id <= cursor) return;
          if ((controller.desiredSize ?? 1) < -128) { close(); return; }
          controller.enqueue(encoder.encode(`id: ${event.id}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`)); cursor = event.id;
        };
        // Subscribe before replay. SQLite replay and subscription registration are synchronous;
        // duplicate suppression makes reconnect and the replay/live boundary deterministic.
        const unsubscribe = app.store.subscribe(write);
        const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": keep-alive\n\n")); }, 15_000);
        cleanup = close; feeds.add(close); request.signal.addEventListener("abort", close, { once: true });
        let backlog: PublicEvent[];
        do { backlog = app.store.events(cursor); for (const event of backlog) write(event); } while (!closed && backlog.length === 256);
        if (request.signal.aborted) close();
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  }
  async function route(request: Request, requestId: string): Promise<Response> {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw error("host_forbidden", "仅允许本机访问。", 403);
    if (path === "/api/health") return json({ status: stopping ? "stopping" : "ready", version: "1.0.3", instanceId });
    if (path === "/api/control/shutdown" && method === "POST") {
      const value = request.headers.get("x-vectra-control") || "";
      if (Buffer.byteLength(value) !== Buffer.byteLength(controlToken) || !timingSafeEqual(Buffer.from(value), Buffer.from(controlToken))) throw error("control_forbidden", "服务控制凭据无效。", 403);
      const origin = request.headers.get("origin"); if (origin && origin !== url.origin) throw error("origin_forbidden", "跨来源控制被拒绝。", 403);
      setTimeout(() => { void close(); }, 50); return json({ stopping: true }, 202);
    }
    if (path === "/api/session" && method === "GET") return new Response(JSON.stringify({ ready: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": `vectra_session=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200` } });
    if (path.startsWith("/api/")) {
      const cookie = request.headers.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith("vectra_session="))?.slice("vectra_session=".length) ?? "";
      if (Buffer.byteLength(cookie) !== Buffer.byteLength(session) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(session))) throw error("session_required", "请打开工作台以建立本机会话。", 401);
      if (!["GET", "HEAD"].includes(method)) {
        const origin = request.headers.get("origin");
        if (origin && origin !== url.origin) throw error("origin_forbidden", "跨来源写入被拒绝。", 403);
        const site = request.headers.get("sec-fetch-site"); if (site && !["same-origin", "none"].includes(site)) throw error("origin_forbidden", "跨来源写入被拒绝。", 403);
      }
      if (stopping) throw error("service_stopping", "服务正在停止，请稍后重连。", 503);
      if (path === "/api/overview" && method === "GET") return json(app.overview());
      if (path === "/api/telemetry" && method === "GET") return json(app.telemetry.catalog());
      if (path === "/api/telemetry/records" && method === "GET") {
        const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
        if (origin && origin !== url.origin || site && !["same-origin", "none"].includes(site)) throw error("origin_forbidden", "车辆原始记录仅允许本机同源页面读取。", 403);
        return json(app.telemetry.snapshot());
      }
      if (path === "/api/telemetry" && method === "POST") {
        const data = await body(request, 2 * 1024 * 1024);
        if (!Array.isArray(data) && (!data || typeof data !== "object" || Object.keys(data).some(key => !["records", "baseVersion"].includes(key)) || typeof data.baseVersion !== "string" || !Array.isArray(data.records))) throw error("invalid_telemetry", "导入须为记录数组或包含 records、baseVersion 的编辑快照。", 422);
        const catalog = Array.isArray(data) ? app.telemetry.import(data) : app.telemetry.import(data.records, data.baseVersion);
        app.audit.append("telemetry_imported", { datasetVersion: catalog.version, roadCount: catalog.roads.length, sampleCount: catalog.sampleCount, vehicleCount: catalog.vehicleCount });
        return json(catalog, 201);
      }
      if (path === "/api/events" && method === "GET") return eventStream(request, integer(request.headers.get("last-event-id") ?? url.searchParams.get("after")));
      if (path === "/api/events/replay" && method === "GET") return json(app.store.events(integer(url.searchParams.get("after"))));
      if (path === "/api/client-logs" && method === "POST") {
        const data = decode(ClientLogsSchema, await body(request));
        if (Date.now() - clientWindow >= 60_000) { clientWindow = Date.now(); clientEntries = 0; }
        if (clientEntries + data.entries.length > 120) throw error("log_rate_limit", "客户端日志上报过于频繁。", 429);
        clientEntries += data.entries.length;
        for (const entry of data.entries) {
          if (!app.logs.operation(`client.${entry.event}`, { ...entry, event: undefined, requestId: entry.requestId || requestId }, /error|rejection|failed/.test(entry.event) ? "error" : "info")) throw error("log_write_failed", "诊断日志暂时无法写入。", 503);
        }
        return json({ accepted: data.entries.length });
      }
      if (path === "/api/tasks" && method === "POST") {
        const task = app.submit(decode(CreateTaskSchema, await body(request)));
        app.logs.operation("task.submitted", { requestId, taskRequestId: task.requestId, taskId: task.id, conversationId: task.conversationId });
        return json(task, 202);
      }
      if (path === "/api/tasks" && method === "GET") return json(app.store.tasks(url.searchParams.get("conversationId") ?? undefined, integer(url.searchParams.get("offset"), 0, 100000)));
      const conversation = path.match(/^\/api\/conversations\/([\w-]+)$/);
      if (conversation && method === "DELETE") return json(await app.deleteConversation(conversation[1]));
      if (conversation && method === "GET") {
        const selected = app.store.conversation(conversation[1]); if (!selected) throw error("conversation_missing", "会话不存在。", 404);
        return json({ conversation: selected, messages: app.store.messages(selected.id), tasks: app.store.tasks(selected.id) });
      }
      const task = path.match(/^\/api\/tasks\/([\w-]+)(\/cancel)?$/);
      const materials = path.match(/^\/api\/tasks\/([\w-]+)\/steps\/([\w-]+)\/materials$/);
      if (materials && method === "GET") {
        const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
        if (origin && origin !== url.origin || site && !["same-origin", "none"].includes(site)) throw error("origin_forbidden", "实验私密材料仅允许本机同源页面读取。", 403);
        return json(app.protocolMaterials(materials[1], materials[2]));
      }
      if (task) {
        if (task[2] && method === "POST") return json(app.cancel(task[1]));
        if (method === "GET") { const value = app.store.task(task[1]); if (!value) throw error("task_missing", "任务不存在。", 404); return json(value); }
      }
      if (path === "/api/model-settings") {
        if (method === "GET") return json(app.settings.public());
        if (method === "PUT") {
          const settings = app.settings.save(await body(request));
          app.logs.remember(app.settings.snapshot().apiKey);
          app.logs.operation("model.settings_saved", { ...settings, requestId });
          return json(settings);
        }
      }
      if (path === "/api/evidence" && method === "GET") return json({ events: app.audit.list(100), verification: app.audit.lastVerification });
      if (path === "/api/evidence/analysis" && method === "GET") return json(app.analyze(url.searchParams.has("eventId") ? integer(url.searchParams.get("eventId")) : undefined));
      if (path === "/api/audit/verify" && method === "POST") {
        const result = app.audit.verify(); app.logs.operation("audit.verified", { ...result, requestId }, result.valid ? "info" : "warn"); return json(result);
      }
      if (path === "/api/audit/checkpoint" && method === "POST") return json(app.audit.checkpoint());
      if (path === "/api/reports/verify" && method === "POST") {
        const result = app.verifyReport((await body(request)).envelope); app.logs.operation("report.verified", { ...result, requestId }, result.valid ? "info" : "warn"); return json(result);
      }
      const report = path.match(/^\/api\/reports\/([\w-]+)(\/download)?$/);
      if (report && method === "GET") return new Response(JSON.stringify(app.report(report[1]), null, 2), { headers: { "Content-Type": "application/json", ...(report[2] ? { "Content-Disposition": `attachment; filename="vectra-report-${report[1]}.json"` } : {}) } });
      throw error("not_found", "接口不存在。", 404);
    }
    if (method !== "GET" && method !== "HEAD") throw error("method_not_allowed", "请求方法不支持。", 405);
    const relative = decodeURIComponent(path).replace(/^\/+/, "");
    const candidate = resolve(options.webDir, relative || "index.html");
    if (!candidate.startsWith(resolve(options.webDir) + (process.platform === "win32" ? "\\" : "/")) && candidate !== resolve(options.webDir, "index.html")) throw error("path_forbidden", "资源路径无效。", 403);
    const file = Bun.file(candidate);
    if (await file.exists()) return new Response(file);
    if (extname(path)) throw error("not_found", "资源不存在。", 404);
    const index = Bun.file(join(options.webDir, "index.html"));
    if (await index.exists()) return new Response(index);
    return new Response("前端尚未构建。开发请运行 bun run dev；发布请先运行 bun run build。", { status: 503 });
  }
  let server: ReturnType<typeof Bun.serve>;
  try { server = Bun.serve({
    hostname: options.host, port: options.port, idleTimeout: 0,
    async fetch(request) {
      const started = performance.now(), path = new URL(request.url).pathname;
      const suppliedId = request.headers.get("x-request-id");
      const requestId = suppliedId && /^[A-Za-z0-9_-]{8,100}$/.test(suppliedId) ? suppliedId : randomUUID();
      let response: Response;
      const result = await Effect.runPromise(Effect.tryPromise({ try: () => route(request, requestId), catch: cause => {
        const failure = cause instanceof URIError ? error("invalid_path", "资源路径编码无效。", 422) : asError(cause);
        app.logs.operation("http.error", { requestId, method: request.method, path, code: failure.code, status: failure.status, error: cause }, failure.status >= 500 ? "error" : "warn");
        return failure;
      } }).pipe(Effect.either));
      response = result._tag === "Right" ? result.right : json({ code: result.left.code, message: result.left.message }, result.left.status);
      const quiet = ["/api/health", "/api/session", "/api/overview", "/api/events", "/api/events/replay", "/api/client-logs"].includes(path);
      if (path.startsWith("/api/") && (!quiet || response.status >= 400)) app.logs.operation("http.request", { requestId, method: request.method, path, status: response.status, durationMs: Math.round(performance.now() - started) }, response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info");
      const headers = new Headers(response.headers);
      headers.set("X-Request-Id", requestId);
      headers.set("X-Content-Type-Options", "nosniff"); headers.set("X-Frame-Options", "DENY"); headers.set("Referrer-Policy", "no-referrer"); headers.set("Cache-Control", "no-store");
      headers.set("Content-Security-Policy", options.dev
        ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173 ws://localhost:5173; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      return new Response(response.body, { status: response.status, headers });
    },
  }); } catch (cause) { app.logs.operation("server.listen_failed", { host: options.host, port: options.port, error: cause }, "error"); await app.close(); throw error("listen_failed", "服务端口无法监听，请检查是否已有服务运行。", 503, cause); }
  app.logs.operation("server.listening", { host: options.host, port: server.port, dev: options.dev, version: "1.0.3" });
  atomicWrite(controlPath, JSON.stringify({ instanceId, port: server.port, host: options.host, token: controlToken, pid: process.pid }));
  async function close() {
    if (stopping) return; stopping = true; for (const closeFeed of [...feeds]) closeFeed(); server.stop(); await app.close();
    try { if (JSON.parse(readFileSync(controlPath, "utf8")).instanceId === instanceId) unlinkSync(controlPath); } catch {}
  }
  return { server, app, close };
}

if (import.meta.main) {
  const live = await startServer();
  console.log(`VECTRA Bun 服务：http://${live.server.hostname}:${live.server.port}`);
  let closing = false;
  const close = async (code = 0) => {
    if (closing) return; closing = true;
    try { await live.close(); } catch (cause) { live.app.logs.operation("server.shutdown_failed", { error: cause }, "error"); code = 1; }
    process.exit(code);
  };
  process.on("SIGINT", () => { void close(); }); process.on("SIGTERM", () => { void close(); });
  const fatal = (cause: unknown) => { live.app.logs.operation("server.unhandled_error", { error: cause }, "error"); void close(1); };
  process.on("uncaughtException", fatal); process.on("unhandledRejection", fatal);
}
