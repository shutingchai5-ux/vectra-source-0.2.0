<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { PARK_ENTRANCES, isParkEntrance, type ParkCatalog } from "@vectra/shared";
import { api } from "../api";
const emit = defineEmits<{ choose: [question: string] }>();
const index = ref(0), paused = ref(false), hovered = ref(false), focused = ref(false), hidden = ref(false), roads = ref<string[]>([]);
const firstRoad = computed(() => roads.value[0] || PARK_ENTRANCES[0]);
const roadPair = computed(() => [...new Set([...roads.value, ...PARK_ENTRANCES])].slice(0, 2).join("、"));
const slides = computed(() => [
  { category: "需求与到达弹性", scope: "未预约需求、最低保留与可调整车次，提前和延后不重复相加", question: `统计 ${firstRoad.value} 未来六小时的运输需求与到达弹性，按120分钟分组，比较未预约车次、可调整车次与需求作业量，说明资料完整程度。` },
  { category: "装载与空驶", scope: "同批完整记录加权计算利用率、低装载比例与空驶率", question: `统计 ${firstRoad.value} 昨天已离园车次的实际载货吨数、按载重加权的装载利用率、载重利用率低于50%的记录比例和联合空驶率。` },
  { category: "回程运力", scope: "粗区域与时段内的联合车次额度，保留企业订单与路线明细", question: `统计 ${firstRoad.value} 未来六小时可利用回程车次，仅选择华东粗区域，按120分钟分组并说明资料范围。` },
  { category: "分时补能", scope: "电量在企业内派生，联合结果与园区充电容量比较", question: `统计 ${firstRoad.value} 未来六小时的充电需求，按120分钟分组，比较各接口电量、两小时内截止请求与园区充电容量，说明电量缺口及缺失信息。` },
  { category: "跨企业瓶颈", scope: "九个链路环节；完整链路共同样本排名，缺失不补零", question: `分析 ${firstRoad.value} 今天到达车次的跨企业等待与周转瓶颈，比较各环节耗时并说明完整链路覆盖。` },
  { category: "未来预约协同", scope: "独立申报计划与运力，比较园区容量，建议不自动改写预约", question: `统计 ${firstRoad.value} 未来两小时的预约需求与运力计划，按30分钟分组，核对入口及作业资源，给出错峰建议。` },
  { category: "到达车次", scope: "三家承运商联合统计，区分车次数与去重车辆数", question: `统计 ${firstRoad.value} 今天到达的车次数、车辆数和未离园车次数。` },
  { category: "入口排队", scope: "实际到达至开始核验的时长；缺少端点不补零", question: `统计 ${firstRoad.value} 今天到达车次的平均排队时长，以及排队超过30分钟的比例。` },
  { category: "作业资源", scope: "分别观察入口核验、场内待作业和实际作业时间", question: `统计 ${firstRoad.value} 今天到达车次的平均核验时长、平均场内待作业时长和平均作业时长。` },
  { category: "预约时段", scope: "按实际到达是否落在预约窗口内计算，缺少预约的车次不参与", question: `统计 ${firstRoad.value} 今天到达车次的预约准点率和平均排队时长，给出人工调整预约时段的建议。` },
  { category: "运输用电", scope: "已完成车次完整行程电耗，支持总量、单车次均值和百公里电耗", question: `统计 ${firstRoad.value} 昨天离园车次的总用电量、平均每车次用电、总里程和每百公里电耗。` },
  { category: "入口比较", scope: "固定四个入口可组合比较，分别计算；车辆数不跨入口直接相加", question: `分别统计 ${roadPair.value} 今天到达的车次数、平均排队时长和排队时长标准差。` },
  { category: "离园吞吐", scope: "按离园时间选已完成车次，与到达批次保持口径区分", question: `统计 ${firstRoad.value} 昨天离园的车次数、车辆数和平均周转时长，生成签名报告。` },
  { category: "改善复核", scope: "上海时区、单次最多31天；分别查询前后区间，保留覆盖与缺失情况", question: `统计 ${firstRoad.value} 昨天到达车次的平均排队时长、排队超30分钟比例和平均周转时长，并说明比较改善效果时的限制。` },
]);
const current = computed(() => slides.value[index.value]);
let timer: ReturnType<typeof setInterval> | undefined;
const visibility = () => { hidden.value = document.hidden; };
function change(step: number) { index.value = (index.value + step + slides.value.length) % slides.value.length; }
function focusOut(event: FocusEvent) { focused.value = !!event.relatedTarget && (event.currentTarget as HTMLElement).contains(event.relatedTarget as Node); }
onMounted(async () => {
  paused.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  visibility(); document.addEventListener("visibilitychange", visibility);
  timer = setInterval(() => { if (!paused.value && !hovered.value && !focused.value && !hidden.value) change(1); }, 6000);
  try { roads.value = (await api<ParkCatalog>("/api/park")).roads.map(road => road.id).filter(isParkEntrance); } catch { /* Examples never generate data. */ }
});
onUnmounted(() => { if (timer) clearInterval(timer); document.removeEventListener("visibilitychange", visibility); });
</script>
<template>
  <section class="question-suggestions" aria-label="猜你想问：可组合的统计能力" aria-roledescription="轮播" @mouseenter="hovered = true" @mouseleave="hovered = false" @focusin="focused = true" @focusout="focusOut">
    <div class="suggestion-heading"><span><strong>猜你想问</strong><small>把这些能力组合成你的问题</small></span><div class="suggestion-controls"><span>{{ index + 1 }} / {{ slides.length }}</span><UiButton type="button" aria-label="上一条建议" @click="change(-1)">‹</UiButton><UiButton type="button" :aria-label="paused ? '继续自动播放' : '暂停自动播放'" :aria-pressed="paused" @click="paused = !paused">{{ paused ? '播放' : '暂停' }}</UiButton><UiButton type="button" aria-label="下一条建议" @click="change(1)">›</UiButton></div></div>
    <div class="suggestion-stage" aria-live="off"><Transition name="question-roll" mode="out-in"><UiButton :key="index" type="button" class="question-slide" :aria-label="`将问题填入输入框：${current.question}`" @click="emit('choose', current.question)"><span class="suggestion-category">{{ current.category }}</span><span class="suggestion-scope">{{ current.scope }}</span><span class="suggestion-question">{{ current.question }}<span aria-hidden="true"> ↗</span></span></UiButton></Transition></div>
    <div class="suggestion-foot"><span>示例使用固定四个入口 · 点击填入，可修改后发送</span><RouterLink :to="{ path: '/operations' }">查看数据与口径 ↗</RouterLink></div>
  </section>
