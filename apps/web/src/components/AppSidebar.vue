<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { shanghaiDayIndex, type Conversation } from "@vectra/shared";
import { useWorkspace } from "../stores/workspace";

const workspace = useWorkspace(), route = useRoute(), router = useRouter();
const now = ref(Date.now()), deleteTarget = ref<Conversation | null>(null), deleteDialog = ref<HTMLDialogElement>(), deleteError = ref("");
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => { clock = setInterval(() => { now.value = Date.now(); }, 30_000); });
onUnmounted(() => { if (clock) clearInterval(clock); });
const pages = [
  { path: "/", name: "AI 对话", icon: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" },
  { path: "/data", name: "车辆数据", icon: "M4 5h16v14H4zM4 10h16M9 5v14M15 5v14" },
  { path: "/evidence", name: "证据与审计", icon: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6" },
  { path: "/reports", name: "结果验证", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 15l3 3 5-6" },
];
const groups = computed(() => {
  const today = shanghaiDayIndex(now.value);
  const sections: { title: string; items: Conversation[] }[] = [
    { title: "今天", items: [] }, { title: "昨天", items: [] },
    { title: "过去 7 天", items: [] }, { title: "更早", items: [] },
  ];
  for (const conversation of workspace.sortedConversations) {
    const at = shanghaiDayIndex(conversation.updatedAt);
    const index = at >= today ? 0 : at >= today - 1 ? 1 : at >= today - 6 ? 2 : 3;
    sections[index].items.push(conversation);
  }
  return sections.filter(section => section.items.length);
});
const runningConversations = computed(() => new Set(Object.values(workspace.tasks)
  .filter(task => task.status === "queued" || task.status === "running").map(task => task.conversationId)));
const latest = computed(() => workspace.currentTasks.at(-1));
const connectionLabel = computed(() => workspace.connection === "live" ? "实时连接已建立" : workspace.connection === "reconnecting" ? "正在重新连接" : "正在连接服务");

async function openConversation(id: string | null) {
  const selection = workspace.select(id);
  await router.push("/");
  await selection;
}
function askDelete(conversation: Conversation) {
  deleteTarget.value = conversation; deleteError.value = "";
  deleteDialog.value?.showModal();
}
async function confirmDelete() {
  const target = deleteTarget.value; if (!target) return;
  const wasSelected = workspace.selectedId === target.id;
  if (await workspace.deleteConversation(target.id)) {
    deleteDialog.value?.close(); deleteTarget.value = null;
    await nextTick();
    if (wasSelected && route.path === "/") document.querySelector<HTMLTextAreaElement>("#task-prompt")?.focus({ preventScroll: true });
  }
  else deleteError.value = workspace.errorMessage || "删除未完成，请重试。";
}
function cancelDelete(event?: Event) {
  if (deleteTarget.value && workspace.deletingConversations.has(deleteTarget.value.id)) { event?.preventDefault(); return; }
  deleteDialog.value?.close(); deleteTarget.value = null;
}
</script>

<template>
  <aside class="sidebar" aria-label="导航与对话记录">
    <RouterLink to="/" class="brand" aria-label="VECTRA 对话首页"><span class="brand-symbol">V</span><span>VECTRA</span></RouterLink>
    <button class="new-conversation" @click="openConversation(null)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      新对话
      <span aria-hidden="true">↗</span>
    </button>

    <div class="sidebar-scroll">
      <nav class="sidebar-nav" aria-label="功能导航">
        <RouterLink v-for="page in pages" :key="page.path" :to="page.path" :class="{ active: route.path === page.path }">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="page.icon" /></svg><span>{{ page.name }}</span>
        </RouterLink>
      </nav>

      <section class="conversation-history" aria-labelledby="history-title">
        <h2 id="history-title" class="sidebar-caption">对话记录</h2>
        <p v-if="!groups.length" class="history-empty">你的对话会显示在这里。</p>
        <div v-for="group in groups" :key="group.title" class="history-group">
          <h3>{{ group.title }}</h3>
          <div v-for="conversation in group.items" :key="conversation.id" class="history-row" :class="{ active: route.path === '/' && workspace.selectedId === conversation.id }">
          <button class="history-item"
            :title="conversation.title" :aria-current="route.path === '/' && workspace.selectedId === conversation.id ? 'true' : undefined"
            @click="openConversation(conversation.id)">
            <span class="history-item-title">{{ conversation.title }}</span>
            <span v-if="runningConversations.has(conversation.id)" class="history-running" role="img" aria-label="有任务正在执行"></span>
          </button>
          <button class="history-delete" :disabled="workspace.deletingConversations.has(conversation.id)" :title="`删除对话：${conversation.title}`" :aria-label="`删除对话：${conversation.title}`" @click="askDelete(conversation)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5" /></svg></button>
          </div>
        </div>
      </section>

      <details class="sidebar-runtime">
        <summary>运行概览 <span aria-hidden="true">⌄</span></summary>
        <div class="sidebar-runtime-content">
          <p class="sidebar-section-label">当前对话</p>
          <p>{{ latest?.request || '等待新任务' }}</p>
          <p v-if="latest" class="sidebar-runtime-meta">{{ latest.steps.length }} 个执行步骤 · {{ latest.model ? '模型协作' : '历史记录' }}</p>
          <p class="sidebar-section-label">登记身份 · {{ workspace.overview?.nodes.length || 0 }}</p>
          <div v-for="node in workspace.overview?.nodes" :key="node.id" class="node-row"><span>{{ node.id }}</span><small>{{ node.role }}</small></div>
        </div>
      </details>
    </div>

    <div class="sidebar-footer">
      <RouterLink to="/settings" class="sidebar-settings" :class="{ active: route.path === '/settings' }">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6m8 4v6" /></svg>
        <span><strong>模型设置</strong><small>{{ workspace.modelSettings?.ready ? workspace.modelSettings.model : '待配置模型服务' }}</small></span>
      </RouterLink>
      <div class="connection" :class="workspace.connection" role="status"><i aria-hidden="true"></i><span>{{ connectionLabel }}</span><small>1.0.3</small></div>
      <p class="sidebar-timezone">上海时间 · UTC+8</p>
    </div>
  </aside>
  <dialog ref="deleteDialog" class="delete-dialog" aria-labelledby="delete-dialog-title" @cancel="cancelDelete" @close="deleteTarget = null">
    <h2 id="delete-dialog-title">删除这段对话？</h2>
    <p class="delete-dialog-name">{{ deleteTarget?.title }}</p>
    <p>将删除此对话及关联的任务、执行步骤、签名报告和本机实验材料。此操作无法撤销。</p>
    <p v-if="deleteTarget && runningConversations.has(deleteTarget.id)" class="delete-running-note">此对话仍有任务，将先取消执行并停止排队，再完成删除。</p>
    <p class="delete-retention-note">Git 诊断日志、安全审计和追加事件历史按现有策略保留，用于排查错误；已删除内容不会再出现在对话列表或事件回放中。</p>
    <p v-if="deleteError" class="error-text" role="alert">{{ deleteError }}</p>
    <div class="delete-dialog-actions"><button class="secondary" :disabled="Boolean(deleteTarget && workspace.deletingConversations.has(deleteTarget.id))" @click="cancelDelete()">取消</button><button class="danger-button" :disabled="Boolean(deleteTarget && workspace.deletingConversations.has(deleteTarget.id))" @click="confirmDelete">{{ deleteTarget && workspace.deletingConversations.has(deleteTarget.id) ? '正在停止任务并删除…' : '删除对话' }}</button></div>
  </dialog>
</template>
