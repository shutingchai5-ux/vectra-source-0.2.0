import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { error, planTask, type Conversation, type ConversationDeletion, type CreateTask, type Message, type PublicEvent, type Step, type Task, type TaskSummary, type TaskTimestamps, type JsonObject } from "@vectra/shared";
import { canonical, hash } from "./security";

export class Store {
  readonly db: Database;
  private listeners = new Set<(event: PublicEvent) => void>();
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new Database(join(root, "vectra.sqlite3"), { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),request_id TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks(conversation_id,created_at);
      CREATE TABLE IF NOT EXISTS deleted_conversations(id TEXT PRIMARY KEY,deleted_at INTEGER NOT NULL,task_count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deleted_requests(request_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES deleted_conversations(id),task_id TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),task_id TEXT NOT NULL REFERENCES tasks(id),role TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
      CREATE TABLE IF NOT EXISTS steps(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),position INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS steps_task ON steps(task_id,position);
      CREATE TABLE IF NOT EXISTS protocol_materials(step_id TEXT PRIMARY KEY REFERENCES steps(id),task_id TEXT NOT NULL REFERENCES tasks(id),envelope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,task_id TEXT,conversation_id TEXT,at INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id,id);
      CREATE TRIGGER IF NOT EXISTS immutable_events_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_events_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
      CREATE TABLE IF NOT EXISTS reports(task_id TEXT PRIMARY KEY REFERENCES tasks(id),envelope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replay(message_id TEXT PRIMARY KEY,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS budgets(principal TEXT PRIMARY KEY,last_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_audit_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_audit_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
      PRAGMA user_version=2;`);
    // No automatic replay of computation/signing after a process restart.
    const pending = this.db.query<{ id: string }, []>("SELECT id FROM tasks WHERE status IN ('queued','running')").all();
    for (const { id } of pending) {
      const task = this.task(id)!;
      for (const step of task.steps.filter(s => s.status === "running" || s.status === "queued")) this.step(id, { ...step, status: "failed", detail: `${step.detail}\n服务重启，此步骤未完成。` });
      this.update(id, { status: "failed", error: { code: "service_restarted", message: "服务已重启，未完成任务已停止；历史记录保留。" } }, "task.failed");
    }
  }
  subscribe(listener: (event: PublicEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private event(type: string, taskId: string | null, conversationId: string | null, payload: JsonObject): PublicEvent {
    const at = Date.now();
    const row = this.db.query<{ id: number }, [string, string | null, string | null, number, string]>("INSERT INTO events(type,task_id,conversation_id,at,payload) VALUES(?,?,?,?,?) RETURNING id").get(type, taskId, conversationId, at, canonical(payload))!;
    return { id: row.id, type, taskId, conversationId, at, payload };
  }
  private emit(event: PublicEvent) { for (const listener of this.listeners) { try { listener(event); } catch { /* One disconnected viewer must not fail a task. */ } } }
  cursor() { return this.db.query<{ id: number }, []>("SELECT COALESCE(MAX(id),0) id FROM events").get()!.id; }
  events(after: number, limit = 256): PublicEvent[] {
    return this.db.query<{ id: number; type: string; task_id: string | null; conversation_id: string | null; at: number; payload: string }, [number, number]>("SELECT * FROM events WHERE id>? AND (type='conversation.deleted' OR conversation_id IS NULL OR NOT EXISTS (SELECT 1 FROM deleted_conversations WHERE deleted_conversations.id=events.conversation_id)) ORDER BY id LIMIT ?").all(after, limit)
      .map(row => ({ id: row.id, type: row.type, taskId: row.task_id, conversationId: row.conversation_id, at: row.at, payload: JSON.parse(row.payload) }));
  }
  conversations(): Conversation[] { return this.db.query<{ id: string; title: string; created_at: number; updated_at: number }, []>("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100").all().map(row => ({ id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at })); }
  conversation(id: string): Conversation | undefined {
    const row = this.db.query<{ id: string; title: string; created_at: number; updated_at: number }, [string]>("SELECT * FROM conversations WHERE id=?").get(id);
    return row ? { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }
  conversationDeleted(id: string) { return Boolean(this.db.query("SELECT id FROM deleted_conversations WHERE id=?").get(id)); }
  conversationTaskIds(id: string): string[] { return this.db.query<{ id: string }, [string]>("SELECT id FROM tasks WHERE conversation_id=?").all(id).map(row => row.id); }
  deleteConversation(id: string): ConversationDeletion {
    const outcome = this.db.transaction(() => {
      const previous = this.db.query<{ task_count: number }, [string]>("SELECT task_count FROM deleted_conversations WHERE id=?").get(id);
      if (previous) return { result: { conversationId: id, deleted: true, deletedTaskCount: previous.task_count, taskIds: this.db.query<{ task_id: string }, [string]>("SELECT task_id FROM deleted_requests WHERE conversation_id=?").all(id).map(row => row.task_id), alreadyDeleted: true } as ConversationDeletion, event: undefined };
      if (!this.conversation(id)) throw error("conversation_missing", "对话不存在。", 404);
      if (this.db.query("SELECT id FROM tasks WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1").get(id)) throw error("conversation_busy", "请等待本轮任务停止后再删除对话。", 409);
      const taskIds = this.conversationTaskIds(id), taskCount = taskIds.length;
      this.db.query("INSERT INTO deleted_conversations VALUES(?,?,?)").run(id, Date.now(), taskCount);
      // Keep request IDs reserved so an old retried POST cannot recreate a deleted task.
      this.db.query("INSERT INTO deleted_requests SELECT request_id,conversation_id,id FROM tasks WHERE conversation_id=?").run(id);
      this.db.query("DELETE FROM protocol_materials WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id=?)").run(id);
      this.db.query("DELETE FROM steps WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id=?)").run(id);
      this.db.query("DELETE FROM reports WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id=?)").run(id);
      this.db.query("DELETE FROM messages WHERE conversation_id=?").run(id);
      this.db.query("DELETE FROM tasks WHERE conversation_id=?").run(id);
      this.db.query("DELETE FROM conversations WHERE id=?").run(id);
      const result: ConversationDeletion = { conversationId: id, deleted: true, deletedTaskCount: taskCount, taskIds, alreadyDeleted: false };
      return { result, event: this.event("conversation.deleted", null, id, { deletedTaskCount: taskCount, taskIds }) };
    }).immediate();
    if (outcome.event) this.emit(outcome.event);
    return outcome.result;
  }
  create(input: CreateTask, mode: "llm", model?: string): { task: Task; created: boolean } {
    let event: PublicEvent | null = null;
    const result = this.db.transaction(() => {
      if ((input.conversationId && this.conversationDeleted(input.conversationId)) || this.db.query("SELECT request_id FROM deleted_requests WHERE request_id=?").get(input.requestId)) throw error("conversation_deleted", "此对话或请求已被删除，请开始新对话。", 410);
      const digest = hash({ request: input.request, intent: input.intent ?? "auto", conversationId: input.conversationId ?? null });
      const existing = this.db.query<{ id: string; digest: string }, [string]>("SELECT id,digest FROM tasks WHERE request_id=?").get(input.requestId);
      if (existing) {
        if (existing.digest !== digest) throw error("idempotency_conflict", "相同请求 ID 已绑定不同内容。", 409);
        return { task: this.task(existing.id)!, created: false };
      }
      if (this.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM tasks WHERE status IN ('queued','running')").get()!.n >= 8) throw error("queue_full", "任务队列已满，请稍后重试。", 429);
      const now = Date.now(), conversationId = input.conversationId ?? randomUUID();
      if (input.conversationId && !this.db.query("SELECT id FROM conversations WHERE id=?").get(conversationId)) throw error("conversation_missing", "会话不存在。", 404);
      if (!input.conversationId) this.db.query("INSERT INTO conversations VALUES(?,?,?,?)").run(conversationId, input.request.slice(0, 48), now, now);
      const task: Task = { id: randomUUID(), conversationId, requestId: input.requestId, request: input.request, status: "queued", createdAt: now, updatedAt: now, plan: planTask(input.request, input.intent), mode, summary: "", steps: [], timestamps: {}, ...(model ? { model } : {}) };
      const { steps, ...body } = task;
      this.db.query("INSERT INTO tasks VALUES(?,?,?,?,?,?,?)").run(task.id, conversationId, input.requestId, digest, task.status, now, canonical(body));
      const message: Message = { id: randomUUID(), conversationId, taskId: task.id, role: "user", content: input.request, createdAt: now };
      this.db.query("INSERT INTO messages VALUES(?,?,?,?,?,?)").run(message.id, conversationId, task.id, message.role, message.content, now);
      this.db.query("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
      event = this.event("task.created", task.id, conversationId, { task: this.summary(task), message, conversation: this.conversation(conversationId) });
      return { task, created: true };
    }).immediate();
    if (event) this.emit(event); return result;
  }
  task(id: string): Task | undefined {
    const row = this.db.query<{ body: string }, [string]>("SELECT body FROM tasks WHERE id=?").get(id);
    if (!row) return;
    const steps = this.db.query<{ body: string }, [string]>("SELECT body FROM steps WHERE task_id=? ORDER BY position").all(id).map(s => JSON.parse(s.body) as Step);
    const task = JSON.parse(row.body) as Task;
    return { ...task, timestamps: task.timestamps ?? this.recordedTimestamps(id), steps };
  }
  private recordedTimestamps(id: string): TaskTimestamps {
    // Older tasks have no artifact timestamps. Recover actual notification times without rewriting history.
    const row = this.db.query<Record<keyof TaskTimestamps, number | null>, [string]>(`SELECT
      MIN(CASE WHEN json_extract(payload,'$.task.status')='running' THEN at END) startedAt,
      MIN(CASE WHEN json_type(payload,'$.task.result')='object' THEN at END) resultAt,
      MIN(CASE WHEN json_type(payload,'$.task.analysis')='object' THEN at END) analysisAt,
      MIN(CASE WHEN json_type(payload,'$.task.verification')='object' THEN at END) verificationAt,
      MIN(CASE WHEN length(json_extract(payload,'$.task.summary'))>0 THEN at END) summaryAt,
      MIN(CASE WHEN json_extract(payload,'$.task.status') IN ('completed','failed','cancelled') THEN at END) finishedAt
      FROM events WHERE task_id=?`).get(id);
    return Object.fromEntries(Object.entries(row ?? {}).filter(([, value]) => typeof value === "number")) as TaskTimestamps;
  }
  summary(task: Task): TaskSummary {
    const { steps, report, ...rest } = task;
    return { ...rest, stepCount: steps.length, hasReport: Boolean(this.db.query("SELECT task_id FROM reports WHERE task_id=?").get(task.id)) };
  }
  tasks(conversationId?: string, offset = 0): TaskSummary[] {
    const sql = conversationId ? "SELECT body FROM tasks WHERE conversation_id=? ORDER BY created_at LIMIT 50 OFFSET ?" : "SELECT body FROM tasks ORDER BY created_at DESC LIMIT 50 OFFSET ?";
    const rows = this.db.query<{ body: string }, any[]>(sql).all(...(conversationId ? [conversationId, offset] : [offset]));
    return rows.map(row => {
      const body = JSON.parse(row.body);
      const stepCount = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM steps WHERE task_id=?").get(body.id)!.n;
      return { ...body, timestamps: body.timestamps ?? this.recordedTimestamps(body.id), stepCount, hasReport: Boolean(this.db.query("SELECT task_id FROM reports WHERE task_id=?").get(body.id)) };
    });
  }
  messages(conversationId: string, limit = 40): Message[] {
    return this.db.query<{ id: string; conversation_id: string; task_id: string; role: "user" | "assistant"; content: string; created_at: number }, [string, number]>("SELECT * FROM (SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at").all(conversationId, limit)
      .map(row => ({ id: row.id, conversationId: row.conversation_id, taskId: row.task_id, role: row.role, content: row.content, createdAt: row.created_at }));
  }
  update(id: string, values: Partial<Omit<Task, "id" | "steps" | "timestamps">>, type = "task.updated", reportBox?: JsonObject) {
    const result = this.db.transaction(() => {
      const task = this.task(id); if (!task) throw error("task_missing", "任务不存在。", 404);
      const now = Date.now(), timestamps = { ...task.timestamps };
      if (values.status === "running" && task.status !== "running") timestamps.startedAt ??= now;
      for (const [field, timestamp] of [["result", "resultAt"], ["analysis", "analysisAt"], ["verification", "verificationAt"]] as const) if (values[field] !== undefined) timestamps[timestamp] = now;
      if (values.summary?.trim()) timestamps.summaryAt = now;
      if (values.status && ["completed", "failed", "cancelled"].includes(values.status) && task.status !== values.status) timestamps.finishedAt = now;
      const { steps, ...data } = { ...task, ...values, timestamps, updatedAt: now };
      this.db.query("UPDATE tasks SET status=?,body=? WHERE id=?").run(data.status, canonical(data), id);
      if (reportBox) this.report(id, reportBox);
      if (["completed", "failed", "cancelled"].includes(data.status) && data.summary) {
        const messageId = `assistant-${id}`;
        this.db.query("INSERT INTO messages VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content").run(messageId, data.conversationId, id, "assistant", data.summary, data.updatedAt);
      }
      this.db.query("UPDATE conversations SET updated_at=? WHERE id=?").run(data.updatedAt, data.conversationId);
      return this.event(type, id, data.conversationId, { task: this.summary({ ...data, steps }) });
    }).immediate();
    this.emit(result); return this.task(id)!;
  }
  step(taskId: string, data: Partial<Step> & Pick<Step, "agent" | "action" | "detail" | "kind">, privateBox?: JsonObject) {
    const result = this.db.transaction(() => {
      const task = this.db.query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM tasks WHERE id=?").get(taskId);
      if (!task) throw error("task_missing", "任务不存在。", 404);
      const now = Date.now(), id = data.id ?? randomUUID();
      const old = this.db.query<{ task_id: string; position: number; body: string }, [string]>("SELECT task_id,position,body FROM steps WHERE id=?").get(id);
      if (old && old.task_id !== taskId) throw error("step_binding", "步骤 ID 已绑定其他任务。", 409);
      const previous: Step | undefined = old ? JSON.parse(old.body) : undefined;
      const position = old?.position ?? this.db.query<{ n: number }, [string]>("SELECT COALESCE(MAX(position),-1)+1 n FROM steps WHERE task_id=?").get(taskId)!.n;
      const step: Step = { id, taskId, status: "completed", metadata: {}, evidenceIds: [], ...previous, ...data, at: previous?.at ?? now, updatedAt: now };
      this.db.query("INSERT INTO steps VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(id, taskId, position, canonical(step));
      if (privateBox) this.db.query("INSERT INTO protocol_materials VALUES(?,?,?) ON CONFLICT(step_id) DO UPDATE SET envelope=excluded.envelope").run(id, taskId, canonical(privateBox));
      return { step, event: this.event(previous ? "step.updated" : "step.created", taskId, task.conversation_id, { step }) };
    }).immediate();
    this.emit(result.event); return result.step;
  }
  protocolMaterials(taskId: string, stepId: string): JsonObject | undefined {
    const row = this.db.query<{ envelope: string }, [string, string]>("SELECT envelope FROM protocol_materials WHERE task_id=? AND step_id=?").get(taskId, stepId);
    return row ? JSON.parse(row.envelope) : undefined;
  }
  delta(taskId: string, text: string) {
    const task = this.task(taskId)!;
    const event = this.event("assistant.delta", taskId, task.conversationId, { text }); this.emit(event);
  }
  report(taskId: string, box?: JsonObject): JsonObject | undefined {
    if (box) this.db.query("INSERT INTO reports VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET envelope=excluded.envelope").run(taskId, canonical(box));
    const row = this.db.query<{ envelope: string }, [string]>("SELECT envelope FROM reports WHERE task_id=?").get(taskId); return row ? JSON.parse(row.envelope) : undefined;
  }
  acceptMessage(id: string) {
    try { this.db.query("INSERT INTO replay VALUES(?,?)").run(id, Date.now()); }
    catch { throw error("replay_rejected", "该认证消息已被接收，拒绝重放。", 403); }
  }
  reserveBudget(cooldown: number) {
    this.db.transaction(() => {
      const row = this.db.query<{ last_at: number }, []>("SELECT last_at FROM budgets WHERE principal='local-user'").get();
      if (row && Date.now() - row.last_at < cooldown * 1000) throw error("query_budget", "当前处于隐私查询冷却时间。", 429);
      this.db.query("INSERT INTO budgets VALUES('local-user',?) ON CONFLICT(principal) DO UPDATE SET last_at=excluded.last_at").run(Date.now());
    }).immediate();
  }
  close() { this.listeners.clear(); this.db.close(); }
}
