<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { resolveStepPhase, type Step, type ProtocolMaterials, type StatisticsQuery } from "@vectra/shared";
import { api, statusLabel } from "../api";
import MarkdownContent from "./MarkdownContent.vue";
import ProtocolSection from "./ProtocolSection.vue";
import ActorAvatar from "./ActorAvatar.vue";
import ReadableData from "./ReadableData.vue";
import MessageContext from "./MessageContext.vue";
import MessageTimestamp from "./MessageTimestamp.vue";
import { securityProtocolsForStep, mathematicsForStep, formatProtocolMathematics } from "../message-details";
import { actorFor, actorLabel, presentStep, stepActor, checkLabel, userFacingError } from "../conversation";
import { expandSecurityNames } from "../security-language";
const props = defineProps<{ step: Step; index: number; expanded?: boolean; steps?: Step[]; query?: StatisticsQuery }>();
const panels = ref({ operations: false, protocol: false, private: false });
watch(() => props.expanded, value => { panels.value = { operations: Boolean(value), protocol: Boolean(value), private: Boolean(value) }; }, { immediate: true });
function toggle(panel: keyof typeof panels.value, event: Event) { panels.value[panel] = (event.target as HTMLDetailsElement).open; }
const materials = ref<ProtocolMaterials>();
const materialError = ref("");
const loading = ref(false);
const reload = ref(0);
watch(() => [props.step.taskId, props.step.id, props.step.hasPrivateDetails, reload.value], async (_, __, onCleanup) => {
  const controller = new AbortController(); onCleanup(() => controller.abort());
  materials.value = undefined; materialError.value = ""; loading.value = false;
  if (!props.step.hasPrivateDetails) return;
  loading.value = true;
  try { const value = await api<ProtocolMaterials>(`/api/tasks/${props.step.taskId}/steps/${props.step.id}/materials`, { signal: controller.signal }); if (!controller.signal.aborted) materials.value = value; }
  catch (cause) { if (!controller.signal.aborted) materialError.value = cause instanceof Error ? cause.message : "实验详情加载失败。"; }
  finally { if (!controller.signal.aborted) loading.value = false; }
}, { immediate: true });
const categories = { model: "模型协助", tool: "服务执行", security: "安全检查", exchange: "协作消息", mpc: "联合计算", report: "报告交付", analysis: "规划与分析" };
const actor = computed(() => stepActor(props.step));
const presentation = computed(() => presentStep(props.step, materials.value));
const phase = computed(() => resolveStepPhase(props.step, props.steps));
const protocols = computed(() => securityProtocolsForStep(props.step));
const mathematics = computed(() => mathematicsForStep(props.step, props.query));
const hasRoute = computed(() => props.step.sender && props.step.recipient && actorFor(props.step.sender).id !== actorFor(props.step.recipient).id);
const elapsed = computed(() => Math.max(0, props.step.updatedAt - props.step.at));
const recordedExecution = computed(() => ({ originalAction: props.step.action, ...(props.step.protocol ? { protocol: props.step.protocol } : {}), detail: props.step.detail,
  ...(props.step.protocolDetails ? { objective: props.step.protocolDetails.objective, operations: props.step.protocolDetails.operations, checks: props.step.protocolDetails.checks ?? [] } : {}) }));
