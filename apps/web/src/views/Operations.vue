<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { shanghaiTimestamp, RESERVATION_SLOT_MS, parseParkTimestamp, MAX_WINDOW_MS } from "@vectra/shared";
import RoadMultiSelect from "../components/RoadMultiSelect.vue";
import ReservationEditor from "../components/ReservationEditor.vue";
import BusinessOperations from "../components/BusinessOperations.vue";
import { portalSession } from "../portal";
import { PARK_ENTRANCES } from "@vectra/shared";
const router = useRouter(), tab = ref("bottleneck"), roads = ref<string[]>(["东入口"]), message = ref("");
const capacityBusy = ref(false), capacityDirty = ref(false);
const actualStart = ref(shanghaiTimestamp(Date.now()).slice(0, 10) + "T00:00"), actualEnd = ref(shanghaiTimestamp(Date.now()).slice(0, 16));
const start = ref(shanghaiTimestamp(Math.ceil((Date.now() + 1) / RESERVATION_SLOT_MS) * RESERVATION_SLOT_MS).slice(0, 16));
const end = ref(shanghaiTimestamp(Math.ceil((Date.now() + 1) / RESERVATION_SLOT_MS) * RESERVATION_SLOT_MS + 2 * 3600_000).slice(0, 16)), bucket = ref(30);
async function ask(planning: boolean) {
  message.value = "";
  const from = planning ? start.value : actualStart.value, to = planning ? end.value : actualEnd.value, left = parseParkTimestamp(from), right = parseParkTimestamp(to);
  if (!roads.value.length || !Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right <= left || right - left > MAX_WINDOW_MS ||
    (planning ? right > Date.now() + MAX_WINDOW_MS : right > Date.now())) { message.value = "请选择入口及有效上海时间区间，跨度最多31天；历史实绩不得在未来，预约最多提前31天。"; return; }
  const request = planning ? "统计" + roads.value.join("、") + "从" + from.replace("T", " ") + "至" + to.replace("T", " ") + "的预约需求与运力计划，按" + bucket.value + "分钟分组，比较预计到园车次、可投入运输车次、园区接纳与作业容量，给出可人工确认的错峰建议。"
    : "分析" + roads.value.join("、") + "从" + from.replace("T", " ") + "至" + to.replace("T", " ") + "到达车次的跨企业等待与周转瓶颈，区分承运商待发、在途、园外等候及园区各环节，使用完整链路共同样本排名并说明缺失数据。";
  await router.push({ path: "/", query: { ask: request } });
}
</script>
<template>
  <section class="operations-page"><div class="page-heading"><div><span class="eyebrow">联合决策与数据准备</span><h1>联合运营分析</h1><p>找到跨企业链路的等待环节，核对未来需求、运输运力与园区作业资源。</p></div><div class="button-row"><a v-for="link in portalSession?.companyLinks?.filter(item => item.url)" :key="link.id" class="text-button" :href="link.url" target="_blank" rel="noopener">{{ link.name }} ↗</a></div></div>
    <div class="agent-tabs" role="tablist" aria-label="联合运营场景"><UiButton role="tab" :aria-selected="tab === 'bottleneck'" :class="{ active: tab === 'bottleneck' }" @click="tab = 'bottleneck'">跨企业瓶颈分析</UiButton><UiButton role="tab" :aria-selected="tab === 'reservations'" :class="{ active: tab === 'reservations' }" @click="tab = 'reservations'">预约需求与运力协同</UiButton><UiButton role="tab" :aria-selected="tab === 'business'" :class="{ active: tab === 'business' }" @click="tab = 'business'">私有经营数据联合分析</UiButton></div>
    <BusinessOperations v-show="tab === 'business'" /><section v-show="tab !== 'business'" class="panel"><h2>{{ tab === 'bottleneck' ? '准备一次完整链路分析' : '准备一次未来预约协同' }}</h2><p class="muted">{{ tab === 'bottleneck' ? '各承运商在车次登记中补充备车就绪、运输发车、园外集结和园区事件。系统分别显示环节有效样本，只对完整链路的同一批车次给出耗时排名。' : '先由各承运商填报半小时需求与可投入运输额度，再在下方维护园区接纳和作业容量。零需求要明确申报，缺报或容量未配置不会被当成零。' }}</p>
      <RoadMultiSelect v-model="roads" :options="[...PARK_ENTRANCES]" label="分析入口" hint="可多选，各入口分别计算。" />
      <div class="operations-fields"><template v-if="tab === 'bottleneck'"><label>到达区间起点（上海）<UiInput v-model="actualStart" type="datetime-local" /></label><label>到达区间终点（上海）<UiInput v-model="actualEnd" type="datetime-local" /></label></template><template v-else><label>计划时段起点（上海）<UiInput v-model="start" type="datetime-local" step="1800" /></label><label>计划时段终点（上海）<UiInput v-model="end" type="datetime-local" step="1800" /></label><label>结果分组粒度<UiSelect v-model="bucket"><option v-for="size in [30,60,120,240,720,1440]" :key="size" :value="size">{{ size }} 分钟</option></UiSelect></label></template></div>
      <UiAlert v-if="message" type="error">{{ message }}</UiAlert><div class="button-row"><UiButton class="primary" :disabled="capacityBusy || capacityDirty" @click="ask(tab === 'reservations')">带入 AI 对话</UiButton><span class="muted">{{ capacityDirty ? '请先保存或放弃下方容量草稿，再准备分析。' : '先填入问题，确认发送后再调用 Agent、执行隐私计算并生成报告。' }}</span></div>
    </section>
    <section v-show="tab === 'bottleneck'" class="panel operations-guide"><h2>怎样获得可比较的瓶颈结果</h2><ol><li>在承运商工作台的车次登记中，填写已发生的跨企业链路与园区事件，未知时间留空。</li><li>按入口、到达区间选择同一批车次；完整链路从备车就绪延伸到离园。</li><li>结果同时给出已有记录均值、有效车次、共同样本均值和环节占比。没有完整链路时保留观察值并提示补充。</li><li>耗时最长是复核线索；运输路线、任务难度和现场条件仍需人工核实，不能直接判定责任。</li></ol><p class="muted">请各公司在各自企业端补充本方车次链路。</p></section>
    <ReservationEditor v-show="tab === 'reservations'" @busy="capacityBusy = $event" @dirty="capacityDirty = $event" />
  </section>
</template>
<style scoped>
.operations-page{max-width:1280px;margin:0 auto}.operations-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin:20px 0}.operations-fields label{display:grid;gap:8px;font-size:13px;color:var(--text-secondary)}.operations-guide ol{padding-left:22px;color:var(--text-secondary);line-height:1.95}.operations-guide li{margin:12px 0}.operations-page>.agent-tabs{margin-bottom:22px}
</style>
