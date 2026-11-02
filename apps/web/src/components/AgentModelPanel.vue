<script setup lang="ts">
import { onMounted, ref, useId } from "vue";
import { onBeforeRouteUpdate } from "vue-router";
import { PROVIDERS, type AgentModelSettings, type LlmAgentId } from "@vectra/shared";
import { createModelSettingsEditor } from "../model-settings";
import { useUnsavedChanges } from "../use-unsaved-changes";
const props = defineProps<{ agentId: LlmAgentId }>(), emit = defineEmits<{ saved: [value: AgentModelSettings] }>();
const id = useId(), message = ref("");
const { form, snapshot, loading, busy, editing, locked, protocol, endpoint, load, beginEdit, cancelEdit, providerChange, save } = createModelSettingsEditor(value => { emit("saved", value as AgentModelSettings); }, cause => { message.value = cause instanceof Error ? cause.message : String(cause); }, "/api/agents/" + props.agentId + "/model-settings");
const confirmDiscard = useUnsavedChanges(() => !!snapshot.value && editing.value && (!!form.apiKey || form.clearApiKey || (["provider", "baseUrl", "model", "apiFormat", "deepThinking", "thinkingProtocol"] as const).some(key => form[key] !== snapshot.value![key])), "Agent 模型配置");
onBeforeRouteUpdate(() => confirmDiscard());
async function submit() { message.value = ""; await save(); if (!editing.value) message.value = snapshot.value?.ready ? "模型配置已保存，后续新任务生效。" : "配置已保存。请补齐模型名称和本 Agent 的 API Key 后再发起任务。"; }
onMounted(load);
</script>
<template>
  <form class="settings-form agent-model-form" @submit.prevent="submit"><h2>底层 LLM 配置</h2><p class="agent-copy">每个 Agent 单独保存模型服务、接口格式、模型名称和密钥。子智能体首次使用前需要显式配置；可以手工填写相同的服务和模型，也可以选择不同模型。</p><UiAlert v-if="agentId !== 'coordinator' && !loading && snapshot && !snapshot.ready" class="agent-feedback">此子智能体尚未配置可用模型，请填写并保存本 Agent 的配置。</UiAlert><p class="settings-mode">{{ loading ? '正在读取配置…' : editing ? '正在修改，保存后用于后续新任务。' : '当前配置为只读，点击“修改配置”后调整。' }}</p>
    <UiFieldset :disabled="locked">
      <label :for="id + '-provider'">服务提供商</label><UiSelect :id="id + '-provider'" v-model="form.provider" @change="providerChange"><option v-for="provider in PROVIDERS" :key="provider.id" :value="provider.id">{{ provider.name }}</option></UiSelect>
      <label :for="id + '-format'">模型接口格式</label><UiSelect :id="id + '-format'" v-model="form.apiFormat"><option value="chat-completions">Chat Completions（/chat/completions）</option><option value="responses">OpenAI Responses（/responses）</option></UiSelect>
      <p class="field-help">按模型服务支持的格式选择，各 Agent 可以分别设置。原有配置继续使用 Chat Completions。</p>
      <label :for="id + '-url'">模型服务 API 地址</label><UiInput :id="id + '-url'" v-model="form.baseUrl" type="url" :readonly="form.provider !== 'custom'" required maxlength="2048" /><p class="field-help">可填写基础地址或完整的 /chat/completions、/responses 地址，系统会按所选格式规范化，避免重复拼接。</p><p v-if="endpoint" class="model-endpoint-preview">实际请求地址：<code>{{ endpoint }}</code></p>
      <label :for="id + '-model'">模型名称</label><UiInput :id="id + '-model'" v-model="form.model" maxlength="200" required placeholder="填写支持工具调用的模型名称" />
      <label :for="id + '-key'">API Key</label><UiInput :id="id + '-key'" v-model="form.apiKey" type="password" autocomplete="off" maxlength="4096" :required="!snapshot?.hasApiKey && !form.clearApiKey" :placeholder="snapshot?.hasApiKey ? '本 Agent 已保存；同一服务留空保留密钥' : '填写本 Agent 的 API Key'" /><label v-if="snapshot?.hasApiKey" class="checkbox-label"><input v-model="form.clearApiKey" type="checkbox" />清除当前独立配置的密钥</label><p class="field-help">粘贴时会清理首尾空白和零宽字符；密钥中间请勿插入空格或换行。</p>
      <template v-if="form.provider === 'custom' && form.apiFormat === 'chat-completions'"><label :for="id + '-thinking'">深度思考参数兼容方式</label><UiSelect :id="id + '-thinking'" v-model="form.thinkingProtocol"><option value="auto">自动识别</option><option value="deepseek">DeepSeek 兼容</option><option value="qwen">通义千问兼容</option><option value="openai">OpenAI 兼容</option></UiSelect></template>
      <label class="checkbox-label"><input v-model="form.deepThinking" type="checkbox" :disabled="!protocol" />开启深度思考</label><p class="field-help">每个 Agent 可以单独选择思考模式。{{ form.apiFormat === 'responses' ? 'Responses 开启时请求较高思考强度，未勾选时使用模型服务的默认强度；部分模型始终进行推理。' : '模型须支持相应的思考参数。' }}模型须支持工具调用；内部推理不写入对话或日志。</p>
    </UiFieldset>
    <UiAlert v-if="message" role="status" class="agent-feedback">{{ message }}</UiAlert><div class="button-row"><UiButton v-if="!editing" type="button" class="primary" :disabled="busy || loading || !snapshot" @click="beginEdit">修改配置</UiButton><template v-else><UiButton class="primary" :disabled="busy || loading">保存独立配置</UiButton><UiButton type="button" class="secondary" :disabled="busy" @click="cancelEdit">取消</UiButton></template><UiButton v-if="!snapshot && !loading" type="button" @click="load">重新读取</UiButton></div><p class="agent-copy">保存配置不会向模型服务发送测试请求。任务接收时会锁定主、子智能体各自的配置，执行期间修改配置不影响该轮任务。</p>
  </form>
</template>
<style scoped>
.agent-model-form{max-width:700px}.agent-model-form label:not(.checkbox-label){display:block;font-size:12px;color:#61766b;margin:15px 0 7px}.agent-model-form input:not([type=checkbox]),.agent-model-form select{width:100%;box-sizing:border-box}.agent-copy{color:#76877c;font-size:12px;line-height:1.9}.agent-feedback{font-size:12px;color:#49795b;white-space:pre-wrap}.model-endpoint-preview{font-size:11px;color:#7e9787;line-height:1.9;overflow-wrap:anywhere}.model-endpoint-preview code{font-size:11px;color:#5d866c}
</style>
