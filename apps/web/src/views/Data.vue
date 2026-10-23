<script setup lang="ts">
import { onMounted, ref } from "vue";
import { STAT_OPERATIONS, shanghaiDateTime, type DataCatalog } from "@vectra/shared";
import { api, time } from "../api";
import VehicleDataEditor from "../components/VehicleDataEditor.vue";
const catalog = ref<DataCatalog>(), busy = ref(false), message = ref("");
const example = JSON.stringify([{ vehicleId: "car-001", road: "S103", recordedAt: "2026-10-22T10:00:00+08:00", speed: 42.5, distanceKm: 0.35, energyKwh: 0.052 }, { vehicleId: "car-002", road: "S103", recordedAt: "2026-10-22T10:00:00+08:00", speed: 38, distanceKm: 0.31, energyKwh: 0.046 }], null, 2);
onMounted(async () => { try { catalog.value = await api<DataCatalog>("/api/telemetry"); } catch (e) { message.value = String(e); } });
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file) return;
  busy.value = true; message.value = "";
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("JSON 文件最大 2 MiB。");
    const records = JSON.parse(await file.text());
    catalog.value = await api<DataCatalog>("/api/telemetry", { method: "POST", body: JSON.stringify(records) });
    message.value = "导入成功。后续新任务使用此快照，正在执行的任务继续使用原版本。";
  } catch (e) { message.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; input.value = ""; }
}
</script>
<template>
  <section class="data-page">
    <h1>车辆数据</h1><p>车辆数量由你配置，不固定为三辆。可直接编辑或导入多辆车的时间序列，系统自动分配到三个隐私计算节点。模型只读取数据目录与批准结果。</p>
    <div class="data-actions"><label class="data-upload">导入 JSON 快照<input type="file" accept=".json,application/json" :disabled="busy" @change="importFile" /></label><RouterLink to="/">前往对话统计 ↗</RouterLink></div>
    <p v-if="message" role="status">{{ message }}</p>
    <template v-if="catalog"><p><strong>本地导入数据</strong> · {{ shanghaiDateTime(catalog.updatedAt) }} 更新 · 版本 {{ catalog.version }}</p><p v-if="!catalog.roads.length">尚无车辆数据，请先导入带时间戳的记录。</p>
      <div class="fleet-summary"><strong>{{ catalog.vehicleCount }} 辆车</strong><span>{{ catalog.sampleCount }} 条采样 · {{ catalog.roads.length }} 个路段 · {{ catalog.nodes.length }} 个计算节点</span></div><div class="node-distribution"><span v-for="(node, i) in catalog.nodes" :key="node.id">计算节点 {{ String.fromCharCode(65 + i) }}：{{ node.vehicleCount }} 辆车 / {{ node.sampleCount }} 条记录</span></div>
      <table class="readable-table"><thead><tr><th>路段</th><th>车辆数</th><th>记录数</th><th>最早采样（上海）</th><th>最新采样（上海）</th><th>可用字段</th></tr></thead><tbody><tr v-for="road in catalog.roads" :key="road.id"><td>{{ road.id }}</td><td>{{ road.vehicleCount }}</td><td>{{ road.sampleCount }}</td><td>{{ time(road.start) }}</td><td>{{ time(road.end) }}</td><td>{{ road.fields.map(f => ({ speed: '速度', distanceKm: '里程增量', energyKwh: '能耗增量' }[f] || f)).join('、') }}</td></tr></tbody></table>
    </template>
    <VehicleDataEditor :version="catalog?.version" @saved="catalog = $event" @loaded="catalog = $event" />
    <h2>让模型组合统计指标</h2><p>例如：“分别统计 S101、S102 过去 10 分钟的车辆数、平均速度、速度标准差，以及速度低于 20 km/h 的样本占比。”或者：“统计 S101 过去一小时总里程、总能耗和每百公里能耗。”</p>
    <p>支持计数、去重车辆数、求和、均值、总体方差、总体标准差、条件样本比例与总量比值。最多 8 个路段、12 个指标、31 天。路段必须有已导入数据；没有样本或缺少字段时明确显示无数据。</p>
    <details><summary>导入格式与指标口径</summary><p>文件为 JSON 数组，一次 1—6000 条、最大 2 MiB。导入发布新快照，取代后续任务使用的当前数据；进行中的任务与历史报告保留版本绑定。更新文件应包含本次希望查询的完整数据。</p><pre>{{ example }}</pre>
      <p>只需为每辆车填写不同的 vehicleId，同一辆车的多条记录沿用相同编号。participant 可以省略，系统按车辆编号稳定分配计算节点；也可明确指定 vehicle-a、vehicle-b 或 vehicle-c，同一车辆的所有记录使用同一归属。三个节点不是三辆车，每个节点可托管多辆车。</p><p>recordedAt 支持 Unix 毫秒或 ISO 时间，未注明时区按上海处理。速度单位 km/h；distanceKm 与 energyKwh 为各采样区间的增量，不能填累计里程或累计电量，否则求和会重复计算。</p>
      <p>均值按样本加权，停车或低速比例按样本数计算，不能解释为停车持续时间。车辆数在每个路段分别去重，跨路段不能直接相加。尚无真实过车流量、最值、中位数、分位数或地图数据；不会让模型通过任意代码代算。定点精度为 0.0001。</p>
      <p>导入快照不会随时间自动刷新。查询区间没有新采样时会显示无数据，请按需导入更新记录。操作名：{{ STAT_OPERATIONS.join('、') }}。</p>
    </details>
  </section>
</template>
<style scoped>
.data-page { max-width: 1120px; margin: 0 auto; padding: 36px 28px; line-height: 1.8; }
.data-actions { display: flex; flex-wrap: wrap; gap: 18px; align-items: center; margin: 24px 0; }
.data-upload { display: grid; gap: 8px; } pre { white-space: pre-wrap; padding: 18px; background: var(--surface, #f4f6f5); border-radius: 10px; }
h2 { margin-top: 28px; } details { margin-top: 24px; } summary { cursor: pointer; font-weight: 600; }
.fleet-summary,.node-distribution { display:flex; align-items:center; gap:20px; margin:16px 0; }.fleet-summary strong { font-size:25px; color:#347158; }.fleet-summary span,.node-distribution { font-size:12px; color:#819486; }.node-distribution span { background:#f0f6f2; border-radius:8px; padding:8px 12px; }
</style>
