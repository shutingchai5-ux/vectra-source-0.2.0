<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onUnmounted } from "vue";
import type { CreateTask } from "@vectra/shared";
import { useWorkspace } from "../stores/workspace";
import TaskInteraction from "../components/TaskInteraction.vue";
import QuestionSuggestions from "../components/QuestionSuggestions.vue";

const workspace = useWorkspace(), prompt = ref(""), intent = ref<CreateTask["intent"]>("auto");
const input = ref<HTMLTextAreaElement>(), follow = ref(true), unread = ref(false);
const empty = computed(() => !workspace.currentTasks.length && !workspace.loadingConversation);
let mounted = false;

function observeScroll() {
  const distance = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
  follow.value = distance < 120;
  if (follow.value) unread.value = false;
}
async function bottom() {
  await nextTick();
  if (!mounted) return;
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  unread.value = false;
  follow.value = true;
}
async function resizeInput() {
  await nextTick();
  if (input.value) {
    input.value.style.height = "auto";
    input.value.style.height = `${input.value.scrollHeight}px`;
  }
}
function chooseQuestion(question: string) {
  prompt.value = question;
  intent.value = "statistics";
  input.value?.focus({ preventScroll: true });
}
watch(prompt, resizeInput);
watch(() => workspace.revision, async () => {
  if (follow.value) await bottom();
  else unread.value = true;
});
watch(() => workspace.selectionVersion, () => {
  prompt.value = "";
  intent.value = "auto";
  follow.value = true;
  void bottom();
  input.value?.focus({ preventScroll: true });
});
watch(() => workspace.selectedId, () => { follow.value = true; void bottom(); });
async function submit() {
  const text = prompt.value.trim();
  if (!text || workspace.busy) return;
  if (!workspace.modelSettings?.ready) { workspace.errorMessage = "请先在模型设置中配置模型名称和 API Key。"; return; }
  follow.value = true;
  if (await workspace.send(text, intent.value)) {
    prompt.value = "";
    intent.value = "auto";
  }
  if (follow.value) await bottom();
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.isComposing && (!event.shiftKey || event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void submit();
  }
}
onMounted(() => {
  mounted = true;
  window.addEventListener("scroll", observeScroll, { passive: true });
  void bottom();
  void resizeInput();
  input.value?.focus({ preventScroll: true });
});
onUnmounted(() => { mounted = false; window.removeEventListener("scroll", observeScroll); });
</script>

<template>
  <div class="chat-workspace" :class="{ 'is-empty': empty }">
    <div class="conversation-content" aria-label="对话消息与执行步骤">
      <div v-if="empty" class="welcome">
        <span class="welcome-symbol" aria-hidden="true">V</span>
        <h1>今天有什么可以帮你？</h1>
        <p>从一个问题开始，让每一步协作都有迹可循。</p>
      </div>
      <p v-if="workspace.loadingConversation" class="conversation-loading" role="status">正在载入对话记录…</p>
      <TaskInteraction v-for="task in workspace.currentTasks" :key="task.id" :task="task" />
      <div v-if="workspace.busy" class="sending-note" role="status">正在发送…</div>
    </div>

    <div class="composer">
      <div class="composer-inner">
        <button v-if="unread" class="jump-latest" @click="bottom">有新进展 · 回到最新 ↓</button>
        <QuestionSuggestions v-if="empty" @choose="chooseQuestion" />
        <p v-if="!workspace.modelSettings?.ready" class="model-setup-note">请先<RouterLink to="/settings">配置模型服务</RouterLink>，再发起对话。</p>
        <form @submit.prevent="submit">
          <label class="sr-only" for="task-prompt">发送消息给 VECTRA</label>
          <textarea id="task-prompt" ref="input" v-model="prompt" rows="2" maxlength="2000" :disabled="workspace.busy"
            :placeholder="empty ? '向 VECTRA 提问，或描述你想完成的任务' : '继续提问…'" @keydown="keydown"></textarea>
          <div class="composer-footer">
            <div class="composer-options">
              <select v-model="intent" aria-label="任务类型">
                <option value="auto">自动识别任务</option><option value="statistics">隐私统计</option>
                <option value="investigation">证据调查</option><option value="verification">报告验证</option><option value="explain">解释与追问</option>
              </select>
              <RouterLink class="composer-model" to="/settings" :title="workspace.modelSettings?.model || '配置模型服务'">{{ workspace.modelSettings?.ready ? workspace.modelSettings.model : '配置模型服务' }}<span aria-hidden="true">⌄</span></RouterLink>
            </div>
            <button class="send-button" type="submit" :disabled="workspace.busy || !prompt.trim() || !workspace.modelSettings?.ready" :aria-label="workspace.busy ? '正在发送消息' : '发送消息'" title="发送消息（Enter）">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
            </button>
          </div>
        </form>
        <p class="composer-note">Enter 发送 · Shift + Enter 换行<span aria-hidden="true"> · </span>完整实验材料在步骤中展示，模型仅接收公开上下文。</p>
      </div>
    </div>
  </div>
</template>
