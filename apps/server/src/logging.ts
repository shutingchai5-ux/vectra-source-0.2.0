import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeLogValue, shanghaiDay, shanghaiTimestamp, TIME_ZONE, type JsonObject, type PublicEvent, type Step, type TaskSummary, type Message, type Task } from "@vectra/shared";

export type LogLevel = "info" | "warn" | "error";
export interface EventHistory {
  root: string;
  cursor(): number;
  events(after: number): PublicEvent[];
  subscribe(listener: (event: PublicEvent) => void): () => void;
  task?(id: string): Task | undefined;
}

export class Diagnostics {
  readonly runId = randomUUID();
  readonly root: string;
  private secrets = new Set<string>();
  private warned = false;
  constructor(root: string) {
    this.root = resolve(root);
    for (const [name, value] of Object.entries(process.env)) if (/key|secret|token|password|credential/i.test(name)) this.remember(value);
  }
  remember(...values: (string | undefined)[]) { for (const value of values) if (value && value.length >= 4) this.secrets.add(value); }
  private unavailable(cause: unknown) {
    if (this.warned) return;
    this.warned = true;
    const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code).replace(/[^A-Z0-9_]/gi, "").slice(0, 40) : "WRITE_FAILED";
    console.error(`[VECTRA] 诊断日志写入失败（${code}），请检查日志目录和磁盘空间。`);
  }
  private write(channel: "conversations" | "operations", event: string, details: JsonObject, level: LogLevel, at = Date.now()) {
    try {
      const time = new Date(Number.isFinite(at) ? at : Date.now());
      const folder = join(this.root, channel);
      mkdirSync(folder, { recursive: true });
      const record = sanitizeLogValue({ ...details, schemaVersion: 1, timestamp: shanghaiTimestamp(time), timeZone: TIME_ZONE, level, event, runId: this.runId }, [...this.secrets]);
      appendFileSync(join(folder, `${shanghaiDay(time)}.jsonl`), JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
      return true;
    } catch (cause) { this.unavailable(cause); return false; }
  }
  operation(event: string, details: JsonObject = {}, level: LogLevel = "info", at?: number) { return this.write("operations", event, details, level, at); }
  conversation(event: string, details: JsonObject, at?: number) { return this.write("conversations", event, details, event === "task.failed" ? "error" : event === "task.cancelled" ? "warn" : "info", at); }

  /** Subscribe before replay; the cursor is diagnostic metadata, separate from business data. */
  follow(history: EventHistory, sourceId: string) {
    const checkpoint = join(history.root, "diagnostic-log-cursor.json");
    let cursor = 0, gap = false, replayed = 0;
    try {
      const saved = JSON.parse(readFileSync(checkpoint, "utf8"));
      if (saved.sourceId === sourceId && saved.logDir === this.root && Number.isSafeInteger(saved.eventId) && saved.eventId >= 0 && saved.eventId <= history.cursor()
        && /^\d{4}-\d{2}-\d{2}$/.test(saved.day) && existsSync(join(this.root, "conversations", `${saved.day}.jsonl`))) cursor = saved.eventId;
    } catch { /* A missing/invalid cursor replays public history; event IDs allow deduplication. */ }
    const after = cursor;
    const taskContexts = new Map<string, JsonObject>();
    const capture = (event: PublicEvent, backfill = false) => {
      if (event.id <= cursor) return;
      const task = event.payload.task as TaskSummary | undefined;
      const step = event.payload.step as Step | undefined;
      const message = event.payload.message as Message | undefined;
      if (event.taskId && !taskContexts.has(event.taskId)) {
        const identity = task ?? history.task?.(event.taskId);
        if (identity) taskContexts.set(event.taskId, { requestId: identity.requestId, mode: identity.mode, model: identity.model, intent: identity.plan.intent });
        // Bound diagnostic-only cache; business history remains in SQLite.
        if (taskContexts.size > 1000) taskContexts.delete(taskContexts.keys().next().value!);
      }
      const context: JsonObject = { sourceId, eventId: event.id, conversationId: event.conversationId, taskId: event.taskId, backfill,
        ...(event.taskId ? taskContexts.get(event.taskId) : {}) };
      const detail: JsonObject = message ? { role: message.role, content: message.content, messageId: message.id }
        : step ? { step }
        : task ? { status: task.status, ...(task.summary ? { role: "assistant", content: task.summary } : {}),
          ...(task.result ? { result: task.result } : {}), ...(task.analysis ? { analysis: task.analysis } : {}), ...(task.error ? { error: task.error } : {}) }
        : event.type === "conversation.deleted" ? { deletedTaskCount: event.payload.deletedTaskCount } : { content: event.payload.text };
      const name = message ? "user.message" : event.type === "task.completed" ? "assistant.message" : event.type;
      const written = this.conversation(name, { ...context, ...detail }, event.at);
      let operationWritten = true;
      if (/^task\.(?:created|started|completed|failed|cancelled)$/.test(event.type)) {
        operationWritten = this.operation(event.type, { ...context, status: task?.status, durationMs: task ? Math.max(0, event.at - task.createdAt) : undefined, error: task?.error }, event.type === "task.failed" ? "error" : "info", event.at);
      }
      cursor = event.id;
      if (!written || !operationWritten) gap = true;
      if (!gap) {
        try {
          const temporary = checkpoint + `.${this.runId}.tmp`;
          writeFileSync(temporary, JSON.stringify({ sourceId, logDir: this.root, eventId: cursor, day: shanghaiDay(event.at) }), { mode: 0o600 });
          renameSync(temporary, checkpoint);
        } catch (cause) { gap = true; this.unavailable(cause); }
      }
      if (backfill) replayed++;
    };
    const unsubscribe = history.subscribe(event => capture(event));
    let batch: PublicEvent[];
    do { batch = history.events(cursor); for (const event of batch) capture(event, true); } while (batch.length === 256);
    this.operation("logs.history_replayed", { sourceId, after, through: cursor, replayed });
    return { unsubscribe, replayed, cursor };
  }
}
