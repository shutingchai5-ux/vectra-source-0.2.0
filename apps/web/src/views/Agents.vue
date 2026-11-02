<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ROLE_NAMES, type AgentDetail } from "@vectra/shared";
import { api } from "../api";
import { actorFor } from "../conversation";
import ActorAvatar from "../components/ActorAvatar.vue";
const items = ref<AgentDetail[]>([]), busy = ref(false), message = ref("");
const total = computed(() => items.value.reduce((sum, item) => sum + item.stats.total, 0));
async function load() { busy.value = true; message.value = ""; try { items.value = await api<AgentDetail[]>("/api/agents"); } catch (cause) { message.value = String(cause); } finally { busy.value = false; } }
onMounted(load);
</script>
<template>
  <section class="agent-page"><div class="agent-heading"><div><span class="agent-eyebrow">协作身份与能力</span><h1>Agent 工作组</h1><p>一个主智能体统筹两个子智能体。分别配置底层模型，按职责委派任务、核对产物并交付。</p></div><UiButton class="secondary" :disabled="busy" @click="load">{{ busy ? '正在刷新…' : '刷新工作组' }}</UiButton></div>
    <p v-if="message" class="agent-alert" role="alert">{{ message }}</p><div class="agent-summary"><div><small>LLM 智能体</small><strong>{{ items.length }}<em>个</em></strong></div><div><small>执行记录</small><strong>{{ total }}<em>次</em></strong></div><div><small>长期记忆</small><strong>仅主智能体</strong><p>子智能体只接收本次任务所需的上下文</p></div></div>
    <div class="agent-workflow"><span>用户请求</span><b>→</b><RouterLink to="/agents/coordinator">{{ ROLE_NAMES.coordinator }}</RouterLink><b>→</b><span>委派规划／分析</span><b>→</b><span>签名交回产物</span><b>→</b><span>主智能体复核与交付</span></div>
    <div class="agent-cards">
      <article v-for="item in items" :key="item.identity.id" class="agent-panel agent-card">
        <div class="agent-card-meta"><span>{{ item.definition.parentId ? '子智能体' : '主智能体' }}</span><span class="agent-pill" :class="{ inactive: !item.model.ready }">{{ item.model.ready ? '模型已配置' : '待配置模型' }}</span></div>
        <div class="agent-card-title"><ActorAvatar :actor="actorFor(item.identity.id)" /><h2>{{ item.identity.displayName }}</h2></div>
        <p>{{ item.definition.summary }}</p>
        <div class="agent-card-model"><small>当前模型</small><strong>{{ item.model.model || '尚未填写' }}</strong><span>{{ item.model.ready ? '独立配置' : '请单独配置此 Agent 的模型' }} · {{ item.model.deepThinking ? '请求深度思考' : '标准模式' }}</span></div>
        <ul><li>{{ item.tools.length }} 项登记工具，按任务类型开放</li><li>{{ item.definition.hasLongTermMemory ? '主智能体长期记忆 · ' + (item.memory?.total ?? 0) + ' 条' : '无长期记忆 · 独立任务上下文' }}</li><li>已完成 {{ item.stats.completed }} 次 · 未完成 {{ item.stats.failed }} 次</li></ul>
        <RouterLink class="agent-card-link" :to="'/agents/' + item.identity.id">查看工具、模型与{{ item.definition.hasLongTermMemory ? '记忆' : '执行记录' }} ↗</RouterLink>
      </article>
    </div>
    <section class="agent-panel agent-boundary"><h2>协作如何执行</h2><p>主智能体用签名消息委派任务，子智能体在自己的上下文中调用所配置的模型，并按登记工具权限执行；返回的产物带有子智能体签名，主智能体核对任务绑定后继续处理。当前委派在本机服务内调度。</p><p>三家承运商协作节点负责真实数据与秘密分享计算，安全授权服务负责权限检查，签名报告服务负责最终报告。它们是执行服务，均不调用大模型。</p></section>
  </section>
</template>
