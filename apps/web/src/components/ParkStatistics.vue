<script setup lang="ts">
import { PARK_COHORT_LABELS, shanghaiDateTime, type Aggregate } from "@vectra/shared";
import BottleneckResult from "./BottleneckResult.vue";
defineProps<{ result: Aggregate }>();
</script>
<template>
  <BottleneckResult v-if="result.query?.analysis === 'bottleneck'" :result="result" />
  <template v-else>
  <section class="park-statistics" aria-label="园区联合运营结果"><h3>{{ result.parkContext?.settings.name || '园区联合运营结果' }}</h3><p v-if="result.parkContext">参与承运商：{{ result.parkContext.settings.carriers.map(c => c.name).join('、') }}</p><p v-if="result.query">{{ PARK_COHORT_LABELS[result.query.cohort ?? 'arrivals'] }} · {{ shanghaiDateTime(result.query.start) }} 至 {{ shanghaiDateTime(result.query.end) }}（含起点、不含终点）</p><p v-if="result.parkContext">本次数据截至 {{ shanghaiDateTime(result.parkContext.dataUpdatedAt) }} 导入的快照，后续事件更新需重新导入。</p>
    <section v-for="group in result.groups" :key="group.road" class="road-result"><h4>{{ group.road }}</h4><div v-if="group.coverage" class="coverage"><span>选取 <b>{{ group.coverage.visits }}</b> 个车次</span><span>已离园 <b>{{ group.coverage.completed }}</b></span><span>未离园 <b>{{ group.coverage.unfinished }}</b></span><span>有数据 <b>{{ group.coverage.contributingCarriers }} / 3</b> 家承运商</span></div><p v-if="group.coverage && group.coverage.contributingCarriers < 3" class="coverage-note">三个节点均参与本轮协议；所选道路与时段只有 {{ group.coverage.contributingCarriers }} 家提供有效车次，不能视为三家业务数据齐全。</p><UiTable class="readable-table"><thead><tr><th>运营指标</th><th>结果</th><th>参与计算车次</th></tr></thead><tbody><tr v-for="metric in group.metrics" :key="metric.label"><td>{{ metric.label }}</td><td><strong>{{ metric.value === null ? '无数据' : metric.value.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) }}</strong> {{ metric.value === null ? '' : metric.unit }}<small v-if="metric.note">{{ metric.note }}</small></td><td>{{ metric.validSamples }}<small v-if="group.coverage && metric.validSamples < group.coverage.visits">其余车次缺少所需字段或未满足本指标筛选条件</small></td></tr></tbody></UiTable></section>
    <p class="result-note">时长只使用两个端点齐全的车次，未离园车次不计入完整周转均值。用电为有数据的已完成车次完整行程用电；比例使用具备对应数据的车次作为分母。不同道路的车辆数请勿直接相加。</p><details><summary>数据版本与统计含义</summary><p class="version">快照：{{ result.datasetVersion }} · {{ result.participantCount }} 个承运商计算节点</p><p>“按到达时间”适合观察到园批次，可能仍有长时间未完成的车次；“按离园时间”适合观察已完成吞吐，两种口径不能直接混用。改善前后比较需采用相同指标、车次口径和数据完整度，单次观察不能证明因果关系。</p></details>
  </section>
  </template>
</template>
<style scoped>
.park-statistics{min-width:0;line-height:1.8;padding:20px;background:#f4f9f5;border:1px solid #dce8df;border-radius:14px}.park-statistics h3{margin-top:0}.park-statistics p{font-size:12px;color:#607668}.road-result{margin-top:24px}.coverage{display:flex;flex-wrap:wrap;gap:12px;font-size:12px}.coverage span{padding:6px 10px;border-radius:8px;background:white}.coverage-note{color:#9d6436!important}.readable-table{table-layout:fixed;width:100%;font-size:12px}.readable-table td,.readable-table th{overflow-wrap:anywhere;white-space:normal}.readable-table small{display:block;color:#788a7c;font-size:11px;font-weight:400}.version{overflow-wrap:anywhere}.result-note{margin-top:20px}summary{cursor:pointer;font-size:12px}
</style>
