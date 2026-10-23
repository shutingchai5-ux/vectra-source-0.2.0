<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import type { SignedEnvelope, Verification } from "@vectra/shared";
import { api, pretty } from "../api";
import { useWorkspace } from "../stores/workspace";
const workspace = useWorkspace(), route = useRoute(), selected = ref(String(route.query.task || '')), text = ref(''), busy = ref(false), outcome = ref<Verification | null>(null);
const available = computed(() => Object.values(workspace.tasks).filter(task => task.status === 'completed').sort((a, b) => b.createdAt - a.createdAt));
watch(() => workspace.deletedTaskIds.has(selected.value), deleted => { if (deleted) { selected.value = ""; text.value = ""; outcome.value = null; } });
async function load() { const id = selected.value; if (!id) return; try { const report = await api<SignedEnvelope>(`/api/reports/${id}`); if (selected.value !== id || workspace.deletedTaskIds.has(id)) return; text.value = pretty(report); outcome.value = null; } catch (cause) { if (selected.value === id) workspace.fail(cause); } }
async function verify() { busy.value = true; const snapshot = text.value; try { const envelope = JSON.parse(snapshot); const result = await api<Verification>('/api/reports/verify', { method: 'POST', body: JSON.stringify({ envelope }) }); if (text.value === snapshot) outcome.value = result; } catch (cause) { if (text.value === snapshot) workspace.fail(cause); } finally { busy.value = false; } }
function tamper() { try { const data = JSON.parse(text.value); if (!data.payload || typeof data.payload !== 'object') throw new Error('请先载入有效报告。'); data.payload.summary = String(data.payload.summary || '') + '（内容已修改）'; text.value = pretty(data); outcome.value = null; } catch (cause) { workspace.fail(cause); } }
onMounted(load);
</script>
<template>
  <div class="page-heading"><div><div class="eyebrow">VERIFY, THEN TRUST</div><h1>验证结果，也验证来源。</h1><p>独立检查登记签署者、数字签名和任务计划绑定。</p></div></div>
  <div class="two-column"><section class="panel"><h2>签名报告</h2><label class="field-label" for="report-select">选择已完成报告</label><select id="report-select" v-model="selected" @change="load"><option value="">选择报告</option><option v-for="task in available" :key="task.id" :value="task.id">{{ task.request }}</option></select><label class="field-label" for="report-json">报告内容 · 可编辑</label><textarea id="report-json" class="json-editor" v-model="text" rows="20" maxlength="131072" spellcheck="false" placeholder="选择报告，或粘贴签名信封 JSON。"></textarea><div class="button-row"><button class="primary" :disabled="busy || !text" @click="verify">验证数字签名 ↗</button><button class="secondary" :disabled="!text" @click="tamper">修改报告内容</button><a v-if="selected" class="text-button" :href="`/api/reports/${selected}/download`" download>下载原始报告 ↓</a></div></section><div><section class="panel"><h2>如何读取验证结果</h2><ol class="guide-list"><li><strong>载入签名报告</strong><p>报告绑定任务请求、执行计划和批准的公开产物。</p></li><li><strong>验证内容与来源</strong><p>后端校验已登记报告身份的 Ed25519 签名。</p></li><li><strong>修改后再次验证</strong><p>签名保持不变，内容修改应导致验证失败。</p></li></ol><p class="muted">签名有效说明内容与签发者绑定，不证明传感器输入一定真实。</p></section><section class="panel report-outcome" :class="{ invalid: outcome && !outcome.valid }"><span class="outcome-symbol">{{ outcome ? outcome.valid ? '✓' : '×' : '◇' }}</span><h2>{{ outcome ? outcome.valid ? '签名验证通过' : '签名验证未通过' : '等待验证' }}</h2><p>{{ outcome?.reason || '载入报告后，查看服务端实际校验结果。' }}</p></section></div></div>
</template>