</template>
<style scoped>
.question-suggestions { margin:0 0 18px; padding:16px 20px 12px; border:1px solid #e0e9e3; border-radius:18px; background:linear-gradient(120deg,#f8fbf9,#f3f8f6); }
.suggestion-heading,.suggestion-controls,.suggestion-foot { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.suggestion-heading>span { display:flex; align-items:center; gap:12px; }.suggestion-heading strong { font-size:14px; color:#335b4a; }.suggestion-heading small,.suggestion-controls>span { font-size:11px; color:#89978e; }
.suggestion-controls { justify-content:flex-end; gap:8px; }.suggestion-controls button { border:0; background:transparent; color:#527363; cursor:pointer; font-size:12px; padding:3px 7px; border-radius:6px; }.suggestion-controls button:hover { background:#e4eee7; }
.suggestion-stage { overflow:hidden; min-height:108px; display:grid; align-items:center; }
.question-slide { width:100%; display:grid; grid-template-columns:105px 1fr; gap:8px 14px; border:0; padding:15px 0; background:transparent; text-align:left; cursor:pointer; color:#364d40; }
.suggestion-category { font-size:12px; align-self:start; color:#26795c; font-weight:600; }.suggestion-scope { font-size:12px; line-height:1.8; color:#718477; }.suggestion-question { grid-column:2; font-size:14px; line-height:1.9; color:#334e3e; }.question-slide:hover .suggestion-question { color:#118260; }
.suggestion-foot { font-size:10px; color:#8b998f; padding-top:8px; border-top:1px solid #e4ece6; }.suggestion-foot a { color:#668673; }
.question-roll-enter-active,.question-roll-leave-active { transition:opacity .22s ease,transform .22s ease; }.question-roll-enter-from { opacity:0; transform:translateY(14px); }.question-roll-leave-to { opacity:0; transform:translateY(-14px); }
button:focus-visible { outline:2px solid #168765; outline-offset:3px; }
@media (prefers-reduced-motion:reduce) { .question-roll-enter-active,.question-roll-leave-active { transition:none; } }
</style>
