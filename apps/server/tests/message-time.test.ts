import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Task } from "@vectra/shared";
import { Store } from "../src/store";
import { messageTime } from "../../web/src/message-time";

test("message times show Shanghai milliseconds and retain legitimately simultaneous or missing times", () => {
  const instant = Date.UTC(2026, 9, 23, 2, 30, 28, 101);
  expect(messageTime(instant)?.text).toContain("10:30:28.101");
  expect(messageTime(instant + 1)?.text).toContain("10:30:28.102");
  expect(messageTime(instant)?.full).toBe("2026-10-23T10:30:28.101+08:00");
  expect(messageTime(instant)).toEqual(messageTime(instant));
  for (const value of [undefined, NaN, Infinity, 1e20]) expect(messageTime(value)).toBeUndefined();
});

test("step starts stay immutable while artifact and completion times follow actual save operations and replay", () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-message-time-"));
  let clock = Date.UTC(2026, 9, 23, 2, 30, 28, 101);
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  let store: Store | undefined;
  try {
    store = new Store(root);
    const task = store.create({ request: "解释本轮流程", requestId: randomUUID(), intent: "explain" }, "llm").task;
    clock += 5; store.update(task.id, { status: "running" });
    const start = clock;
    const first = store.step(task.id, { agent: "coordinator", action: "模型请求", kind: "model", detail: "开始", status: "running" });
    clock += 1500;
    const finished = store.step(task.id, { ...first, at: 123, status: "completed", detail: "结束" });
    expect(finished.at).toBe(start); expect(finished.updatedAt).toBe(clock);
    const a = store.step(task.id, { agent: "coordinator", action: "同刻记录一", kind: "analysis", detail: "一" });
    const b = store.step(task.id, { agent: "coordinator", action: "同刻记录二", kind: "analysis", detail: "二" });
    expect(a.at).toBe(b.at);
    clock += 7;
    store.update(task.id, { result: { road: "S101", windowSeconds: 60, participantCount: 3, protocol: "Shamir" } });
    const resultAt = clock;
    clock += 29;
    store.update(task.id, { analysis: { facts: [], possibleCauses: [], recommendations: [], uncertainties: [], evidenceIds: [] } });
    const analysisAt = clock;
    clock += 13;
    store.update(task.id, { verification: { valid: true, reason: "fixture" } });
    const verificationAt = clock;
    clock += 41;
    store.update(task.id, { status: "completed", summary: "本轮说明" }, "task.completed");
    const timestamps = { startedAt: start, resultAt, analysisAt, verificationAt, summaryAt: clock, finishedAt: clock };
    expect(store.task(task.id)?.timestamps).toEqual(timestamps);
    expect(store.events(0).findLast(event => event.type === "task.completed")?.payload.task).toMatchObject({ timestamps });
    clock += 100;
    store.update(task.id, { model: "updated-label" });
    expect(store.task(task.id)?.timestamps).toEqual(timestamps);
    store.close(); store = new Store(root);
    expect(store.task(task.id)?.timestamps).toEqual(timestamps);
    expect(store.task(task.id)?.steps[0].at).toBe(start);
  } finally { store?.close(); now.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("old artifact times come from recorded events without changing stored history or inventing missing dates", () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-historical-time-"));
  let clock = Date.UTC(2026, 9, 23, 2, 30, 28, 101);
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  let store: Store | undefined;
  try {
    store = new Store(root);
    const task = store.create({ request: "解释历史记录", requestId: randomUUID(), intent: "explain" }, "llm").task;
    clock += 5; store.update(task.id, { status: "running" });
    const startedAt = clock;
    clock += 7; store.update(task.id, { analysis: { facts: [], possibleCauses: [], recommendations: [], uncertainties: [], evidenceIds: [] } });
    const analysisAt = clock;
    clock += 11; store.update(task.id, { status: "completed", summary: "历史说明" }, "task.completed");
    const finishedAt = clock;
    const saved = store.db.query<{ body: string }, [string]>("SELECT body FROM tasks WHERE id=?").get(task.id)!;
    const historical = JSON.parse(saved.body) as Task;
    delete historical.timestamps;
    const originalBody = JSON.stringify(historical);
    store.db.query("UPDATE tasks SET body=? WHERE id=?").run(originalBody, task.id);
    const before = JSON.stringify(store.events(0));
    clock += 1000;
    expect(store.task(task.id)?.timestamps).toEqual({ startedAt, analysisAt, summaryAt: finishedAt, finishedAt });
    expect(store.tasks()[0].timestamps?.analysisAt).toBe(analysisAt);
    expect(store.task(task.id)?.timestamps?.resultAt).toBeUndefined();
    expect(store.db.query<{ body: string }, [string]>("SELECT body FROM tasks WHERE id=?").get(task.id)?.body).toBe(originalBody);
    expect(JSON.stringify(store.events(0))).toBe(before);
  } finally { store?.close(); now.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
