<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { PARK_ENTRANCES, RESERVATION_SLOT_MS, MAX_WINDOW_MS, parseParkTimestamp, shanghaiTimestamp, shanghaiDateTime, type CarrierId, type ReservationSlot, type CapacitySlot, type ReservationCatalog, type ReservationSnapshot, type ReservationVersion } from "@vectra/shared";
import { api } from "../api";
import { carrierApi } from "../carrier-role";
import { useUnsavedChanges } from "../use-unsaved-changes";
const props = defineProps<{ carrierId?: CarrierId }>();
const emit = defineEmits<{ dirty: [value: boolean, carrierId?: CarrierId]; busy: [value: boolean, carrierId?: CarrierId] }>();
type Row = { road: string; slotStart: number; expectedTrips: number; availableTrips: number; requiredWorkMinutes: number; entryCapacity: number; serviceCapacityMinutes: number };
const rows = ref<Row[]>([]), baseline = ref("[]"), version = ref(""), busy = ref(false), message = ref(""), failed = ref(false), page = ref(1);
const versions = ref<ReservationVersion[]>([]), viewVersion = ref(""), activeVersion = ref("");
const readOnly = computed(() => !!viewVersion.value), historyOptions = computed(() => versions.value.filter(item => item.version !== activeVersion.value));
const capacityMode = computed(() => !props.carrierId), dirty = computed(() => JSON.stringify(rows.value) !== baseline.value);
const draft = reactive({ road: "东入口", slot: shanghaiTimestamp(Math.ceil((Date.now() + 1) / RESERVATION_SLOT_MS) * RESERVATION_SLOT_MS).slice(0, 16),
  count: 1, expectedTrips: 0, availableTrips: 0, requiredWorkMinutes: 0, entryCapacity: 0, serviceCapacityMinutes: 0 });
