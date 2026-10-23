<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { MAX_TELEMETRY_RECORDS, PARTICIPANTS, shanghaiTimestamp, type DataCatalog, type TelemetrySnapshot } from "@vectra/shared";
import { api } from "../api";
const props = defineProps<{ version?: string }>();
const emit = defineEmits<{ saved: [catalog: DataCatalog]; loaded: [catalog: DataCatalog] }>();
type NumberInput = string | number;
interface Draft { key: string; vehicleId: string; participant: string; road: string; recordedAt: string; speed: NumberInput; distanceKm: NumberInput; energyKwh: NumberInput }
const rows = ref<Draft[]>([]), baseVersion = ref(props.version || ""), dirty = ref(false), busy = ref(false), message = ref(""), failed = ref(false);
const batchCount = ref(1), batchRoad = ref(""), batchSpeed = ref<NumberInput>(""), page = ref(1), pageSize = 20;
const totalPages = computed(() => Math.max(1, Math.ceil(rows.value.length / pageSize)));
const pageRows = computed(() => rows.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const vehicleCount = computed(() => new Set(rows.value.map(row => row.vehicleId.trim()).filter(Boolean)).size);
const outdated = computed(() => !!baseVersion.value && !!props.version && baseVersion.value !== props.version);
watch(() => props.version, version => { if (!rows.value.length) baseVersion.value = version || ""; });
function fail(cause: unknown) { failed.value = true; message.value = cause instanceof Error ? cause.message : String(cause); }
// Vue's number inputs produce numbers after typing, and an empty string after clearing.
const numberInputText = (value: NumberInput) => String(value ?? "").trim();
function addVehicles() {
  message.value = ""; failed.value = false;
  const count = Number(batchCount.value);
  if (!Number.isInteger(count) || count < 1 || count + rows.value.length > MAX_TELEMETRY_RECORDS) { fail(new Error(`新增数量须为正整数，当前草稿最多 ${MAX_TELEMETRY_RECORDS} 条记录。`)); return; }
  if (numberInputText(batchSpeed.value) && (!Number.isFinite(Number(batchSpeed.value)) || Number(batchSpeed.value) < 0 || Number(batchSpeed.value) > 250)) { fail(new Error("批量速度须在 0—250 km/h 之间。")); return; }
  if (!rows.value.length) baseVersion.value = props.version || "";
  const used = new Set(rows.value.map(row => row.vehicleId)), recordedAt = shanghaiTimestamp(new Date()).slice(0, 23);
  let next = 1;
  for (let i = 0; i < count; i++) {
    while (used.has(`car-${String(next).padStart(4, "0")}`)) next++;
    const vehicleId = `car-${String(next++).padStart(4, "0")}`; used.add(vehicleId);
    rows.value.push({ key: crypto.randomUUID(), vehicleId, participant: "", road: batchRoad.value.trim(), recordedAt, speed: batchSpeed.value, distanceKm: "", energyKwh: "" });
  }
  dirty.value = true; page.value = totalPages.value;
  message.value = `已新增 ${count} 辆车的采样草稿，请检查下方记录，完成后保存并发布。`;
}
function copySample(row: Draft) {
  if (rows.value.length >= MAX_TELEMETRY_RECORDS) { fail(new Error("记录数已达到上限。")); return; }
  rows.value.push({ ...row, key: crypto.randomUUID(), recordedAt: "", speed: "", distanceKm: "", energyKwh: "" });
  dirty.value = true; page.value = totalPages.value;
}
function remove(key: string) { rows.value = rows.value.filter(row => row.key !== key); dirty.value = true; page.value = Math.min(page.value, totalPages.value); }
function clear() { rows.value = []; dirty.value = false; baseVersion.value = props.version || ""; page.value = 1; message.value = "草稿已清空，已发布数据未改变。"; failed.value = false; }
async function load() {
  busy.value = true; message.value = ""; failed.value = false;
  try {
    const snapshot = await api<TelemetrySnapshot>("/api/telemetry/records");
    rows.value = snapshot.records.map(record => ({ key: crypto.randomUUID(), vehicleId: record.vehicleId, participant: record.participant, road: record.road, recordedAt: shanghaiTimestamp(new Date(record.recordedAt)).slice(0, 23), speed: String(record.speed), distanceKm: record.distanceKm === undefined ? "" : String(record.distanceKm), energyKwh: record.energyKwh === undefined ? "" : String(record.energyKwh) }));
    baseVersion.value = snapshot.version; dirty.value = false; page.value = 1; emit("loaded", snapshot.catalog); message.value = `已载入 ${vehicleCount.value} 辆车、${rows.value.length} 条记录，可编辑后重新保存。`;
  } catch (cause) { fail(cause); } finally { busy.value = false; }
}
async function save() {
  busy.value = true; message.value = ""; failed.value = false;
  try {
    const records = rows.value.map((row, i) => {
      if (!row.vehicleId.trim() || !row.road.trim() || !row.recordedAt || !numberInputText(row.speed)) throw new Error(`第 ${i + 1} 条记录的车辆编号、路段、采样时间和速度均须填写。`);
      const recordedAt = Date.parse(`${row.recordedAt}+08:00`), speed = Number(row.speed);
      if (!Number.isFinite(recordedAt) || !Number.isFinite(speed) || speed < 0 || speed > 250) throw new Error(`第 ${i + 1} 条记录的时间或速度无效。`);
      const extra: { distanceKm?: number; energyKwh?: number } = {};
      for (const field of ["distanceKm", "energyKwh"] as const) if (numberInputText(row[field])) {
        const number = Number(row[field]); if (!Number.isFinite(number) || number < 0 || number > 1000) throw new Error(`第 ${i + 1} 条记录的里程或能耗须在 0—1000 之间。`); extra[field] = number;
      }
      return { vehicleId: row.vehicleId.trim(), ...(row.participant ? { participant: row.participant } : {}), road: row.road.trim(), recordedAt, speed, ...extra };
    });
    const body = JSON.stringify({ records, baseVersion: baseVersion.value });
    if (new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024) throw new Error("草稿超过 2 MiB，请减少记录后保存。");
    const catalog = await api<DataCatalog>("/api/telemetry", { method: "POST", body });
    baseVersion.value = catalog.version; dirty.value = false; emit("saved", catalog); message.value = `已发布 ${catalog.vehicleCount} 辆车、${catalog.sampleCount} 条记录。新任务将使用此版本。`;
  } catch (cause) { fail(cause); } finally { busy.value = false; }
}
</script>
<template>
  <section class="vehicle-editor" aria-label="自行配置车辆数据">
    <div class="editor-heading"><div><h2>自行配置车辆数据</h2><p>车辆数量由不同车辆编号自动统计，可新增任意批次；计算节点会自动分配。</p></div><button type="button" :disabled="busy" @click="load">{{ dirty ? '重新载入当前数据（覆盖草稿）' : '载入当前数据编辑' }}</button></div>
    <div class="batch-controls"><label>新增车辆数量<input v-model.number="batchCount" type="number" min="1" :max="MAX_TELEMETRY_RECORDS - rows.length" :disabled="busy" /></label><label>批量路段<input v-model="batchRoad" placeholder="例如 S101" maxlength="40" :disabled="busy" /></label><label>批量速度（可留空）<input v-model="batchSpeed" type="number" min="0" max="250" step="0.0001" placeholder="km/h" :disabled="busy" /></label><button type="button" :disabled="busy || rows.length >= MAX_TELEMETRY_RECORDS" @click="addVehicles">新增车辆</button></div>
    <p class="draft-info">草稿：{{ vehicleCount }} 辆车 · {{ rows.length }} 条记录<span v-if="dirty"> · 尚未保存</span>。每辆车可有多条采样记录，同一车辆请使用相同编号。</p>
    <p v-if="outdated" class="editor-warning">当前已发布的数据版本发生变化。请重新载入后编辑，避免覆盖其他操作。</p>
    <p v-if="message" :class="{ 'editor-warning': failed }" role="status">{{ message }}</p>
    <table v-if="rows.length" class="readable-table editor-table"><thead><tr><th>车辆编号</th><th>路段</th><th>采样时间（上海）</th><th>速度 km/h</th><th>里程增量 km</th><th>能耗增量 kWh</th><th>计算节点</th><th>操作</th></tr></thead><tbody @input="dirty = true" @change="dirty = true"><tr v-for="row in pageRows" :key="row.key"><td><input v-model="row.vehicleId" aria-label="车辆编号" maxlength="80" :disabled="busy" /></td><td><input v-model="row.road" aria-label="路段" maxlength="40" :disabled="busy" /></td><td><input v-model="row.recordedAt" type="datetime-local" step="0.001" aria-label="上海采样时间" :disabled="busy" /></td><td><input v-model="row.speed" type="number" min="0" max="250" step="0.0001" aria-label="速度" :disabled="busy" /></td><td><input v-model="row.distanceKm" type="number" min="0" max="1000" step="0.0001" aria-label="里程增量" :disabled="busy" /></td><td><input v-model="row.energyKwh" type="number" min="0" max="1000" step="0.0001" aria-label="能耗增量" :disabled="busy" /></td><td><select v-model="row.participant" aria-label="计算节点" :disabled="busy"><option value="">自动分配</option><option v-for="(node, i) in PARTICIPANTS" :key="node" :value="node">计算节点 {{ String.fromCharCode(65 + i) }}</option></select></td><td class="row-actions"><button type="button" :disabled="busy" @click="copySample(row)">追加采样</button><button type="button" :disabled="busy" @click="remove(row.key)">删除记录</button></td></tr></tbody></table>
    <div class="editor-footer"><div class="pagination"><button type="button" :disabled="busy || page <= 1" @click="page--">上一页</button><span>{{ page }} / {{ totalPages }} · 每页 {{ pageSize }} 条</span><button type="button" :disabled="busy || page >= totalPages" @click="page++">下一页</button></div><div class="save-actions"><button type="button" :disabled="busy || !rows.length" @click="clear">清空草稿</button><button type="button" class="primary" :disabled="busy || !rows.length || !baseVersion || outdated || !dirty" @click="save">{{ busy ? '正在处理…' : '保存并发布完整数据' }}</button></div></div>
    <p class="editor-note">新增行的速度不会自动生成，需自行填写。保存会以完整草稿替换后续任务使用的数据快照；仅载入或编辑不会改变已发布数据。最多 {{ MAX_TELEMETRY_RECORDS }} 条记录、2 MiB，不固定为三辆车。</p>
  </section>
</template>
<style scoped>
.vehicle-editor { margin:30px 0; padding:22px; border:1px solid #e0e8e2; border-radius:16px; background:#fbfdfb; }.editor-heading,.batch-controls,.editor-footer,.pagination,.save-actions { display:flex; gap:14px; align-items:center; justify-content:space-between; }.editor-heading h2 { margin:0; }.editor-heading p,.draft-info,.editor-note { color:#809084; font-size:12px; }.batch-controls { justify-content:flex-start; align-items:flex-end; margin:18px 0; }.batch-controls label { display:grid; gap:6px; color:#617767; font-size:12px; }.batch-controls input { max-width:155px; }.editor-table { font-size:11px; table-layout:fixed; }.editor-table th:nth-child(3) { width:185px; }.editor-table th:last-child { width:102px; }.editor-table input,.editor-table select { box-sizing:border-box; width:100%; min-width:0; padding:7px 5px; font-size:11px; }.editor-table th,.editor-table td { padding:8px 5px; }.row-actions button { display:block; padding:3px 7px; margin:3px 0; font-size:10px; }.editor-footer { margin-top:18px; font-size:11px; }.pagination,.save-actions { justify-content:flex-start; gap:10px; }.editor-warning { color:#a66336; font-size:12px; }button { white-space:nowrap; }button:disabled { opacity:.5; cursor:not-allowed; }
</style>
