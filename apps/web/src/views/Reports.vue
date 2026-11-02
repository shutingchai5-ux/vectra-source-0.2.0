<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import { SYSTEM_TERMS, type SignedEnvelope, type Verification } from "@vectra/shared";
import { api, pretty } from "../api";
import { useWorkspace } from "../stores/workspace";
import ParkStatistics from "../components/ParkStatistics.vue";
import ReservationResult from "../components/ReservationResult.vue";
import BusinessResult from "../components/BusinessResult.vue";
const workspace = useWorkspace(), route = useRoute(), selected = ref(String(route.query.task || '')), text = ref(''), busy = ref(false), outcome = ref<Verification | null>(null);
const available = computed(() => Object.values(workspace.tasks).filter(task => task.status === 'completed').sort((a, b) => b.createdAt - a.createdAt));
const storedResult = computed(() => workspace.tasks[selected.value]?.result);
watch(() => workspace.deletedTaskIds.has(selected.value), deleted => { if (deleted) { selected.value = ""; text.value = ""; outcome.value = null; } });
async function load() { const id = selected.value; text.value = ""; outcome.value = null; if (!id) return; try { const report = await api<SignedEnvelope>(`/api/reports/${id}`); if (selected.value !== id || workspace.deletedTaskIds.has(id)) return; text.value = pretty(report); } catch (cause) { if (selected.value === id) workspace.fail(cause); } }
async function verify() { busy.value = true; const snapshot = text.value; try { const envelope = JSON.parse(snapshot); const result = await api<Verification>('/api/reports/verify', { method: 'POST', body: JSON.stringify({ envelope }) }); if (text.value === snapshot) outcome.value = result; } catch (cause) { if (text.value === snapshot) workspace.fail(cause); } finally { busy.value = false; } }
function tamper() { try { const data = JSON.parse(text.value); if (!data.payload || typeof data.payload !== 'object') throw new Error('请先载入有效报告。'); data.payload.summary = String(data.payload.summary || '') + '（内容已修改）'; text.value = pretty(data); outcome.value = null; } catch (cause) { workspace.fail(cause); } }
onMounted(load);
</script>
<template>
  <section class="reports-page">
    <div class="page-heading"><div><div class="eyebrow">报告与来源核验</div><h1>{{ SYSTEM_TERMS.reportsPage }}</h1><p>查看统计结果，核对报告签署者、内容完整性和任务计划。</p></div></div>
    <section class="panel report-picker">
      <div class="panel-heading"><div><h2>选择本次要查看的报告</h2><p class="muted">已完成的对话会保留对应报告，也可以在下方粘贴报告原文。</p></div><span class="report-count">{{ available.length }} 份已完成报告</span></div>
      <label class="field-label" for="report-select">任务问题</label>
      <UiSelect id="report-select" v-model="selected" @change="load"><option value="">请选择已完成的任务</option><option v-for="task in available" :key="task.id" :value="task.id">{{ task.request }}</option></UiSelect>
      <div class="button-row"><UiButton class="primary" :disabled="busy || !text" @click="verify">{{ busy ? '正在验证…' : '验证报告签名' }}</UiButton><a v-if="selected && text" class="text-button" :href="`/api/reports/${selected}/download`" download>下载原始报告 ↓</a><span class="muted">验证当前载入或编辑后的报告内容</span></div>
    </section>
    <div class="report-layout" :class="{ 'detailed-report': storedResult?.query?.analysis === 'bottleneck' || ['reservation_plans','carrier_business'].includes(storedResult?.query?.dataset ?? '') }">
      <div class="report-content">
        <section v-if="storedResult?.query && ['park_visits','reservation_plans','carrier_business'].includes(storedResult.query.dataset ?? '')" class="panel report-statistics"><div class="panel-heading"><div><h2>{{ storedResult.query.dataset === 'carrier_business' ? '已保存的企业联合经营结果' : storedResult.query.dataset === 'reservation_plans' ? '已保存的预约协同结果' : '已保存的园区运营结果' }}</h2><p class="muted">以下来自原任务的冻结记录。编辑报告原文后，应重新验证签名。</p></div></div><BusinessResult v-if="storedResult.query.dataset === 'carrier_business'" :result="storedResult" /><ReservationResult v-else-if="storedResult.query.dataset === 'reservation_plans'" :result="storedResult" /><ParkStatistics v-else :result="storedResult" /></section>
        <section v-else class="panel report-empty"><span class="report-empty-symbol" aria-hidden="true">▤</span><h2>{{ text ? '报告已载入' : '从一个已完成的任务开始' }}</h2><p>{{ text ? '展开下方原文可以查看报告的完整内容与签名，点击“验证报告签名”核对来源。' : '选择上方的任务，查看报告并核验来源。也可以展开下方区域，粘贴其他已签署报告。' }}</p><RouterLink v-if="!available.length" class="text-button" to="/">前往 AI 对话发起统计 ↗</RouterLink></section>
        <details class="panel report-source"><summary><strong>{{ text ? '报告原文与签名' : '粘贴报告原文' }}</strong><span>完整材料 · 可查看、编辑与重新验证</span></summary>
          <p class="muted">这里保留完整报告和数字签名。编辑只改变当前待验证的文本；下载仍提供已保存的原始报告。</p>
          <label class="field-label" for="report-json">待验证的报告原文（JSON 格式）</label><UiInput type="textarea" id="report-json" class="json-editor" v-model="text" @input="outcome = null" rows="16" maxlength="131072" spellcheck="false" placeholder="粘贴完整的签名报告原文。"></UiInput>
          <div class="button-row"><UiButton class="primary" :disabled="busy || !text" @click="verify">{{ busy ? '正在验证…' : '验证当前内容' }}</UiButton><UiButton class="secondary" :disabled="!text" @click="tamper">修改内容以检查签名</UiButton></div>
        </details>
      </div>
      <aside class="report-rail">
        <section class="panel report-outcome" :class="{ invalid: outcome && !outcome.valid, verified: outcome?.valid }" aria-live="polite"><span class="outcome-symbol" aria-hidden="true">{{ outcome ? outcome.valid ? '✓' : '×' : '◇' }}</span><h2>{{ outcome ? outcome.valid ? '签名验证通过' : '签名验证未通过' : '等待验证' }}</h2><p>{{ outcome?.reason || '载入报告后点击验证，此处将显示服务端的实际检查结果。' }}</p></section>
        <section class="panel report-guide"><h2>验证会检查什么</h2><ol class="guide-list"><li><strong>报告属于哪次任务</strong><p>核对任务请求、执行计划与批准的公开产物。</p></li><li><strong>谁签署、内容是否完整</strong><p>使用登记公钥检查签名报告服务的 Ed25519 数字签名。</p></li><li><strong>修改后是否还能通过</strong><p>保持原签名、改变内容，再次验证应提示不一致。</p></li></ol><p class="muted">签名有效说明内容与签发者绑定，不证明传感器输入一定真实。</p></section>
      </aside>
    </div>
  </section>
</template>
