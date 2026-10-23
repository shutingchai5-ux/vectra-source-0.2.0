<script setup lang="ts">
import { onMounted } from "vue";
import { PROVIDERS } from "@vectra/shared";
import { useWorkspace } from "../stores/workspace";
import { createModelSettingsEditor } from "../model-settings";
const workspace = useWorkspace();
const { form, snapshot, loading, busy, editing, savedNotice, locked, canCancel, protocol, load, beginEdit, cancelEdit, providerChange, save } = createModelSettingsEditor(settings => { workspace.modelSettings = settings; }, cause => workspace.fail(cause));
onMounted(load);
</script>
<template>
  <div class="page-heading"><div><div class="eyebrow">MODEL SETTINGS</div><h1>配置协作模型。</h1><p>模型负责规划与解释，权限、密码学和隐私计算由安全工具执行。</p></div></div>
  <div class="two-column">
    <form class="panel settings-form" @submit.prevent="save">
      <h2>模型服务</h2>
      <p>{{ snapshot?.ready ? '已配置，可发起协作任务。' : '请填写模型名称和 API Key，完成后即可对话。' }}</p>
      <p class="settings-mode" role="status">{{ loading ? '正在读取已保存配置…' : editing ? '正在编辑，保存后对后续新任务生效。' : '当前配置为只读；需要调整时请点击“修改配置”。' }}</p>
      <fieldset :disabled="locked" aria-label="模型服务配置">
        <label class="field-label" for="provider">服务提供商</label>
        <select id="provider" v-model="form.provider" @change="providerChange"><option v-for="provider in PROVIDERS" :key="provider.id" :value="provider.id">{{ provider.name }}</option></select>
        <label class="field-label" for="base-url">兼容 Chat Completions 的 API 地址</label>
        <input id="base-url" v-model="form.baseUrl" :readonly="form.provider !== 'custom'" type="url" required maxlength="2048">
        <label class="field-label" for="model-name">模型名称</label>
        <input id="model-name" v-model="form.model" maxlength="200" required placeholder="填写支持工具调用的模型名称">
        <label class="field-label" for="api-key">API Key</label>
        <input id="api-key" type="password" v-model="form.apiKey" autocomplete="off" maxlength="4096" :placeholder="snapshot?.hasApiKey ? '已保存；留空保留同一服务的密钥' : '输入该服务的 API Key'">
        <label class="checkbox-label"><input type="checkbox" v-model="form.clearApiKey">清除已保存密钥</label>
        <template v-if="form.provider === 'custom'">
          <label class="field-label" for="thinking-protocol">模型服务兼容方式</label>
          <select id="thinking-protocol" v-model="form.thinkingProtocol"><option value="auto">自动识别服务地址或模型名称</option><option value="deepseek">DeepSeek 兼容</option><option value="qwen">通义千问兼容</option><option value="openai">OpenAI 兼容</option></select>
        </template>
        <label class="checkbox-label"><input id="deep-thinking" type="checkbox" v-model="form.deepThinking" :disabled="!protocol">开启深度思考</label>
        <p class="field-help">{{ protocol ? '模型须支持所选模式和工具调用。开启后响应可能更慢；部分模型无法关闭思考或不接受该参数。' : '当前网关无法自动识别，请选择兼容方式后设置开关；未指定时使用服务默认行为。' }}内部推理不会显示在对话中或写入日志。</p>
      </fieldset>
      <div class="button-row">
        <button v-if="!editing" type="button" class="primary" :disabled="loading || busy || !snapshot" @click="beginEdit">修改配置</button>
        <template v-else><button type="submit" class="primary" :disabled="busy || loading">{{ busy ? '保存中…' : '保存配置' }}</button><button v-if="canCancel" type="button" class="secondary" :disabled="busy" @click="cancelEdit">取消修改</button></template>
        <span v-if="savedNotice" class="success-text">{{ snapshot?.ready ? '配置已保存并锁定，后续新任务生效。' : '配置已保存并锁定，请点击修改配置补全。' }}</span>
        <button v-if="!snapshot && !loading" type="button" class="secondary" @click="load">重新读取</button>
      </div>
    </form>
    <div><section class="panel"><h2>配置如何生效</h2><ol class="guide-list"><li><strong>查看与修改分开</strong><p>已保存配置默认只读。点击“修改配置”后调整，取消修改会恢复原配置。</p></li><li><strong>选择思考模式</strong><p>开关按服务商的兼容参数生效，不替换你选择的模型。自定义网关可手动选择兼容方式。</p></li><li><strong>保存并发起任务</strong><p>保存不发送模型请求，凭据在本机加密保存。新任务使用保存后的配置，已有任务继续使用原快照。</p></li></ol><RouterLink class="text-button" to="/">返回协作工作台 ↗</RouterLink></section><div class="info-banner">所有对话均由配置的模型参与。未配置模型时可以管理数据和设置，发起对话前需补全配置。</div></div>
  </div>
</template>