</script>
<template>
  <article class="actor-message" :class="`actor-${actor.tone}`" :aria-label="`${actor.name}：${presentation.title}`">
    <aside class="message-actor"><ActorAvatar :actor="actor" /><strong>{{ actor.name }}</strong><span>{{ actor.role }}</span></aside>
    <div class="step-card" :class="step.status">
      <div class="step-category"><span>第 {{ index + 1 }} 步</span><span>{{ categories[step.kind] }}</span><MessageTimestamp :value="step.updatedAt" :started-at="step.at" :label="step.updatedAt === step.at ? '记录于' : step.status === 'completed' ? '完成于' : ['failed','cancelled'].includes(step.status) ? '停止于' : '更新于'" /></div>
      <MessageContext :phase="phase" />
      <div class="step-heading"><h3>{{ presentation.title }}</h3><span class="status" :class="step.status">{{ statusLabel[step.status] }}</span></div>
      <div v-if="hasRoute" class="message-route" aria-label="消息发送方向"><span><ActorAvatar :actor="actorFor(step.sender!)" compact />{{ actorLabel(step.sender!) }}</span><b aria-label="发送给">→</b><span><ActorAvatar :actor="actorFor(step.recipient!)" compact />{{ actorLabel(step.recipient!) }}</span></div>
      <MarkdownContent :content="formatProtocolMathematics(presentation.body)" explain-protocols />
      <ReadableData v-if="presentation.structuredAnswer" class="model-readable-answer" :value="presentation.structuredAnswer" />
      <p class="step-reason"><strong>为什么需要这一步</strong>{{ expandSecurityNames(presentation.guide.why) }}</p>
      <MessageContext v-if="protocols.length" :phase="phase" :protocols="protocols" :show-phase="false" />
      <section v-if="mathematics.length" class="message-mathematics" aria-label="本步计算方法与公式"><p class="math-introduction">以下公式说明本步怎样计算，可结合实际数据对照阅读。</p><div v-for="(formula, i) in mathematics" :key="i"><h4>{{ formula.title }}</h4><MarkdownContent :content="`$$\n${formula.latex}\n$$`" /><p>{{ formula.meaning }}</p></div></section>
      <dl v-if="presentation.facts.length" class="message-facts"><div v-for="(fact, i) in presentation.facts" :key="i"><dt>{{ fact.label }}</dt><dd>{{ fact.value }}</dd></div></dl>
      <div v-if="presentation.rows.length" class="message-data"><h4>{{ presentation.rowTitle }}</h4><table class="readable-table"><thead><tr><th>参与者 / 去向</th><th>本次实际份额</th></tr></thead><tbody><tr v-for="(row, i) in presentation.rows" :key="i"><td>{{ row.label }}</td><td class="share-number">{{ row.value }}</td></tr></tbody></table></div>
      <ul v-if="presentation.nextActions.length" class="next-actions"><li v-for="(action, i) in presentation.nextActions" :key="i"><span>模型建议</span>{{ action }}<small>通过系统检查后执行</small></li></ul>
      <p class="step-next"><strong>{{ presentation.guide.nextLabel }}</strong>{{ expandSecurityNames(presentation.guide.next) }}</p>
      <div v-if="step.protocolDetails?.checks?.length" class="recorded-checks"><h4>本步记录的检查结果</h4><ul class="protocol-checks"><li v-for="(check, i) in step.protocolDetails.checks" :key="i" :class="check.status"><strong>{{ check.status === 'passed' ? '✓ 已通过' : check.status === 'failed' ? '✗ 未通过' : '… 待检查' }} · {{ checkLabel(check.name) }}</strong><span v-if="check.expected">应满足：{{ expandSecurityNames(userFacingError(check.expected)) }}</span><span v-if="check.actual">本次记录：{{ expandSecurityNames(userFacingError(check.actual)) }}</span></li></ul></div>
      <div class="message-detail-panels">
        <details :open="panels.operations" @toggle="toggle('operations', $event)"><summary>执行经过 <span>目的、处理方式与后续安排</span></summary><div v-if="panels.operations" class="detail-panel-content"><h4 class="execution-label">这一步要解决什么</h4><MarkdownContent class="protocol-objective" :content="presentation.guide.goal" explain-protocols /><p>{{ expandSecurityNames(presentation.guide.why) }}</p><h4 class="execution-label">{{ presentation.guide.processLabel }}</h4><ol class="protocol-operations"><li v-for="(operation, i) in presentation.guide.steps" :key="i"><MarkdownContent :content="operation" explain-protocols /></li></ol><h4 class="execution-label">{{ presentation.guide.nextLabel }}</h4><p>{{ expandSecurityNames(presentation.guide.next) }}</p><p class="execution-record-note">本说明帮助理解处理方式；是否完成以本步状态和实际检查结果为准。</p></div></details>
        <details :open="panels.protocol" @toggle="toggle('protocol', $event)"><summary>协议、报文与校验数据 <span>查看实际消息和原始记录</span></summary><div v-if="panels.protocol" class="detail-panel-content"><p class="detail-introduction">这里保留本次实际使用或返回的数据。先阅读每项用途说明，需要逐字核对时可切换原始数据或复制原文。</p><ProtocolSection v-for="(section, i) in step.protocolDetails?.sections" :key="i" :section="section" /><ProtocolSection :section="{ title: '原始执行记录', data: recordedExecution }" /><ProtocolSection v-if="Object.keys(step.metadata).length" :section="{ title: '用于关联本次操作的信息', data: step.metadata }" /><ProtocolSection :section="{ title: '本条消息的编号与时间', data: { id: step.id, agent: step.agent, createdAt: step.at, updatedAt: step.updatedAt } }" /></div></details>
        <details v-if="step.hasPrivateDetails" :open="panels.private" @toggle="toggle('private', $event)"><summary>密钥、原始数据与完整份额 <span>{{ materials?.sections.length ? `${materials.sections.length} 项实际材料` : loading ? '读取中' : '查看本机完整材料' }}</span></summary><div v-if="panels.private" class="detail-panel-content protocol-private"><p>你可以在这里对照本次实际使用的密钥、车辆记录和份额，查看易读字段或复制原文。这些完整材料仅从本机读取展示，不发送给模型，也不写入 Git 诊断日志。</p><p v-if="loading" role="status">正在读取本次实际材料…</p><p v-if="materialError" role="alert">{{ materialError }} <button @click="reload++">重新读取</button></p><ProtocolSection v-for="(section, i) in materials?.sections" :key="i" :section="section" /></div></details>
      </div>
      <p v-if="materialError && !panels.private" class="material-load-note">原始数据暂未加载。<button @click="reload++">重新读取</button></p>
      <p v-if="!step.protocolDetails" class="protocol-history-note">这条历史消息只保留了摘要；流程说明用于帮助理解，未记录的具体检查无法据此确认。</p>
      <div class="message-footer"><div v-if="step.evidenceIds.length" class="evidence-links"><RouterLink v-for="id in step.evidenceIds" :key="id" :to="`/evidence?event=${id}`">查看证据 #{{ id }} ↗</RouterLink></div><span v-if="elapsed && step.status !== 'running'" class="message-duration">耗时 {{ elapsed < 1000 ? `${elapsed} 毫秒` : `${(elapsed / 1000).toFixed(2)} 秒` }}</span></div>
    </div>
  </article>
</template>
