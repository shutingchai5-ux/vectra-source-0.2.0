import { defineStore } from "pinia";
import { computed, ref, reactive, watch } from "vue";
import { Schema } from "effect";
import { error, type Analysis, type AuditEvent, type Conversation, type ConversationDeletion, type CreateTask, type Message, type Overview, type PublicEvent, type PublicModelSettings, type Step, type Task, type TaskSummary } from "@vectra/shared";
import { api } from "../api";
import { recordClient } from "../diagnostics";

const EventSchema = Schema.Struct({ id: Schema.Number, type: Schema.String, taskId: Schema.NullOr(Schema.String), conversationId: Schema.NullOr(Schema.String), at: Schema.Number, payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }) });
export const useWorkspace = defineStore("workspace", () => {
  const overview = ref<Overview | null>(null), conversations = ref<Conversation[]>([]), selectedId = ref<string | null>(localStorage.getItem("vectra.conversation"));
  const tasks = reactive<Record<string, Task>>({}), messages = ref<Message[]>([]), modelSettings = ref<PublicModelSettings | null>(null);
  const connection = ref<"connecting" | "live" | "reconnecting">("connecting"), errorMessage = ref(""), busy = ref(false), loadingConversation = ref(false), revision = ref(0), cursor = ref(0);
  let source: EventSource | null = null, reconnectTimer: ReturnType<typeof setTimeout> | null = null, initialized = false;
  const selectionVersion = ref(0);
  const deletedConversations = new Set<string>(), deletingConversations = reactive(new Set<string>()), deletedTaskIds = reactive(new Set<string>());
  let replaying = false;
  const currentTasks = computed(() => Object.values(tasks).filter(task => task.conversationId === selectedId.value).sort((a, b) => a.createdAt - b.createdAt));
  const working = computed(() => currentTasks.value.some(task => task.status === "queued" || task.status === "running"));
  const sortedConversations = computed(() => [...conversations.value].sort((a, b) => b.updatedAt - a.updatedAt));
  watch(connection, state => recordClient("connection.changed", { state }));
  function fail(cause: unknown) { errorMessage.value = cause instanceof Error ? cause.message : "操作失败。"; }
  function summary(value: TaskSummary) {
    if (deletedConversations.has(value.conversationId)) return;
    const old = tasks[value.id];
    if (!old) tasks[value.id] = { ...value, steps: [] };
    else if (value.updatedAt >= old.updatedAt) Object.assign(old, value);
  }
  function apply(event: PublicEvent) {
    if (event.id <= cursor.value) return;
    cursor.value = event.id;
    if (event.type === "conversation.deleted" && event.conversationId) { forgetConversation(event.conversationId, Array.isArray(event.payload.taskIds) ? event.payload.taskIds.filter((id): id is string => typeof id === "string") : []); return; }
    if (event.conversationId && deletedConversations.has(event.conversationId)) return;
    if (event.payload.task) summary(event.payload.task as TaskSummary);
    if (event.payload.step) {
      const step = event.payload.step as Step, task = tasks[step.taskId];
      if (task) { const index = task.steps.findIndex(item => item.id === step.id); if (index < 0) task.steps.push(step); else if (step.updatedAt >= task.steps[index].updatedAt) Object.assign(task.steps[index], step); }
    }
    if (event.payload.conversation) {
      const conversation = event.payload.conversation as Conversation, found = conversations.value.find(item => item.id === conversation.id);
      if (found) Object.assign(found, conversation); else conversations.value.unshift(conversation);
    }
    const conversation = conversations.value.find(item => item.id === event.conversationId); if (conversation) conversation.updatedAt = event.at;
    if (event.conversationId === selectedId.value) revision.value++;
  }
  function feed() {
    source?.close(); source = new EventSource(`/api/events?after=${cursor.value}`);
    source.onopen = () => { connection.value = "live"; errorMessage.value = ""; if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; };
    source.addEventListener("update", message => {
      try { apply(Schema.decodeUnknownSync(EventSchema)(JSON.parse((message as MessageEvent).data)) as PublicEvent); }
      catch { source?.close(); connection.value = "reconnecting"; scheduleReconnect(); }
    });
    source.onerror = () => { connection.value = "reconnecting"; scheduleReconnect(); };
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await api("/api/session");
        if (!overview.value) { await init(); return; }
        if (!replaying) {
          replaying = true;
          let events: PublicEvent[];
          do { events = await api<PublicEvent[]>(`/api/events/replay?after=${cursor.value}`); for (const event of events) apply(event); } while (events.length === 256);
        }
        feed();
      } catch { scheduleReconnect(); }
      finally { replaying = false; }
    }, 1800);
  }
  async function select(id: string | null) {
    if (id && deletedConversations.has(id)) id = null;
    recordClient(id ? "conversation.open" : "conversation.new", id ? { conversationId: id } : {});
    const version = ++selectionVersion.value; selectedId.value = id; messages.value = [];
    loadingConversation.value = Boolean(id);
    if (id) localStorage.setItem("vectra.conversation", id); else localStorage.removeItem("vectra.conversation");
    if (!id) return;
    try {
      const data = await api<{ conversation: Conversation; messages: Message[]; tasks: TaskSummary[] }>(`/api/conversations/${id}`);
      const full = await Promise.all(data.tasks.map(task => api<Task>(`/api/tasks/${task.id}`)));
      if (version !== selectionVersion.value) return;
      messages.value = data.messages;
      for (const task of full) {
        const old = tasks[task.id];
        if (!old) tasks[task.id] = task;
        else {
          const incoming = new Map(task.steps.map(step => [step.id, step]));
          for (const step of old.steps) if (!incoming.has(step.id) || incoming.get(step.id)!.updatedAt < step.updatedAt) incoming.set(step.id, step);
          if (task.updatedAt >= old.updatedAt) Object.assign(old, task);
          old.steps = [...incoming.values()].sort((a, b) => a.at - b.at);
        }
      }
      revision.value++;
    } catch (cause) { if (version === selectionVersion.value && !deletedConversations.has(id)) fail(cause); }
    finally { if (version === selectionVersion.value) loadingConversation.value = false; }
  }
  async function init() {
    if (initialized) return; initialized = true;
    try {
      await api("/api/session");
      const state = await api<Overview>("/api/overview"); overview.value = state; conversations.value = state.conversations; cursor.value = state.eventCursor;
      for (const task of state.tasks) summary(task);
      modelSettings.value = await api<PublicModelSettings>("/api/model-settings");
      feed();
      if (selectedId.value && !state.conversations.some(item => item.id === selectedId.value)) selectedId.value = null;
      await select(selectedId.value);
    } catch (cause) { fail(cause); connection.value = "reconnecting"; initialized = false; scheduleReconnect(); }
  }
  async function send(request: string, intent: CreateTask["intent"] = "auto") {
    recordClient("message.submit", selectedId.value ? { conversationId: selectedId.value } : {});
    busy.value = true; errorMessage.value = "";
    const conversationId = selectedId.value, version = selectionVersion.value;
    try {
      const task = await api<Task>("/api/tasks", { method: "POST", body: JSON.stringify({ request, requestId: crypto.randomUUID(), intent, ...(conversationId ? { conversationId } : {}) }) });
      if (deletedConversations.has(task.conversationId)) return false;
      const existing = tasks[task.id]; if (!existing) tasks[task.id] = task;
      const conversation = conversations.value.find(item => item.id === task.conversationId);
      if (conversation) conversation.updatedAt = Math.max(conversation.updatedAt, task.updatedAt);
      else conversations.value.unshift({ id: task.conversationId, title: task.request.slice(0, 48), createdAt: task.createdAt, updatedAt: task.updatedAt });
      // A new-conversation response selects its own conversation only if the user has not switched meanwhile.
      if (version === selectionVersion.value && selectedId.value === conversationId) {
        selectedId.value = task.conversationId; localStorage.setItem("vectra.conversation", task.conversationId);
      }
      if (selectedId.value === task.conversationId) revision.value++;
      return true;
    } catch (cause) { fail(cause); return false; }
    finally { busy.value = false; }
  }
  async function cancel(id: string) { recordClient("task.cancel", { taskId: id, ...(selectedId.value ? { conversationId: selectedId.value } : {}) }); try { await api(`/api/tasks/${id}/cancel`, { method: "POST" }); } catch (cause) { fail(cause); } }
  function forgetConversation(id: string, taskIds: string[] = []) {
    deletedConversations.add(id);
    for (const taskId of taskIds) deletedTaskIds.add(taskId);
    conversations.value = conversations.value.filter(item => item.id !== id);
    for (const [taskId, task] of Object.entries(tasks)) if (task.conversationId === id) { deletedTaskIds.add(taskId); delete tasks[taskId]; }
    if (overview.value) { overview.value.conversations = overview.value.conversations.filter(item => item.id !== id); overview.value.tasks = overview.value.tasks.filter(task => task.conversationId !== id); }
    if (selectedId.value === id) {
      selectionVersion.value++; selectedId.value = null; messages.value = []; loadingConversation.value = false;
      localStorage.removeItem("vectra.conversation"); revision.value++;
    }
  }
  async function deleteConversation(id: string) {
    if (deletingConversations.has(id)) return false;
    deletingConversations.add(id); errorMessage.value = "";
    recordClient("conversation.delete", { conversationId: id });
    try { const deleted = await api<ConversationDeletion>(`/api/conversations/${id}`, { method: "DELETE" }); forgetConversation(id, deleted.taskIds); return true; }
    catch (cause) { fail(cause); return false; }
    finally { deletingConversations.delete(id); }
  }
  function close() { initialized = false; source?.close(); source = null; if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (import.meta.hot) import.meta.hot.dispose(close);
  return { overview, conversations, selectedId, selectionVersion, tasks, messages, modelSettings, connection, errorMessage, busy, loadingConversation, revision, cursor, currentTasks, working, sortedConversations, deletingConversations, deletedTaskIds, init, select, send, cancel, deleteConversation, fail, close };
});
