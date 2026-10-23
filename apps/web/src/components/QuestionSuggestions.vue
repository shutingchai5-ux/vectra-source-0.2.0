<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { DataCatalog } from "@vectra/shared";
import { api } from "../api";
const emit = defineEmits<{ choose: [question: string] }>();
const index = ref(0), paused = ref(false), hovered = ref(false), focused = ref(false), hidden = ref(false), roads = ref<string[]>([]);
const firstRoad = computed(() => roads.value[0] || "S101");
const roadPair = computed(() => roads.value.slice(0, 2).join("、") || "S101、S102");
const slides = computed(() => [
  { category: "数据字段", scope: "速度（km/h）、里程增量（km）、能耗增量（kWh）", question: `统计 ${firstRoad.value} 过去一小时的平均速度、总里程和总能耗。` },
  { category: "聚合操作", scope: "样本数、去重车辆数、求和、均值、总体方差与标准差", question: `统计 ${firstRoad.value} 过去 10 分钟的车辆数、样本数和速度标准差。` },
  { category: "条件筛选", scope: "支持小于、小于等于、大于、大于等于、等于自定义阈值", question: `统计 ${firstRoad.value} 过去 15 分钟速度超过 60 km/h 的车辆数。` },
  { category: "比例指标", scope: "满足条件的样本数 ÷ 有效样本数，按百分比输出", question: `统计 ${firstRoad.value} 过去 15 分钟速度低于 20 km/h 的样本占比。` },
  { category: "派生指标", scope: "两个字段总量的比值，可乘以 100，组合每百公里能耗等指标", question: `统计 ${firstRoad.value} 过去一小时的总能耗、总里程和每百公里能耗。` },
  { category: "按路段分组", scope: "在已导入数据的路段内查询，每次最多 8 个路段，分别输出结果", question: `分别统计 ${roadPair.value} 过去 10 分钟的平均速度和车辆数。` },
  { category: "时间范围", scope: "支持相对时间或指定起止时间，统一上海时区，单次跨度最多 31 天", question: `统计 ${firstRoad.value} 今天截至当前的平均速度、样本数和停车样本比例。` },
  { category: "多指标组合", scope: "一次最多 12 个指标；无有效样本或分母为零时明确显示无数据", question: `分别统计 ${roadPair.value} 过去半小时的车辆数、平均速度、速度标准差和低于 20 km/h 的样本占比，生成签名报告。` },
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
  try { roads.value = (await api<DataCatalog>("/api/telemetry")).roads.map(road => road.id); } catch { /* Suggestions remain examples if the catalog is unavailable. */ }
});
onUnmounted(() => { if (timer) clearInterval(timer); document.removeEventListener("visibilitychange", visibility); });
</script>
<template>
  <section class="question-suggestions" aria-label="猜你想问：可组合的统计能力" aria-roledescription="轮播" @mouseenter="hovered = true" @mouseleave="hovered = false" @focusin="focused = true" @focusout="focusOut">
    <div class="suggestion-heading"><span><strong>猜你想问</strong><small>把这些能力组合成你的问题</small></span><div class="suggestion-controls"><span>{{ index + 1 }} / {{ slides.length }}</span><button type="button" aria-label="上一条建议" @click="change(-1)">‹</button><button type="button" :aria-label="paused ? '继续自动播放' : '暂停自动播放'" :aria-pressed="paused" @click="paused = !paused">{{ paused ? '播放' : '暂停' }}</button><button type="button" aria-label="下一条建议" @click="change(1)">›</button></div></div>
    <div class="suggestion-stage" aria-live="off"><Transition name="question-roll" mode="out-in"><button :key="index" type="button" class="question-slide" :aria-label="`将问题填入输入框：${current.question}`" @click="emit('choose', current.question)"><span class="suggestion-category">{{ current.category }}</span><span class="suggestion-scope">{{ current.scope }}</span><span class="suggestion-question">{{ current.question }}<span aria-hidden="true"> ↗</span></span></button></Transition></div>
    <div class="suggestion-foot"><span>{{ roads.length ? '示例使用已登记路段' : '示例路段需先导入车辆数据' }} · 点击填入，可修改后发送</span><RouterLink to="/data">查看数据与口径 ↗</RouterLink></div>
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
