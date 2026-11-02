<script setup lang="ts">
import { computed } from "vue";
import { summarizeBottleneck, shanghaiDateTime, PARK_COHORT_LABELS, type Aggregate } from "@vectra/shared";
const props = defineProps<{ result: Aggregate }>();
const groups = computed(() => (props.result.groups ?? []).map(group => ({ ...group, diagnosis: summarizeBottleneck(group) })));
const minutes = (value: number | null) => value === null ? "缺少数据" : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " 分钟";
</script>
<template>
  <section class="bottleneck-result" aria-label="跨企业等待与周转瓶颈分析">
    <div class="panel-heading"><div><h3>跨企业等待与周转瓶颈</h3><p class="muted" v-if="result.query">{{ PARK_COHORT_LABELS[result.query.cohort ?? 'arrivals'] }} · {{ shanghaiDateTime(result.query.start) }} 至 {{ shanghaiDateTime(result.query.end) }}（含起点、不含终点）</p></div></div>
    <p class="muted">覆盖承运商备车、运输、园外等候和园区作业。每个环节的观察值使用实际可用车次；排名和占比统一使用同一批完整链路车次。</p>
    <section v-for="group in groups" :key="group.road" class="bottleneck-road">
      <h4>{{ group.road }}</h4><div class="bottleneck-facts"><span>选取 {{ group.coverage?.visits ?? 0 }} 个车次</span><span>完整链路 {{ group.diagnosis.complete }} 个</span><span>有数据 {{ group.coverage?.contributingCarriers ?? 0 }}/3 家</span><span>完整链路平均 {{ minutes(group.diagnosis.total) }}</span></div>
      <UiAlert v-if="!group.diagnosis.complete" type="warning">尚无完整链路共同样本，暂不给出瓶颈排名。{{ group.diagnosis.missingStages.length ? '需要补充：' + group.diagnosis.missingStages.join('、') + '。' : '各环节虽有记录，但没有同一车次覆盖全部环节。' }}下表仍展示已有观察值，缺失未补零。</UiAlert>
      <div v-else-if="group.diagnosis.ranking.length" class="bottleneck-highlight"><strong>优先复核：{{ group.diagnosis.leaders.join('、') }}</strong><p>在 {{ group.diagnosis.complete }} 个共同样本中平均耗时最长，为 {{ minutes(group.diagnosis.ranking[0]?.comparable ?? null) }}。耗时排名帮助定位复核方向，不代表已证明责任或因果。</p></div>
      <UiAlert v-else type="warning">完整链路记录的各环节时长均为零，暂不指定瓶颈，请先核对事件时间与记录精度。</UiAlert>
      <div class="readable-table-container"><UiTable class="bottleneck-table"><thead><tr><th>环节</th><th>已有记录均值</th><th>有效车次</th><th>完整链路均值</th><th>完整链路占比</th></tr></thead><tbody><tr v-for="stage in group.diagnosis.stages" :key="stage.field"><td>{{ stage.label }}</td><td>{{ minutes(stage.observed) }}</td><td>{{ stage.validSamples }}</td><td>{{ minutes(stage.comparable) }}</td><td><template v-if="stage.share !== null"><span>{{ stage.share.toFixed(1) }}%</span><div class="bottleneck-bar"><i :style="{ width: Math.min(100, stage.share) + '%' }"></i></div></template><span v-else>暂无可比结果</span></td></tr></tbody></UiTable></div>
    </section>
    <p class="muted">运输在途本身包含必要运输时间。优先改善方向还需结合路线、任务和现场条件核实；未完成车次不能作为完整端到端周转样本。结果来自本轮冻结快照。</p>
  </section>
</template>
<style scoped>
.bottleneck-result{min-width:0}.bottleneck-result h3{font-size:19px;margin:0}.bottleneck-road{padding:20px 0;border-top:1px solid var(--line);margin-top:20px}.bottleneck-road h4{font-size:17px;margin:0 0 14px}.bottleneck-facts{display:flex;flex-wrap:wrap;gap:9px;font-size:12px;color:var(--text-secondary)}.bottleneck-facts span{background:#eff5f1;border-radius:7px;padding:6px 10px}.bottleneck-highlight{background:#f0f7f3;border:1px solid #d4e7db;border-radius:10px;padding:15px 17px;margin:18px 0}.bottleneck-highlight strong{color:#2b6e4d}.bottleneck-highlight p{font-size:13px;color:var(--text-secondary);margin:7px 0 0}.bottleneck-table{table-layout:fixed;font-size:13px}.bottleneck-table th:first-child{width:19%}.bottleneck-bar{height:5px;background:#e7eee9;border-radius:4px;margin-top:7px;overflow:hidden}.bottleneck-bar i{display:block;height:100%;background:#62a181}
</style>
