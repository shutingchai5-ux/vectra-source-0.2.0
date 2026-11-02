<script setup lang="ts">
import { computed } from "vue";
import { BUSINESS_DOMAINS,CHARGE_CONNECTORS,chargeCapacityResult,shanghaiDateTime,type Aggregate } from "@vectra/shared";
const props=defineProps<{result:Aggregate}>();
const domain=computed(()=>props.result.query?.domain),planned=computed(()=>domain.value!=="haulage");
const capacities=computed(()=>domain.value==="charging"?chargeCapacityResult(props.result.groups??[],props.result.businessContext?.chargingWindows??[],props.result.query?.metrics):[]);
const number=(value:number|null|undefined)=>value==null?"未能确定":value.toLocaleString("zh-CN",{maximumFractionDigits:3});
</script>
<template>
  <section class="business-result">
    <h3>{{ domain ? BUSINESS_DOMAINS[domain] : '企业联合经营统计' }} · {{ planned ? '申报计划' : '已离园实绩' }}</h3>
    <p v-if="result.query" class="muted">{{ shanghaiDateTime(result.query.start) }} 至 {{ shanghaiDateTime(result.query.end) }}（上海时间，含起点、不含终点）。{{ domain === 'demand' && result.query.businessSelection === 'deadline' ? '按最晚到达时间选取需求。' : domain === 'haulage' ? '按实际离园时间选取同一批车次。' : '按计划开始时间归入一个时段，每条记录只计一次。' }}</p>
    <UiAlert v-if="planned" type="info">以下是各公司申报的需求或额度，仍需人工确认安排。计划不代表车辆已经到园、完成运输或完成充电。</UiAlert>
    <section v-for="(group,index) in result.groups" :key="group.road + ':' + (group.slotStart ?? index)" class="business-group">
      <div class="business-group-heading"><h4>{{ group.road }}<small v-if="group.slotStart !== undefined">{{ shanghaiDateTime(group.slotStart) }} 至 {{ shanghaiDateTime(group.slotEnd!) }}</small></h4><UiTag :type="group.businessCoverage?.declaredCarriers === 3 ? 'success' : 'warning'">资料声明 {{ group.businessCoverage?.declaredCarriers ?? 0 }}/3 家</UiTag></div>
      <p class="coverage-note">收到 {{ group.businessCoverage?.records ?? 0 }} 条申报 / 实绩，涉及 {{ group.businessCoverage?.contributingCarriers ?? 0 }} 家有记录公司。{{ group.businessCoverage?.declaredCarriers === 3 ? '三家公司均声明该范围资料已核对；空台账可表示明确为零。可选字段仍可能缺失，请同时查看各指标有效记录。' : '资料未覆盖全部公司；数值仅反映已收到的记录，不能当成完整联合需求，缺报也不能当作零。' }}</p>
      <UiTable class="readable-table"><thead><tr><th>指标</th><th>联合结果</th><th>有效记录</th></tr></thead><tbody><tr v-for="metric in group.metrics" :key="metric.label"><td>{{ metric.label }}<small v-if="metric.note">{{ metric.note }}</small></td><td><strong>{{ number(metric.value) }}</strong> {{ metric.value == null ? '' : metric.unit }}</td><td>{{ metric.validSamples }}</td></tr></tbody></UiTable>
    </section>
    <section v-if="capacities.length" class="charging-comparison"><h4>充电需求与园区电量预算</h4><p>只有三家公司均声明资料完整、且园区该接口所有半小时时段均配置容量，才计算缺口。电量充足仍须核对到达、截止时间、充电桩占用及车辆功率。</p><UiTable class="readable-table"><thead><tr><th>入口与时段</th><th>接口</th><th>申报电量</th><th>园区预算</th><th>电量缺口</th></tr></thead><tbody><template v-for="group in capacities" :key="group.road + group.start"><tr v-for="item in group.connectors" :key="item.connector"><td>{{ group.road }}<small>{{ shanghaiDateTime(group.start) }}</small></td><td>{{ CHARGE_CONNECTORS[item.connector] }}</td><td>{{ number(item.demandKwh) }} kWh</td><td>{{ number(item.capacityKwh) }} kWh</td><td>{{ item.gapKwh == null ? '资料或容量待补齐' : number(item.gapKwh) + ' kWh' }}</td></tr></template></tbody></UiTable></section>
    <p v-if="domain === 'demand'" class="result-boundary">可提前与可延后可能属于同一条需求，不能相加作为更多可调整车次。“两小时内到期”以本次查询起点为基准，最低保留车次不会被建议直接撤销。</p>
    <p v-if="domain === 'haulage'" class="result-boundary">装载利用率按同批具备载货量和适用容量的记录汇总后相除；空驶率按成对填写的载货与空驶里程计算。低装载比例须明确阈值。吨公里仅用于同一载货量适用于全段载货里程的参考情形。</p>
    <p v-if="domain === 'returns'" class="result-boundary">回程结果是所选粗区域、所选开始时段内的车次额度，用于观察联合机会；不会公开单家公司、车辆、订单或具体线路，也不会自动撮合或派车。</p>
    <p v-if="domain === 'charging'" class="result-boundary">各车的电池容量和当前电量在本公司内派生为需求电量，园区接收联合结果。缺少车辆功率的请求无法判断是否可按时完成；“无法完成”只表示已知功率上限下仍不够，不代表其余请求一定可行。</p>
    <details v-if="result.businessContext"><summary>资料版本与统计边界</summary><p>{{ result.businessContext.note }}</p><dl><template v-for="(version,owner) in result.businessContext.sourceVersions" :key="owner"><dt>{{ result.parkContext?.settings.carriers.find(item => item.id === owner)?.name ?? owner }}</dt><dd>{{ version }}</dd></template></dl></details>
  </section>
</template>
<style scoped>
.business-result{min-width:0}.business-result h3{font-size:17px}.business-result p{line-height:1.8}.business-group{margin-top:22px;padding-top:8px;border-top:1px solid var(--border)}.business-group-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.business-group-heading h4{margin:12px 0}.business-result small{display:block;font-weight:400;color:var(--text-secondary);line-height:1.6}.coverage-note,.result-boundary,.charging-comparison p{font-size:13px;color:var(--text-secondary)}.charging-comparison{margin:24px 0}.business-result th,.business-result td{white-space:normal;overflow-wrap:anywhere}.business-result details{margin-top:18px;font-size:13px}.business-result dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 18px}.business-result dd{margin:0;overflow-wrap:anywhere}
</style>
