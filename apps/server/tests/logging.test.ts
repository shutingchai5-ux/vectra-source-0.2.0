import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { sanitizeLogValue, shanghaiDay, shanghaiDayIndex, shanghaiTime, shanghaiTimestamp, shanghaiDateTime, type Task } from "@vectra/shared";
import { Diagnostics } from "../src/logging";
import { config } from "../src/config";
import { startServer } from "../src/index";
import { runAgent } from "../src/model";
import { installFixtureProvider } from "./fixtures";

function records(root: string, channel: string): any[] {
  return readdirSync(join(root, channel)).filter(name => name.endsWith(".jsonl"))
    .flatMap(name => readFileSync(join(root, channel, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

test("Shanghai time stays fixed across host time zones and midnight uses the correct log date", () => {
  const previous = process.env.TZ, root = mkdtempSync(join(tmpdir(), "vectra-time-test-"));
  try {
    process.env.TZ = "America/Los_Angeles";
    const before = Date.parse("2026-10-22T15:59:59.999Z"), after = before + 1;
    expect(shanghaiDay(before)).toBe("2026-10-22"); expect(shanghaiDay(after)).toBe("2026-10-23");
    expect(shanghaiDayIndex(after) - shanghaiDayIndex(before)).toBe(1);
    expect(shanghaiTime(after)).toContain("00:00:00");
    expect(shanghaiTimestamp(after)).toBe("2026-10-23T00:00:00.000+08:00");
    const importedAt = Date.parse("2026-10-23T02:30:28.776Z");
    expect(shanghaiDateTime(importedAt)).toBe("2026-10-23 10:30:28（上海时间 UTC+08:00）");
    expect(shanghaiDateTime(new Date(importedAt))).toBe(shanghaiDateTime(importedAt));
    expect(Date.parse(shanghaiTimestamp(importedAt))).toBe(importedAt);
    expect(shanghaiTime(importedAt, { timeZone: "UTC" })).toContain("10:30:28");
    const logs = new Diagnostics(root); logs.operation("midnight", {}, "info", after);
    const entry = JSON.parse(readFileSync(join(root, "operations", "2026-10-23.jsonl"), "utf8"));
    expect(entry.timestamp).toBe("2026-10-23T00:00:00.000+08:00"); expect(entry.timeZone).toBe("Asia/Shanghai");
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; rmSync(root, { recursive: true, force: true }); }
});

test("diagnostic redaction covers credentials, private material, nested causes and cycles", () => {
  const secret = "opaque-test-key-93", privateKey = "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----";
  const input: any = { api_key: secret, cookie: "session-value", input: { speed: 60 }, shares: [1, 2], reasoning_content: "private-reasoning",
    message: `正常说明 40 km/h\n${secret} Bearer example-token token password=abc ${privateKey}`,
    error: new Error(`failure ${secret}`, { cause: new Error("Cookie: vectra_session=secret-cookie") }) };
  input.self = input;
  const value = JSON.stringify(sanitizeLogValue(input, [secret]));
  for (const hidden of [secret, "session-value", "private-material", "private-reasoning", "example-token", "secret-cookie"]) expect(value).not.toContain(hidden);
  expect(value).toContain("正常说明 40 km/h"); expect(value).toContain("[CIRCULAR]"); expect(value).toContain("stack");
});

test("JSONL keeps one record per line and provider failures retain HTTP diagnostics without response bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-log-test-")), logs = new Diagnostics(root), original = globalThis.fetch;
  logs.remember("provider-test-key-928");
  try {
    logs.conversation("user.message", { content: '第一行\n{"event":"injected"}\nprovider-test-key-928' });
    expect(records(root, "conversations")).toHaveLength(1);
    expect(records(root, "conversations")[0].content).toContain("[REDACTED]");
    globalThis.fetch = Object.assign(async () => new Response("provider-body-must-not-be-logged", { status: 401 }), { preconnect: original.preconnect });
    await expect(Effect.runPromise(runAgent({ mode: "llm", provider: "custom", baseUrl: "https://example.invalid/v1", model: "test", apiKey: "provider-test-key-928" }, "公开提问", [], {}, () => {}, new AbortController().signal, "test", (event, detail, level) => { logs.operation(event, detail, level); }))).rejects.toThrow();
    const operations = records(root, "operations");
    expect(operations.some(entry => entry.event === "model.http_response" && entry.status === 401)).toBeTrue();
    expect(operations.some(entry => entry.event === "model.request_failed" && entry.error.status === 401)).toBeTrue();
    expect(JSON.stringify(operations)).not.toContain("provider-body-must-not-be-logged");
    expect(JSON.stringify(operations)).not.toContain("provider-test-key-928");
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
});

test("real API journals dialogs, task failures, client errors and request IDs; restart does not duplicate exported history", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-log-test-")), logDir = join(root, "logs");
  const key = "opaque-current-credential-294";
  const changes = { LLM_PROVIDER: "custom", LLM_BASE_URL: "https://example.invalid/v1", LLM_MODEL: "test", LLM_API_KEY: key };
  const previous = Object.fromEntries(Object.keys(changes).map(name => [name, process.env[name]]));
  Object.assign(process.env, changes);
  const restoreProvider = installFixtureProvider();
  let live: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const options = { ...config(), dataDir: root, logDir, port: 0, cooldown: 0 };
    live = await startServer(options);
    const base = `http://127.0.0.1:${live.server.port}`;
    const entry = { event: "ui.error", route: "/", clientTime: Date.now(), message: `render failed: ${key}` };
    expect((await fetch(base + "/api/client-logs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: [entry] }) })).status).toBe(401);
    const session = await fetch(base + "/api/session"), cookie = session.headers.get("set-cookie")!.split(";")[0];
    const send = (path: string, method = "GET", data?: unknown) => fetch(base + path, { method, headers: { Cookie: cookie, "Content-Type": "application/json", "X-Request-Id": "log-request-294" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const invalid = await send("/api/tasks", "POST", {});
    expect(invalid.status).toBe(422); expect(invalid.headers.get("x-request-id")).toBe("log-request-294");
    expect((await send("/api/client-logs", "POST", { entries: [{ ...entry, apiKey: key }] })).status).toBe(422);
    expect((await send("/api/client-logs", "POST", { entries: [entry] })).status).toBe(200);
    for (const [intent, request] of [["verification", "验证当前报告"], ["explain", `公开对话\n${key}`]]) {
      const task = await (await send("/api/tasks", "POST", { request, requestId: crypto.randomUUID(), intent })).json() as Task;
      const deadline = Date.now() + 2500;
      while (["queued", "running"].includes(live.app.store.task(task.id)!.status) && Date.now() < deadline) await Bun.sleep(10);
      expect(live.app.store.task(task.id)?.status).toBe(intent === "verification" ? "failed" : "completed");
    }
    const dialogs = records(logDir, "conversations"), operations = records(logDir, "operations");
    expect(dialogs.filter(entry => entry.event === "user.message")).toHaveLength(2);
    expect(dialogs.some(entry => entry.event === "assistant.message" && entry.content.includes("VECTRA"))).toBeTrue();
    expect(dialogs.some(entry => entry.event === "task.failed" && entry.level === "error")).toBeTrue();
    expect(dialogs.filter(entry => entry.event === "step.created").every(entry => entry.requestId && entry.mode && entry.intent)).toBeTrue();
    expect(operations.some(entry => entry.event === "task.execution_failed" && entry.error.code === "report_missing")).toBeTrue();
    expect(operations.some(entry => entry.event === "http.error" && entry.requestId === "log-request-294")).toBeTrue();
    expect(operations.some(entry => entry.event === "client.ui.error" && entry.message.includes("[REDACTED]"))).toBeTrue();
    expect(JSON.stringify([dialogs, operations])).not.toContain(key);
    expect(JSON.stringify([dialogs, operations])).not.toContain(cookie.split("=")[1]);
    await live.close(); live = await startServer(options);
    expect(records(logDir, "conversations")).toHaveLength(dialogs.length);
    expect(records(logDir, "operations").filter(entry => entry.event === "logs.history_replayed").at(-1).replayed).toBe(0);
    await live.close();
    const exported = join(root, "replayed-logs");
    live = await startServer({ ...options, logDir: exported });
    expect(records(exported, "conversations")).toHaveLength(dialogs.length);
    expect(records(exported, "conversations").every(entry => entry.backfill)).toBeTrue();
  } finally {
    await live?.close();
    restoreProvider();
    for (const name of Object.keys(changes)) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    rmSync(root, { recursive: true, force: true });
  }
});
