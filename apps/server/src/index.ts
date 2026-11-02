import { Effect } from "effect";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { error, asError, decode, CreateTaskSchema, ClientLogsSchema, VERSION, isLlmAgentId, type PublicEvent } from "@vectra/shared";
import { config } from "./config";
import { Collaboration } from "./service";
import { atomicWrite } from "./security";
import { CarrierRoles } from "./carrier-role";
import { readReservationCatalog } from "./reservations";
import { PortalAuth } from "./portal-auth";

export async function startServer(options = config()) {
  const app = await Collaboration.open(options);
  const carrierRoles = new CarrierRoles(app.store.db);
  const portalAuth=options.deployment?new PortalAuth(app.store.db,options.deployment):undefined;
  const portalInfo=(request:Request)=>({role:"park",identity:"coordinator",username:options.deployment?.username??"",authenticated:portalAuth?portalAuth.authenticated(request):true,legacy:!portalAuth,settings:app.park.catalog().settings,
    companyLinks:options.deployment?[{id:"companies",name:"企业端",url:options.deployment!.publicPeers?.["carrier-a"]??""}]:[]});
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
    if (!["127.0.0.1", "localhost", "[::1]",...(options.deployment?[new URL(options.deployment.publicUrl).hostname]:[])].includes(url.hostname)) throw error("host_forbidden", "访问主机不属于本部署。", 403);
    if (path === "/api/health") return json({ status: stopping ? "stopping" : "ready", version: VERSION, instanceId });
    if(path==="/api/portal"&&method==="GET")return json(portalInfo(request));
    if(path==="/api/portal/login"&&method==="POST"&&portalAuth){const cookie=await portalAuth.login(request,await body(request,4096));return new Response(JSON.stringify({...portalInfo(request),authenticated:true}),{headers:{"Content-Type":"application/json","Set-Cookie":cookie}});}
    if(path==="/api/portal/logout"&&method==="POST"&&portalAuth)return new Response("{}",{headers:{"Content-Type":"application/json","Set-Cookie":portalAuth.logout(request)}});
    if (path === "/api/control/shutdown" && method === "POST") {
      const value = request.headers.get("x-vectra-control") || "";
      if (Buffer.byteLength(value) !== Buffer.byteLength(controlToken) || !timingSafeEqual(Buffer.from(value), Buffer.from(controlToken))) throw error("control_forbidden", "服务控制凭据无效。", 403);
      const origin = request.headers.get("origin"); if (origin && origin !== url.origin) throw error("origin_forbidden", "跨来源控制被拒绝。", 403);
      setTimeout(() => { void close(); }, 50); return json({ stopping: true }, 202);
    }
    if (path === "/api/session" && method === "GET") {portalAuth?.require(request);return new Response(JSON.stringify({ ready: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": `vectra_session=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200` } });}
    if (path.startsWith("/api/")) {
      const cookie = request.headers.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith("vectra_session="))?.slice("vectra_session=".length) ?? "";
      if(portalAuth)portalAuth.require(request);
      else if (Buffer.byteLength(cookie) !== Buffer.byteLength(session) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(session))) throw error("session_required", "请打开工作台以建立本机会话。", 401);
      if (!["GET", "HEAD"].includes(method)) {
        const origin = request.headers.get("origin");
        if (origin && origin !== url.origin) throw error("origin_forbidden", "跨来源写入被拒绝。", 403);
        const site = request.headers.get("sec-fetch-site"); if (site && !["same-origin", "none"].includes(site)) throw error("origin_forbidden", "跨来源写入被拒绝。", 403);
      }
      if (stopping) throw error("service_stopping", "服务正在停止，请稍后重连。", 503);
      if(portalAuth&&(path.startsWith("/api/carrier")||path==="/api/park/records"||path.startsWith("/api/telemetry")||path==="/api/fleet"&&method!=="GET"||path==="/api/park"&&method==="POST"))throw error("portal_forbidden","企业私有数据请在对应企业端维护，园区仅接收批准的联合结果。",403);
      if(path==="/api/charging-capacity"&&app.federation){
        if(method==="GET")return json(app.federation.charge());
        if(method==="PUT"){const data=await body(request,4*1024*1024);if(!data||typeof data!=="object"||Array.isArray(data)||Object.keys(data).some(key=>!["slots","baseVersion"].includes(key)))throw error("invalid_request","充电容量字段无效。",422);const capacity=app.federation.saveCharge(data);app.audit.append("charging_capacity_saved",{datasetVersion:capacity.version,rowCount:capacity.slots.length});return json(capacity);}
      }
      if(path==="/api/business/catalogs"&&method==="GET"&&app.federation)return json((await app.federation.refresh()).business);
      if (path === "/api/overview" && method === "GET") return json(app.overview());
      if (path === "/api/identities" && method === "GET") return json(app.security.nodes());
      if (path.startsWith("/api/carrier")) {
        const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
        if (origin && origin !== url.origin || site && !["same-origin", "none"].includes(site)) throw error("origin_forbidden", "承运商角色资料仅允许本机同源页面访问。", 403);
      }
      if (path === "/api/carrier-role") {
        if (method === "POST") { const role = carrierRoles.select(await body(request)); app.logs.remember(role.token); app.logs.operation("carrier.role_selected", { carrierId: role.carrierId, requestId }); return json(role); }
        if (method === "GET") return json(carrierRoles.require(request.headers));
      }
      if (path === "/api/carrier/fleet" && method === "GET") { const role = carrierRoles.require(request.headers); return json(app.fleet.forCarrier(role.carrierId)); }
      if (path === "/api/carrier/reservations/versions" && method === "GET") { const role = carrierRoles.require(request.headers); return json(app.reservations.versions(role.carrierId)); }
      if (path === "/api/carrier/reservations") {
        const role = carrierRoles.require(request.headers);
        if (method === "GET") return json(app.reservations.forCarrier(role.carrierId, url.searchParams.get("version") ?? undefined));
        if (method === "PUT") {
          const data = await body(request, 4 * 1024 * 1024);
          if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => !["slots", "baseVersion"].includes(key)))
            throw error("invalid_reservation", "请提交本方预约时段和当前版本。", 422);
          const snapshot = app.reservations.replaceCarrier(role.carrierId, data.slots, data.baseVersion);
          app.audit.append("reservation_plans_saved", { carrierId: role.carrierId, datasetVersion: snapshot.version, rowCount: snapshot.slots.length });
          return json(snapshot);
        }
      }
      if (path === "/api/carrier/visits/queue" && method === "POST") {
        const data = await body(request), role = carrierRoles.require(request.headers);
        if (data && typeof data === "object" && !Array.isArray(data)) app.fleet.assertVisitOwners([{ ...data, carrierId: role.carrierId }]);
        const previousVersion = app.park.catalog().version, snapshot = app.park.queueCarrier(role.carrierId, data);
        if (snapshot.version !== previousVersion) app.audit.append("park_queue_registered", { carrierId: role.carrierId, datasetVersion: snapshot.version, visitCount: snapshot.catalog.visitCount });
        return json(snapshot, 201);
      }
      if (path === "/api/carrier/visits/admissions" && method === "POST") {
        const data = await body(request), role = carrierRoles.require(request.headers);
        if (data && typeof data === "object" && !Array.isArray(data)) app.fleet.assertVisitOwners([{ ...data, carrierId: role.carrierId }]);
        const snapshot = app.park.admitCarrier(role.carrierId, data);
        app.audit.append("park_admission_confirmed", { carrierId: role.carrierId, datasetVersion: snapshot.version, visitCount: snapshot.catalog.visitCount });
        return json(snapshot, 201);
      }
      if (path === "/api/carrier/visits/import" && method === "POST") {
        const data = await body(request, 4 * 1024 * 1024), role = carrierRoles.require(request.headers);
        if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => !["visits", "baseVersion"].includes(key)) || !Array.isArray(data.visits)) throw error("invalid_park_data", "请提供需要追加的本方车次及当前版本。", 422);
        if (data.visits.some((row: unknown) => !row || typeof row !== "object" || !("carrierId" in row) || row.carrierId !== role.carrierId)) throw error("carrier_scope_forbidden", "只能导入当前承运商的车次。", 403);
        app.fleet.assertVisitOwners(data.visits); const snapshot = app.park.appendCarrier(role.carrierId, data.visits, data.baseVersion);
        app.audit.append("park_visits_appended", { carrierId: role.carrierId, datasetVersion: snapshot.version, importedCount: data.visits.length }); return json(snapshot, 201);
      }
      const carrierVisit = path.match(/^\/api\/carrier\/visits\/([^/]+)(?:\/(lifecycle))?$/);
      if (carrierVisit && (carrierVisit[2] === "lifecycle" && method === "POST" || !carrierVisit[2] && method === "PUT")) {
        const data = await body(request), role = carrierRoles.require(request.headers);
        const visitId = decodeURIComponent(carrierVisit[1]);
        const snapshot = carrierVisit[2] ? app.park.advanceCarrier(role.carrierId, visitId, data) : app.park.correctCarrier(role.carrierId, visitId, data);
        app.audit.append(carrierVisit[2] ? "park_lifecycle_recorded" : "park_visit_corrected", { carrierId: role.carrierId, datasetVersion: snapshot.version }); return json(snapshot);
      }
      if (path === "/api/carrier/visits") {
        if (method === "GET") { const role = carrierRoles.require(request.headers); return json(app.park.forCarrier(role.carrierId, url.searchParams.get("version") ?? undefined)); }
        if (method === "POST") {
          const data = await body(request, 4 * 1024 * 1024), role = carrierRoles.require(request.headers);
          if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => !["visits", "baseVersion"].includes(key))) throw error("invalid_park_data", "请提交本承运商车次和当前数据版本。", 422);
          if (!Array.isArray(data.visits) || data.visits.some((row: unknown) => !row || typeof row !== "object" || !("carrierId" in row) || row.carrierId !== role.carrierId)) throw error("carrier_scope_forbidden", "当前角色只能保存本承运商的车次。", 403);
          app.fleet.assertVisitOwners(data.visits); const catalog = app.park.importCarrier(role.carrierId, data.visits, data.baseVersion);
          app.audit.append("park_visits_imported", { carrierId: role.carrierId, datasetVersion: catalog.version, visitCount: catalog.visitCount, vehicleCount: catalog.vehicleCount }); return json(catalog, 201);
        }
      }
      if (path.startsWith("/api/agents")) {
        const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
        if (origin && origin !== url.origin || site && !["same-origin", "none"].includes(site)) throw error("origin_forbidden", "Agent 配置与记忆仅允许本机同源页面访问。", 403);
        if (path === "/api/agents" && method === "GET") return json(app.agents.list());
        const selected = path.match(/^\/api\/agents\/([\w-]+)(?:\/(model-settings|memories|memory-settings)(?:\/([\w-]+))?)?$/);
        if (!selected || !isLlmAgentId(selected[1])) throw error("agent_unknown", "未找到已登记的 LLM 智能体。", 404);
        const id = selected[1], section = selected[2], memoryId = selected[3];
        if (!section && method === "GET") return json(app.agents.detail(id));
        if (section === "model-settings" && !memoryId) {
          if (method === "GET") return json(app.agents.model(id));
          if (method === "PUT") { const next = app.agents.configureModel(id, await body(request)); for (const model of Object.values(app.agents.models())) app.logs.remember(model.apiKey); app.logs.operation("agent.model_settings_saved", { agent: id, model: next.model, inherited: next.inherited, requestId }); return json(next); }
        }
        if (section === "memories" || section === "memory-settings") {
          if (id !== "coordinator") throw error("memory_not_available", "仅主智能体拥有长期记忆；子智能体只接收本次委派所需上下文。", 403);
          const memory = app.agents.memory;
          if (section === "memory-settings" && !memoryId) {
            if (method === "GET") return json(memory.settings());
            if (method === "PUT") { const next = memory.configure(await body(request)); app.logs.operation("agent.memory_settings_saved", { ...next, requestId }); return json(next); }
          }
          if (section === "memories") {
            if (!memoryId && method === "GET") return json(memory.list((url.searchParams.get("q") ?? "").slice(0, 200)));
            if (!memoryId && method === "POST") { const item = memory.save(await body(request)); app.logs.operation("agent.memory_saved", { agent: id, memoryId: item.id, source: "manual", requestId }); return json(item, 201); }
            if (memoryId && method === "PUT") { const item = memory.save(await body(request), memoryId); app.logs.operation("agent.memory_updated", { agent: id, memoryId: item.id, requestId }); return json(item); }
            if (memoryId && method === "DELETE") { const data = await body(request); if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 1 || !("revision" in data)) throw error("invalid_memory", "请提供记忆的当前版本。", 422); memory.remove(memoryId, data.revision); app.logs.operation("agent.memory_deleted", { agent: id, memoryId, requestId }); return json({ deleted: true }); }
          }
        }
        throw error("not_found", "未找到此 Agent 操作。", 404);
      }
      if (path === "/api/fleet" && method === "GET") {
        const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
        if (origin && origin !== url.origin || site && !["same-origin", "none"].includes(site)) throw error("origin_forbidden", "车辆资料仅允许本机同源页面读取。", 403);
        return json(app.federation?await app.federation.fleet():app.fleet.overview());
      }
      if (path === "/api/fleet" && method === "POST") {
        const data = await body(request, 4 * 1024 * 1024);
        const role = carrierRoles.require(request.headers);
        if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => !["carrierId", "vehicles", "baseVersion"].includes(key))) throw error("invalid_vehicle", "请提交承运商、完整车辆列表与当前档案版本。", 422);
        if (data.carrierId !== role.carrierId) throw error("carrier_scope_forbidden", "当前角色只能为本承运商添加和修改车辆档案。", 403);
        app.fleet.save(role.carrierId, data.vehicles, data.baseVersion, true); const overview = app.fleet.forCarrier(role.carrierId);
        app.audit.append("carrier_vehicles_saved", { carrierId: data.carrierId, vehicleCount: overview.vehicles.filter(v => v.profiled && v.carrierId === data.carrierId).length, fleetVersion: overview.version });
        return json(overview, 201);
      }
      if (path === "/api/park" && method === "GET") return json(app.park.catalog());
      if (path === "/api/reservations/versions" && method === "GET") return json(app.reservations.versions());
      if (path === "/api/reservations" && method === "GET") {
        const version = url.searchParams.get("version");
        return json(version ? readReservationCatalog(app.security, version) : app.reservations.catalog());
      }
      if (path === "/api/reservations/capacity" && method === "PUT") {
        const data = await body(request, 4 * 1024 * 1024);
        if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => !["capacitySlots", "baseVersion"].includes(key)))
          throw error("invalid_reservation", "请提交园区容量时段和当前版本。", 422);
        const catalog = app.reservations.replaceCapacity(data.capacitySlots, data.baseVersion);
        app.audit.append("reservation_capacity_saved", { datasetVersion: catalog.version, rowCount: catalog.capacitySlots.length });
        return json(catalog);
      }
      if (path === "/api/park/records" && method === "GET") {
        const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
        if (origin && origin !== url.origin || site && !["same-origin", "none"].includes(site)) throw error("origin_forbidden", "承运商车次原始记录仅允许本机同源页面读取。", 403);
        return json(app.park.snapshot());
      }
      if ((path === "/api/park" && method === "POST") || (path === "/api/park/settings" && method === "PUT")) {
        const data = await body(request, 4 * 1024 * 1024), setting = path.endsWith("/settings");
        if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => ![setting ? "settings" : "visits", "baseVersion"].includes(key)) || typeof data.baseVersion !== "string") throw error("invalid_park_data", "请提交完整车次 visits 或园区 settings，以及当前 baseVersion。", 422);
        const role = setting ? undefined : carrierRoles.require(request.headers);
        if (!setting) {
          if (!Array.isArray(data.visits) || data.visits.some((row: unknown) => !row || typeof row !== "object" || !("carrierId" in row) || row.carrierId !== role!.carrierId)) throw error("carrier_scope_forbidden", "当前角色只能保存本承运商的车次。", 403);
          app.fleet.assertVisitOwners(data.visits);
        }
        const catalog = setting ? app.park.configure(data.settings, data.baseVersion) : app.park.importCarrier(role!.carrierId, data.visits, data.baseVersion);
        if (setting) { app.security.configureIdentities(catalog.settings); app.reservations.refreshSettings(); }
        app.audit.append(setting ? "park_settings_saved" : "park_visits_imported", { datasetVersion: catalog.version, roadCount: catalog.roads.length, visitCount: catalog.visitCount, vehicleCount: catalog.vehicleCount, completedCount: catalog.completedCount, carrierCount: 3 });
        return json(catalog, 201);
      }
      if (path === "/api/telemetry" && method === "GET") return json(app.telemetry.catalog());
      if (path === "/api/telemetry/records" && method === "GET") {
        const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
        if (origin && origin !== url.origin || site && !["same-origin", "none"].includes(site)) throw error("origin_forbidden", "车辆原始记录仅允许本机同源页面读取。", 403);
        return json(app.telemetry.snapshot());
      }
      if (path === "/api/telemetry" && method === "POST") {
        const data = await body(request, 2 * 1024 * 1024);
        const role = carrierRoles.require(request.headers);
        if (!Array.isArray(data) && (!data || typeof data !== "object" || Object.keys(data).some(key => !["records", "baseVersion"].includes(key)) || typeof data.baseVersion !== "string" || !Array.isArray(data.records))) throw error("invalid_telemetry", "导入须为记录数组或包含 records、baseVersion 的编辑快照。", 422);
        const catalog = Array.isArray(data) ? app.telemetry.importCarrier(role.carrierId, data) : app.telemetry.importCarrier(role.carrierId, data.records, data.baseVersion);
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
        ? `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${new URL(request.url).origin.replace(/^http/, "ws")}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
        : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      return new Response(response.body, { status: response.status, headers });
    },
  }); } catch (cause) { app.logs.operation("server.listen_failed", { host: options.host, port: options.port, error: cause }, "error"); await app.close(); throw error("listen_failed", "服务端口无法监听，请检查是否已有服务运行。", 503, cause); }
  app.logs.operation("server.listening", { host: options.host, port: server.port, dev: options.dev, version: VERSION });
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
