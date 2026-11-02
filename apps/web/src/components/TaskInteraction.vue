<script setup lang="ts">
import { computed, ref } from "vue";
import { shanghaiDateTime, resolveStepPhase, type ConversationPhase, type Task } from "@vectra/shared";
import { statusLabel } from "../api";
import { useWorkspace } from "../stores/workspace";
import TaskStepCard from "./TaskStepCard.vue";
import ParkStatistics from "./ParkStatistics.vue";
import ReservationResult from "./ReservationResult.vue";
import BusinessResult from "./BusinessResult.vue";
import MarkdownContent from "./MarkdownContent.vue";
import ActorAvatar from "./ActorAvatar.vue";
import ActorIdentity from "./ActorIdentity.vue";
import MessageContext from "./MessageContext.vue";
import MessageTimestamp from "./MessageTimestamp.vue";
import { reportProtocols, auditProtocols, securityProtocolsForStep } from "../message-details";
import { actionLabel, actorFor, intentLabels, participantGroups, userFacingError } from "../conversation";
import { taskIntroduction, taskRecovery } from "../step-explanations";
const props = defineProps<{ task: Task }>();
const workspace = useWorkspace();
const showAllDetails = ref(false);
const coordinator = computed(() => actorFor("coordinator")), analyst = computed(() => actorFor("analyst")), calculator = computed(() => actorFor("carrier-a"));
const outcomePhase = computed<ConversationPhase>(() => props.task.error?.phase ?? (props.task.status === "completed" ? 8 : props.task.steps.length ? resolveStepPhase(props.task.steps.at(-1)!, props.task.steps) : 1));
const resultProtocols = securityProtocolsForStep({ action: "三方秘密分享计算", kind: "mpc" });
const roleGroups = computed(() => participantGroups(props.task.steps, props.task.plan.parkContext?.settings));
const currentAction = computed(() => props.task.steps.filter(step => step.status === "running").at(-1)?.action);
const analysisFields = [{ label: "确认事实", key: "facts" }, { label: "可能原因", key: "possibleCauses" }, { label: "建议", key: "recommendations" }, { label: "不确定性与边界", key: "uncertainties" }] as const;
</script>
<template>
  <section class="interaction" :aria-label="task.request">
    <div class="user-message"><div class="message-meta">你<MessageTimestamp :value="task.createdAt" label="提问记录于" /></div><MessageContext :phase="1" /><div class="user-bubble"><MarkdownContent :content="task.request" /></div></div>
    <div class="actor-message task-intro">
      <ActorIdentity :actor="coordinator" />
      <div class="task-overview"><MessageTimestamp class="card-timestamp" :value="task.timestamps?.startedAt ?? task.createdAt" :label="task.timestamps?.startedAt ? '开始处理于' : '受理于'" /><MessageContext :phase="1" /><div class="task-banner" :class="task.status"><div><h3>{{ intentLabels[task.plan.intent] }}</h3><p><UiTag class="status" :class="task.status">{{ statusLabel[task.status] }}</UiTag><span> · 已记录 {{ task.steps.length }} 项交互</span><span v-if="task.status === 'running'"> · {{ currentAction ? `正在${actionLabel(currentAction)}` : '等待下一步' }}</span></p></div><UiButton v-if="['queued','running'].includes(task.status)" class="quiet-button" @click="workspace.cancel(task.id)">取消任务</UiButton></div>
        <p class="task-introduction">{{ taskIntroduction(task) }}</p>
        <details v-if="roleGroups.length" class="participant-directory"><summary>查看本轮协作身份与分工<span>按职责分层 · 仅大模型身份称为 Agent</span></summary><section class="participant-hierarchy" aria-label="本轮登记身份与职责层级"><div v-for="group in roleGroups" :key="group.level" class="participant-level"><div class="participant-level-title"><strong>{{ group.title }}</strong><small>{{ group.description }}</small></div><div class="participant-roster"><span v-for="actor in group.actors" :key="actor.id" :title="actor.role"><ActorAvatar :actor="actor" compact />{{ actor.name }}</span></div></div></section></details>
        <div class="task-reading-options"><span>{{ task.model ? `使用模型：${task.model}` : '历史执行记录' }}</span><UiButton @click="showAllDetails = !showAllDetails" :aria-pressed="showAllDetails">{{ showAllDetails ? '收起全部详情' : '展开全部执行说明与材料' }}</UiButton></div>
      </div>
    </div>
    <ol class="step-list"><li v-for="(step, index) in task.steps" :key="step.id"><TaskStepCard :step="step" :steps="task.steps" :query="task.plan.statistics" :settings="task.plan.parkContext?.settings" :index="index" :expanded="showAllDetails" /></li></ol>
    <div v-if="task.result" class="actor-message task-outcome">
      <ActorIdentity :actor="calculator" caption="承运商协作节点 · 联合统计结果" />
      <div class="outcome-content">
        <MessageTimestamp class="card-timestamp" :value="task.timestamps?.resultAt" label="统计结果记录于" />
        <MessageContext :phase="6" :protocols="resultProtocols" />
        <p class="outcome-explanation">以下是节点实际计算出的指标。{{ task.result.query?.dataset === 'carrier_business' ? '本轮按批准的经营指标汇总，原始资料保存在各企业端；请结合资料完整声明与各项有效记录阅读。' : task.result.query?.dataset === 'reservation_plans' ? '本轮汇总申报计划与可投入运力，计划不代表实际到园。' : task.result.query?.dataset === 'park_visits' ? '车次为一次进园，车辆数按完整车牌号去重。每项指标列出实际参与计算的车次数。' : '有效样本数表示参与该指标计算的记录数量。' }}统计结果产生后，仍需核对分析与签名报告是否交付。</p>
        <BusinessResult v-if="task.result.query?.dataset === 'carrier_business'" :result="task.result" />
        <ReservationResult v-else-if="task.result.query?.dataset === 'reservation_plans'" :result="task.result" />
        <ParkStatistics v-else-if="task.result.query?.dataset === 'park_visits'" :result="task.result" />
        <div v-else class="aggregate-card"><div>{{ task.result.road }} · 联合统计结果</div>
          <template v-if="task.result.groups"><p v-if="task.result.query">{{ shanghaiDateTime(task.result.query.start) }} 至 {{ shanghaiDateTime(task.result.query.end) }} · 含起点、不含终点</p><UiTable class="readable-table"><thead><tr><th>路段</th><th>指标</th><th>结果</th><th>有效样本</th></tr></thead><tbody><template v-for="group in task.result.groups" :key="group.road"><tr v-for="metric in group.metrics" :key="metric.label"><td>{{ group.road }}</td><td>{{ metric.label }}</td><td>{{ metric.value === null ? '无数据' : metric.value.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) }} {{ metric.value === null ? '' : metric.unit }}<small v-if="metric.note"> · {{ metric.note }}</small></td><td>{{ metric.validSamples }}</td></tr></template></tbody></UiTable><p>{{ task.result.participantCount }} 个计算节点 · {{ task.result.source === 'import' ? '本地导入数据' : '历史数据快照' }} · 已按采样时间筛选</p></template>
          <template v-else><strong>{{ task.result.averageSpeed?.toFixed(2) }}<small>km/h</small></strong><p>历史版本结果 · {{ task.result.windowSeconds }} 秒任务窗口 · 本机预置读数</p></template>
        </div>
      </div>
    </div>
    <div v-if="task.analysis" class="actor-message task-analysis">
      <ActorIdentity :actor="analyst" caption="运营分析与证据解释" />
      <div class="analysis"><MessageTimestamp class="card-timestamp" :value="task.timestamps?.analysisAt" label="分析保存于" /><MessageContext :phase="7" :protocols="auditProtocols" /><h3>本轮证据说明了什么</h3><p class="outcome-explanation">下面分别列出已确认的事实、可能的解释和处理建议。你可以点击证据编号查看依据；可能原因仍需与已确认事实区别阅读。</p><div class="analysis-sections"><section v-for="field in analysisFields.filter(field => task.analysis![field.key].length)" :key="field.key"><h4>{{ field.label }}</h4><ul><li v-for="(item, i) in task.analysis[field.key]" :key="i"><MarkdownContent :content="item" explain-protocols /></li></ul></section></div><div class="evidence-links"><RouterLink v-for="id in task.analysis.evidenceIds" :key="id" :to="`/evidence?event=${id}`">依据：证据 #{{ id }} ↗</RouterLink></div></div>
    </div>
    <div v-if="task.summary || task.verification || task.error" class="actor-message task-outcome">
      <ActorIdentity :actor="coordinator" caption="任务协调 · 本轮交付" />
      <div class="outcome-content">
        <MessageTimestamp class="card-timestamp" :value="task.timestamps?.finishedAt ?? task.timestamps?.summaryAt ?? task.timestamps?.verificationAt" :label="task.status === 'completed' ? '本轮完成于' : ['failed','cancelled'].includes(task.status) ? '本轮停止于' : '更新于'" />
        <MessageContext :phase="outcomePhase" :protocols="task.status === 'completed' ? reportProtocols : task.verification ? auditProtocols : []" />
        <div v-if="task.summary" class="assistant-reply"><div class="result-label">{{ task.model ? '对本轮实际结果的说明' : '历史任务说明' }}</div><MarkdownContent :content="task.summary" explain-protocols /></div>
        <div v-if="task.verification" class="verification-note" :class="{ invalid: !task.verification.valid }"><strong>{{ task.verification.valid ? '报告签名与任务核对通过' : '报告校验未通过' }}</strong><MessageTimestamp :value="task.timestamps?.verificationAt" label="校验结果记录于" /><MarkdownContent :content="task.verification.reason" explain-protocols /><p class="verification-meaning">{{ task.verification.valid ? '这表示报告来源、签署后内容与本次检查的任务信息相符；不代表已经证明传感器采样真实。' : '请先核对报告来源及具体错误，暂不将它作为通过校验的报告使用。' }}</p></div>
        <div v-if="task.error" class="failure-note"><strong>{{ task.status === 'cancelled' ? '本轮任务已取消' : '本轮任务未完成' }}</strong><MarkdownContent :content="userFacingError(task.error.message)" explain-protocols /><p>{{ taskRecovery(task.error.code, task.error.message) }}</p><details><summary>查看原始错误信息</summary><pre>{{ task.error.message }}</pre><small>错误代码：{{ task.error.code }}</small></details></div>
        <div v-if="task.status === 'completed'" class="result-actions"><RouterLink :to="`/reports?task=${task.id}`">打开签名报告 ↗</RouterLink><RouterLink to="/evidence">查看安全证据 ↗</RouterLink></div>
      </div>
    </div>
  </section>
</template>
