<script setup lang="ts">
import { computed } from "vue";
import { coordinateReservations, shanghaiDateTime, type Aggregate } from "@vectra/shared";
const props = defineProps<{ result: Aggregate }>();
const coordination = computed(() => props.result.coordination ?? coordinateReservations(props.result.groups ?? [], props.result.reservationContext ?? { slotMinutes: 30, capacities: [] }));
const total = computed(() => coordination.value.rows.reduce((sum, row) => sum + row.expectedTrips, 0));
const unknown = computed(() => coordination.value.rows.filter(row => row.recommendedTrips === null).length);
const text = (value: number | null, unit: string) => value === null ? "未完整配置" : value.toLocaleString("zh-CN", { maximumFractionDigits: 1 }) + unit;
</script>
<template>
  <section class="reservation-result" aria-label="未来预约需求与运力协同结果">
    <h3>预约需求与运力协同</h3><p class="muted" v-if="result.query">{{ shanghaiDateTime(result.query.start) }} 至 {{ shanghaiDateTime(result.query.end) }} · 每 {{ result.query.bucketMinutes }} 分钟分组 · 上海时区</p>
    <UiAlert>以下为申报计划与协调建议，不代表实际到园或已经确认的预约。按半小时计划的开始时间筛选，边界时段不拆分折算；运输运力以分配给入口时段的车次额度计算。</UiAlert>
    <div class="reservation-result-summary"><div><small>已申报预计到园</small><strong>{{ total }}<span>车次</span></strong></div><div><small>入口时段</small><strong>{{ coordination.rows.length }}<span>组</span></strong></div><div><small>申报或容量不完整</small><strong>{{ unknown }}<span>组</span></strong></div></div>
    <div class="readable-table-container"><UiTable class="coordination-table"><thead><tr><th>时段 / 入口</th><th>申报需求 / 运力</th><th>入口接纳额度</th><th>预计作业 / 可用资源</th><th>建议安排</th></tr></thead><tbody><tr v-for="row in coordination.rows" :key="row.road + ':' + row.start"><td><strong>{{ row.road }}</strong><small>{{ shanghaiDateTime(row.start) }}<br />至 {{ shanghaiDateTime(row.end) }}</small></td><td>{{ row.expectedTrips }} / {{ row.availableTrips }} 车次<small>{{ row.inputMissing ? '申报覆盖不完整' : '三家完整申报' }}</small></td><td>{{ text(row.entryCapacity, '车次') }}<small v-if="row.entryGap">超出 {{ row.entryGap }} 车次</small></td><td>{{ row.requiredWorkMinutes.toLocaleString('zh-CN') }} / {{ text(row.serviceCapacityMinutes, '分钟') }}<small v-if="row.workGapMinutes">缺口 {{ row.workGapMinutes.toLocaleString('zh-CN') }} 分钟</small></td><td><strong>{{ row.recommendedTrips === null ? '待补齐资料' : row.recommendedTrips + '车次' }}</strong><small>{{ row.reasons.join('；') || '申报需求在当前额度内' }}</small><small v-if="row.unarrangedTrips">尚需协调 {{ row.unarrangedTrips }} 车次</small></td></tr></tbody></UiTable></div>
    <section class="coordination-suggestions"><h4>可供人工核对的错峰建议</h4><ul v-if="coordination.suggestions.length"><li v-for="(item,index) in coordination.suggestions" :key="index">{{ item.road }}：将 {{ shanghaiDateTime(item.from) }} 时段的 {{ item.trips }} 个车次，优先与 {{ shanghaiDateTime(item.to) }} 时段协商，预计占用 {{ item.workMinutes.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) }} 作业分钟。</li></ul><p v-else class="muted">当前查询范围没有同时满足完整申报、运输额度、入口额度和作业资源的后续可用时段；未生成具体挪移建议。</p><p class="muted">建议只考虑本次查询范围内、同一入口的后续时段；按申报平均作业量估算并避免重复占用目标额度。实际预约、车辆和作业资源需相关承运商与园区另行确认，本系统没有自动改写计划。</p></section>
  </section>
</template>
<style scoped>
.reservation-result{min-width:0}.reservation-result h3{font-size:19px;margin:0}.reservation-result-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.reservation-result-summary>div{padding:14px;border:1px solid var(--line);border-radius:10px;background:#f5f9f6}.reservation-result-summary small{font-size:12px;color:var(--muted)}.reservation-result-summary strong{display:block;font-size:26px;color:#286a4b}.reservation-result-summary strong span{font-size:12px;margin-left:7px;font-weight:400}.coordination-table{table-layout:fixed;font-size:13px}.coordination-table th:first-child{width:24%}.coordination-table small{display:block;font-size:12px;color:var(--muted);margin-top:5px;line-height:1.8}.coordination-suggestions{padding-top:17px}.coordination-suggestions h4{font-size:16px}.coordination-suggestions li{font-size:14px;color:var(--text-secondary);line-height:1.9;margin:10px 0}.reservation-result .readable-table-container{max-width:100%}
</style>
