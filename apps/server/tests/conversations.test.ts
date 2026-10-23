import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { config } from "../src/config";
import { startServer } from "../src/index";
import { configureFixture, fixtureProviderReply } from "./fixtures";

test("deleting a conversation cancels its jobs, removes associated data, preserves audit and cannot be undone by replay or retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-conversation-test-")), original = globalThis.fetch;
  const options = { ...config(), dataDir: root, logDir: join(root, "logs"), port: 0, cooldown: 0 };
  let live: Awaited<ReturnType<typeof startServer>> | undefined;
  let providerStarted = false, stallProvider = false;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!String(input).startsWith("https://example.invalid/")) return original(input, init);
    if (!stallProvider) return fixtureProviderReply(JSON.parse(String(init?.body)));
    providerStarted = true;
    return new Promise<Response>((_resolve, reject) => {
      const stop = () => reject(new DOMException("Aborted", "AbortError"));
      if (init?.signal?.aborted) stop(); else init?.signal?.addEventListener("abort", stop, { once: true });
    });
  }, { preconnect: original.preconnect }) as typeof fetch;
  try {
    live = await startServer(options);
    configureFixture(live.app);
    const wait = async (id: string) => { const until = Date.now() + 3000; while (["queued", "running"].includes(live!.app.store.task(id)!.status) && Date.now() < until) await Bun.sleep(10); };
    const requestId = randomUUID(), first = live.app.submit({ request: "介绍协作流程", requestId, intent: "explain" });
    await wait(first.id);
    expect(live.app.store.task(first.id)?.status).toBe("completed"); expect(live.app.store.report(first.id)).toBeDefined();
    const materialStep = live.app.store.task(first.id)!.steps.find(step => step.hasPrivateDetails)!;
    expect(materialStep).toBeDefined();
    const other = live.app.submit({ request: "保留的另一段对话", requestId: randomUUID(), intent: "explain" }); await wait(other.id);
    live.app.settings.save({ mode: "llm", provider: "custom", baseUrl: "https://example.invalid/v1", model: "test", apiKey: "conversation-test-key" });
    stallProvider = true;
    const active = live.app.submit({ request: "等待模型", requestId: randomUUID(), conversationId: first.conversationId, intent: "explain" });
    const until = Date.now() + 1500; while (!providerStarted && Date.now() < until) await Bun.sleep(10);
    expect(providerStarted).toBeTrue();
    const queued = live.app.submit({ request: "排队的消息", requestId: randomUUID(), conversationId: first.conversationId, intent: "explain" });
    expect(live.app.store.task(queued.id)?.status).toBe("queued");
    const base = `http://127.0.0.1:${live.server.port}`, path = `/api/conversations/${first.conversationId}`;
    expect((await original(base + path, { method: "DELETE" })).status).toBe(401);
    const session = await original(base + "/api/session"), cookie = session.headers.get("set-cookie")!.split(";")[0];
    const send = (url: string, method = "GET", extra: Record<string, string> = {}) => original(base + url, { method, headers: { Cookie: cookie, ...extra } });
    expect((await send(path, "DELETE", { Origin: "https://attacker.invalid" })).status).toBe(403);
    const response = await send(path, "DELETE"), deleted = await response.json();
    expect(response.status).toBe(200); expect(deleted.deletedTaskCount).toBe(3);
    expect(new Set(deleted.taskIds)).toEqual(new Set([first.id, active.id, queued.id]));
    expect((await (await send(path, "DELETE")).json()).alreadyDeleted).toBeTrue();
    expect((await send(path)).status).toBe(404); expect((await send(`/api/tasks/${active.id}`)).status).toBe(404);
    expect((await send(`/api/reports/${first.id}`)).status).toBe(404);
    expect((await send(`/api/tasks/${first.id}/steps/${materialStep.id}/materials`)).status).toBe(404);
    for (const table of ["messages", "tasks", "steps", "reports", "protocol_materials"]) {
      const remaining = live.app.store.db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n;
      expect(remaining).toBe(table === "messages" ? 2 : table === "tasks" || table === "reports" ? 1 : live.app.store.db.query<{ n: number }, [string]>(`SELECT COUNT(*) n FROM ${table} WHERE task_id=?`).get(other.id)!.n);
    }
    const events = live.app.store.events(0, 1000);
    expect(events.filter(event => event.conversationId === first.conversationId).every(event => event.type === "conversation.deleted")).toBeTrue();
    expect(events.some(event => event.type === "conversation.deleted")).toBeTrue();
    expect(live.app.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM events WHERE conversation_id=? AND type='task.created'").get(first.conversationId)!.n).toBe(3);
    expect(live.app.audit.verify().valid).toBeTrue(); expect(live.app.store.task(other.id)?.status).toBe("completed");
    expect(() => live!.app.submit({ request: "介绍协作流程", requestId, intent: "explain" })).toThrow("已被删除");
    expect(() => live!.app.submit({ request: "继续", requestId: randomUUID(), conversationId: first.conversationId })).toThrow("已被删除");
    await live.close(); live = await startServer(options);
    expect(live.app.store.conversation(first.conversationId)).toBeUndefined(); expect(live.app.store.conversation(other.conversationId)).toBeDefined();
    expect(live.app.store.events(0, 1000).filter(event => event.conversationId === first.conversationId).every(event => event.type === "conversation.deleted")).toBeTrue();
    expect(live.app.audit.verify().valid).toBeTrue();
    stallProvider = false;
    const computing = live.app.submit({ request: "统计 S101 平均速度", requestId: randomUUID(), intent: "statistics" });
    const startedBy = Date.now() + 3000;
    while (!live.app.store.task(computing.id)!.steps.some(step => step.action === "三方秘密分享计算") && Date.now() < startedBy) await Bun.sleep(5);
    expect(live.app.store.task(computing.id)!.steps.some(step => step.action === "三方秘密分享计算")).toBeTrue();
    await live.app.deleteConversation(computing.conversationId);
    expect(live.app.store.task(computing.id)).toBeUndefined();
    const next = live.app.submit({ request: "再次统计 S101 平均速度", requestId: randomUUID(), intent: "statistics" }); await wait(next.id);
    expect(live.app.store.task(next.id)?.result?.averageSpeed).toBe(40);
  } finally { await live?.close(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
}, 15000);