const heading = computed(() => capacityMode.value ? "园区时段容量" : "本方预约需求与运力");
const importExample = shanghaiTimestamp(Date.now() + 86400_000).slice(0, 10) + "T09:00:00+08:00";
const sorted = computed(() => [...rows.value].sort((a, b) => a.slotStart - b.slotStart || a.road.localeCompare(b.road)));
const pages = computed(() => Math.max(1, Math.ceil(sorted.value.length / 12))), visible = computed(() => sorted.value.slice((Math.min(page.value, pages.value) - 1) * 12, Math.min(page.value, pages.value) * 12));
useUnsavedChanges(() => dirty.value, heading.value, () => capacityMode.value);
watch(dirty, value => emit("dirty", value, props.carrierId), { immediate: true, flush: "sync" });
watch(busy, value => emit("busy", value, props.carrierId), { flush: "sync" });
const past = (row: Row) => row.slotStart <= Date.now();
const ended = (row: Row) => row.slotStart + RESERVATION_SLOT_MS <= Date.now();
const payload = (row: Row): ReservationSlot | CapacitySlot => {
  for (const field of capacityMode.value ? ["entryCapacity", "serviceCapacityMinutes"] as const : ["expectedTrips", "availableTrips", "requiredWorkMinutes"] as const)
    if (String(row[field]).trim() === "" || !Number.isFinite(Number(row[field]))) throw new Error("请完整填写时段数值；未知不自动补零。");
  return capacityMode.value
    ? { road: row.road, slotStart: row.slotStart, entryCapacity: Number(row.entryCapacity), serviceCapacityMinutes: Number(row.serviceCapacityMinutes) }
    : { carrierId: props.carrierId!, road: row.road, slotStart: row.slotStart, expectedTrips: Number(row.expectedTrips), availableTrips: Number(row.availableTrips), requiredWorkMinutes: Number(row.requiredWorkMinutes) };
};
function accept(value: ReservationCatalog | ReservationSnapshot) {
  const catalog = "catalog" in value ? value.catalog : value, source = "slots" in value ? value.slots : value.capacitySlots;
  version.value = catalog.version;
  rows.value = source.map(row => ({ expectedTrips: 0, availableTrips: 0, requiredWorkMinutes: 0, entryCapacity: 0, serviceCapacityMinutes: 0, ...row }));
  baseline.value = JSON.stringify(rows.value); page.value = 1;
  if (!readOnly.value) {
    activeVersion.value = catalog.version;
    versions.value = [{ version: catalog.version, updatedAt: catalog.updatedAt, rowCount: source.length }, ...versions.value.filter(item => item.version !== catalog.version)].slice(0, 50);
  }
}
async function load() {
  if (dirty.value) return; busy.value = true; message.value = "";
  try {
    const suffix = viewVersion.value ? "?version=" + encodeURIComponent(viewVersion.value) : "";
    const [snapshot, history] = await Promise.all([
      props.carrierId ? carrierApi<ReservationSnapshot>(props.carrierId, "/api/carrier/reservations" + suffix) : api<ReservationCatalog>("/api/reservations" + suffix),
      props.carrierId ? carrierApi<ReservationVersion[]>(props.carrierId, "/api/carrier/reservations/versions") : api<ReservationVersion[]>("/api/reservations/versions"),
    ]);
    versions.value = history; accept(snapshot); failed.value = false;
  }
  catch (cause) { failed.value = true; message.value = String(cause); } finally { busy.value = false; }
}
function add() {
  if (readOnly.value) return;
  failed.value = false; message.value = "";
  try {
    const start = parseParkTimestamp(draft.slot), count = Number(draft.count), now = Date.now();
    if (!Number.isSafeInteger(start) || start % RESERVATION_SLOT_MS || start <= now || !Number.isSafeInteger(count) || count < 1 || count > 48 || start + (count - 1) * RESERVATION_SLOT_MS > now + MAX_WINDOW_MS)
      throw new Error("请选择未来31天内的整点或半点，连续时段数为1—48。");
    const next = Array.from({ length: count }, (_, index) => ({ ...draft, slotStart: start + index * RESERVATION_SLOT_MS }));
    next.forEach(payload);
    if (next.some(row => rows.value.some(existing => existing.road === row.road && existing.slotStart === row.slotStart))) throw new Error("所选入口时段已在列表中，请直接修改对应行，避免重复申报。");
    if (rows.value.length + count > 6000) throw new Error("最多保存6000个时段，请缩小范围。");
    rows.value.push(...next);
    page.value = Math.floor(sorted.value.findIndex(row => row.road === next[0].road && row.slotStart === next[0].slotStart) / 12) + 1;
    message.value = "已加入草稿，请核对并保存。";
  } catch (cause) { failed.value = true; message.value = String(cause); }
}
async function save() {
  if (readOnly.value) return;
  busy.value = true; message.value = ""; failed.value = false;
  try {
    const data = rows.value.map(payload);
    accept(props.carrierId ? await carrierApi<ReservationSnapshot>(props.carrierId, "/api/carrier/reservations", { method: "PUT", body: JSON.stringify({ slots: data, baseVersion: version.value }) })
      : await api<ReservationCatalog>("/api/reservations/capacity", { method: "PUT", body: JSON.stringify({ capacitySlots: data, baseVersion: version.value }) }));
    message.value = "已保存并发布新版本；已有任务继续使用原冻结版本。";
  } catch (cause) { failed.value = true; message.value = String(cause); } finally { busy.value = false; }
}
async function importFile(event: Event) {
  if (readOnly.value) return;
  const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error("文件最多4MB。");
    const data: unknown = JSON.parse(await file.text());
    if (!Array.isArray(data) || data.length + rows.value.length > 6000) throw new Error("请导入时段JSON数组，总行数最多6000。");
    const existing = new Set(rows.value.map(row => row.road + ":" + row.slotStart));
    const incoming = data.map(raw => {
      const fields = capacityMode.value ? ["road", "slotStart", "entryCapacity", "serviceCapacityMinutes"] : ["carrierId", "road", "slotStart", "expectedTrips", "availableTrips", "requiredWorkMinutes"];
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key)) || fields.some(key => raw[key] === undefined) || !PARK_ENTRANCES.includes(raw.road) ||
        props.carrierId && raw.carrierId !== props.carrierId) throw new Error("格式或承运商归属不符，请按本页字段导入。");
      const slotStart = parseParkTimestamp(raw.slotStart), key = raw.road + ":" + slotStart;
      if (!Number.isSafeInteger(slotStart) || slotStart % RESERVATION_SLOT_MS || slotStart <= Date.now() || slotStart > Date.now() + MAX_WINDOW_MS || existing.has(key)) throw new Error("导入时段须为未来31天内尚未开始的整点或半点，且不能重复。");
      existing.add(key);
      return { expectedTrips: 0, availableTrips: 0, requiredWorkMinutes: 0, entryCapacity: 0, serviceCapacityMinutes: 0, ...raw, slotStart } as Row;
    });
    rows.value.push(...incoming); failed.value = false; message.value = "已导入草稿，尚未保存，请先核对。";
  } catch (cause) { failed.value = true; message.value = String(cause); } finally { input.value = ""; }
}
function discard() { rows.value = JSON.parse(baseline.value); message.value = "已还原上次保存的内容。"; }
function archive() {
  if (readOnly.value) return;
  rows.value = rows.value.filter(row => !ended(row));
  message.value = "已将结束时段移出当前草稿，保存后归档；原内容仍可在历史版本查看。";
}
onMounted(load);
</script>
<template>
  <section class="reservation-editor">
    <div class="panel-heading"><div><h2>{{ heading }}</h2><p class="muted">{{ capacityMode ? '分配给各入口的接纳额度与作业资源。共享资源请先划分额度，避免重复承诺。' : '按入口和半小时时段申报预计需求、可投入运输额度及预计作业量。零需求也请明确申报。' }}</p></div><UiButton class="secondary" :disabled="busy || dirty" @click="load">刷新台账</UiButton></div>
    <UiAlert class="reservation-notice">这是预约计划，不是入园登记。保存不会生成实际车次，也不会自动确认预约；已开始的时段只读，结束后可归档，原内容保留在历史快照。</UiAlert>
    <UiAlert v-if="readOnly" type="info">正在只读查阅历史快照。发起新的联合分析使用当前台账；既有报告继续使用各自冻结版本。</UiAlert>
    <div class="reservation-history"><label>查看台账版本（最近50个）<UiSelect v-model="viewVersion" :disabled="busy || dirty" @change="load"><option value="">当前台账</option><option v-for="item in historyOptions" :key="item.version" :value="item.version">{{ shanghaiDateTime(item.updatedAt) }} · {{ item.version.slice(0,8) }} · {{ item.rowCount }}个时段</option></UiSelect></label><UiTag v-if="readOnly">历史快照 · 只读</UiTag><UiButton v-if="readOnly" class="secondary" :disabled="busy" @click="viewVersion = ''; load()">返回当前台账</UiButton><UiButton v-else class="secondary" :disabled="busy || !rows.some(ended)" @click="archive">归档已结束时段</UiButton></div>
    <UiAlert v-if="message" :type="failed ? 'error' : 'info'" role="status">{{ message }}</UiAlert>
    <form class="panel reservation-draft" @submit.prevent="add">
      <h3>添加未来时段</h3><UiFieldset :disabled="busy || !version || readOnly"><div class="reservation-fields">
        <label>入口<UiSelect v-model="draft.road"><option v-for="road in PARK_ENTRANCES" :key="road" :value="road">{{ road }}</option></UiSelect></label>
        <label>开始时段（上海）<UiInput v-model="draft.slot" type="datetime-local" step="1800" required /></label>
        <label>连续半小时时段数<UiInput v-model.number="draft.count" type="number" min="1" max="48" required /></label>
        <template v-if="capacityMode"><label>每时段入口接纳额度（车次）<UiInput v-model.number="draft.entryCapacity" type="number" min="0" max="1000000" required /></label><label>每时段可用作业量（分钟）<UiInput v-model.number="draft.serviceCapacityMinutes" type="number" min="0" max="1000000" step="0.1" required /></label></template>
        <template v-else><label>每时段预计到园车次<UiInput v-model.number="draft.expectedTrips" type="number" min="0" max="1000000" required /></label><label>每时段可投入运输车次<UiInput v-model.number="draft.availableTrips" type="number" min="0" max="1000000" required /></label><label>每时段预计作业量（分钟）<UiInput v-model.number="draft.requiredWorkMinutes" type="number" min="0" max="1000000" step="0.1" required /></label></template>
      </div><div class="button-row"><UiButton type="submit" class="secondary">添加到草稿</UiButton><span class="muted">各连续时段填入相同数值，之后可逐行调整。</span></div></UiFieldset>
    </form>
    <section class="panel"><div class="panel-heading"><div><h3>已保存时段与当前草稿</h3><p class="muted">{{ rows.length }} 个时段 · 开始时间按上海时区显示</p></div><UiTag v-if="dirty">有未保存内容</UiTag></div>
      <UiTable v-if="visible.length" class="reservation-table"><thead><tr><th>时段开始（上海）/ 入口</th><template v-if="capacityMode"><th>接纳额度 / 车次</th><th>可用作业量 / 分钟</th></template><template v-else><th>预计到园 / 车次</th><th>可投入 / 车次</th><th>预计作业 / 分钟</th></template><th>操作</th></tr></thead><tbody>
        <tr v-for="row in visible" :key="row.road + ':' + row.slotStart"><td><strong>{{ shanghaiDateTime(row.slotStart) }}</strong><small>{{ row.road }} · {{ past(row) ? '时段已开始，只读保留' : '半小时时段' }}</small></td>
          <template v-if="capacityMode"><td><UiInput v-model.number="row.entryCapacity" type="number" min="0" max="1000000" :disabled="busy || readOnly || past(row)" aria-label="入口接纳额度" /></td><td><UiInput v-model.number="row.serviceCapacityMinutes" type="number" min="0" max="1000000" step="0.1" :disabled="busy || readOnly || past(row)" aria-label="可用作业量" /></td></template>
          <template v-else><td><UiInput v-model.number="row.expectedTrips" type="number" min="0" max="1000000" :disabled="busy || readOnly || past(row)" aria-label="预计到园车次" /></td><td><UiInput v-model.number="row.availableTrips" type="number" min="0" max="1000000" :disabled="busy || readOnly || past(row)" aria-label="可投入运输车次" /></td><td><UiInput v-model.number="row.requiredWorkMinutes" type="number" min="0" max="1000000" step="0.1" :disabled="busy || readOnly || past(row)" aria-label="预计作业量" /></td></template>
          <td><UiButton class="text-button" :disabled="busy || readOnly || (past(row) && !ended(row))" @click="rows.splice(rows.indexOf(row), 1)">{{ ended(row) ? '归档' : '移出当前台账' }}</UiButton></td>
        </tr>
      </tbody></UiTable><p v-else class="muted">暂无时段。添加未来时段或导入资料后保存；未申报不等于零需求。</p>
      <div class="fleet-pagination"><span>第 {{ Math.min(page, pages) }} / {{ pages }} 页</span><div><UiButton :disabled="page <= 1" @click="page--">上一页</UiButton><UiButton :disabled="page >= pages" @click="page++">下一页</UiButton></div></div>
      <div class="fleet-save-bar"><div><strong>{{ readOnly ? '正在查看历史快照' : capacityMode ? '保存园区容量' : '仅保存当前承运商的需求与运力' }}</strong><span>保留其他承运商内容和历史版本，后续联合查询使用新快照。</span></div><div class="button-row"><UiButton class="secondary" :disabled="busy || readOnly || !dirty" @click="discard">放弃未保存修改</UiButton><UiButton class="primary" :disabled="busy || readOnly || !dirty || !version" @click="save">{{ busy ? '正在保存…' : '保存台账' }}</UiButton></div></div>
    </section>
    <details class="panel"><summary>导入时段资料与字段说明</summary><p class="muted">导入JSON数组会追加到草稿，重复入口时段将拒绝。slotStart可用Unix毫秒或上海日期时间，例如{{ importExample }}；以实际当前日期为准，最多提前31天。最后仍需点击保存。</p><p class="muted">{{ capacityMode ? '字段：road、slotStart、entryCapacity、serviceCapacityMinutes。零容量表示该时段不接纳，未配置则保持未知。' : '字段：carrierId、road、slotStart、expectedTrips、availableTrips、requiredWorkMinutes。carrierId须为当前承运商；可投入运输车次是此入口时段可安排的车次额度，不是去重车辆数量；同一运力不要重复分配给不同入口。' }}</p><input type="file" accept=".json,application/json" :disabled="busy || readOnly || !version" aria-label="导入预约时段JSON" @change="importFile" /></details>
  </section>
</template>
<style scoped>
.reservation-history{display:flex;align-items:flex-end;gap:14px;margin:18px 0}.reservation-history label{display:grid;gap:8px;min-width:380px;font-size:13px;color:var(--text-secondary)}
.reservation-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.reservation-fields label{display:grid;gap:8px;font-size:13px;color:var(--text-secondary)}.reservation-draft fieldset{border:0;padding:0;margin:0;min-width:0}.reservation-draft h3{margin:0 0 18px}.reservation-table{table-layout:fixed}.reservation-table th:first-child{width:30%}.reservation-table th:last-child{width:110px}.reservation-table small{display:block;color:var(--muted);font-size:12px;margin-top:4px}.reservation-editor .panel-heading h3{margin:0}.reservation-editor .panel-heading p{margin:7px 0 0}.reservation-editor .fleet-save-bar .button-row{margin:0;flex:none}.reservation-editor summary{cursor:pointer;font-size:14px}.reservation-notice{margin-bottom:20px}.reservation-editor input[type=file]{margin-top:12px;font-size:13px}
</style>
