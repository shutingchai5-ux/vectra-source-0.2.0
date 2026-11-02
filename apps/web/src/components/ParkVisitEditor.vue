<script setup lang="ts">
import { computed, onActivated, onMounted, reactive, ref, watch } from "vue";
import { PARK_ENTRANCES, PARK_LIFECYCLE_FIELDS, PARK_TIME_LABELS, VEHICLE_STATUSES, parkVisitStatus, isParkEntrance, isPlateNumber, normalizePlateNumber, parseParkTimestamp, shanghaiDateTime, type CarrierId, type FleetOverview, type ParkCatalog, type ParkSnapshot, type ParkVisit } from "@vectra/shared";
import { carrierApi } from "../carrier-role";
import { admissionIssues, admissionPayload, queueIssues, queuePayload } from "../visit-entry";
import { emptyVisit, importedVisitDrafts, visitDraft, visitPayload, visitTimeFields, type VisitDraft } from "../visit-drafts";
import { useUnsavedChanges } from "../use-unsaved-changes";
import LicensePlateInput from "./LicensePlateInput.vue";
import { ElTable, ElTableColumn, ElPagination } from "element-plus";
import "element-plus/es/components/table/style/css";
import "element-plus/es/components/pagination/style/css";

const props = defineProps<{ catalog: ParkCatalog; fleet?: FleetOverview; scopeCarrier: CarrierId; focusVehicleId?: string; guardNavigation?: boolean }>();
const emit = defineEmits<{ saved: [catalog: ParkCatalog, carrierId: CarrierId]; loaded: [catalog: ParkCatalog, carrierId: CarrierId]; dirty: [value: boolean, carrierId: CarrierId]; busy: [value: boolean, carrierId: CarrierId]; "refresh-fleet": [] }>();
const records = ref<ParkVisit[]>([]), version = ref(""), selectedId = ref(""), busy = ref(false), loadedOnce = ref(false), message = ref(""), failed = ref(false);
const view = ref<"admission" | "queue" | "active" | "departed" | "all">("admission"), search = ref(""), entrance = ref(""), page = ref(1);
const departureFilter = ref<"pending" | "completed" | "all">("pending");
const entry = reactive(emptyVisit(props.scopeCarrier)), entryMode = ref<"known" | "temporary">("known"), entryCurrentTime = ref(true), entryAttempted = ref(false);
const registrationMode = ref<"queue" | "admission">("queue");
const entryEventField = computed(() => registrationMode.value === "queue" ? "arrivedAt" : "enteredAt");
const entryExtraFields = computed(() => (["dispatchReadyAt", "dispatchedAt", "offsiteArrivedAt", "arrivedAt", "gateStartedAt", "appointmentStart", "appointmentEnd"] as const).filter(field => registrationMode.value !== "queue" || field !== "arrivedAt" && field !== "gateStartedAt"));
const entrySignature = () => JSON.stringify([entry, entryMode.value, entryCurrentTime.value, registrationMode.value]);
const entryBaseline = ref(entrySignature()), entryDirty = computed(() => entrySignature() !== entryBaseline.value);
const correction = ref<VisitDraft>(), correctionBaseline = ref(""), correctionVersion = ref(""), correctionOriginal = ref("");
const correctionDirty = computed(() => !!correction.value && JSON.stringify(correction.value) !== correctionBaseline.value);
const importRows = ref<VisitDraft[]>([]), importName = ref(""), importVersion = ref("");
const dirty = computed(() => entryDirty.value || correctionDirty.value || !!importRows.value.length);
useUnsavedChanges(() => dirty.value, "车次登记", () => props.guardNavigation !== false);
watch(dirty, value => emit("dirty", value, props.scopeCarrier), { flush: "sync" });
watch(busy, value => emit("busy", value, props.scopeCarrier), { flush: "sync" });

const carrierName = computed(() => props.catalog.settings.carriers.find(row => row.id === props.scopeCarrier)?.name ?? props.scopeCarrier);
const vehicles = computed(() => props.fleet?.vehicles.filter(row => row.carrierId === props.scopeCarrier && row.profiled && isPlateNumber(row.vehicleId)) ?? []);
const entryVehicle = computed(() => vehicles.value.find(row => row.vehicleId === normalizePlateNumber(entry.vehicleId)));
const activeEntry = computed(() => records.value.find(row => row.vehicleId === normalizePlateNumber(entry.vehicleId) && row.departedAt === undefined));
const admissionProblems = computed(() => admissionIssues(entry, entryVehicle.value, entryMode.value, entryCurrentTime.value));
const queueProblems = computed(() => queueIssues(entry, entryVehicle.value, entryMode.value, entryCurrentTime.value));
const entryProblems = computed(() => registrationMode.value === "queue" ? queueProblems.value : admissionProblems.value);
const canEnter = computed(() => loadedOnce.value && !busy.value && !activeEntry.value && !admissionProblems.value.length);
const canQueue = computed(() => loadedOnce.value && !busy.value && !activeEntry.value && !queueProblems.value.length);
const canRegister = computed(() => registrationMode.value === "queue" ? canQueue.value : canEnter.value);
const selected = computed(() => records.value.find(row => row.visitId === selectedId.value));
const stageIndex = (row: ParkVisit) => PARK_LIFECYCLE_FIELDS.findLastIndex(field => row[field] !== undefined);
const stageLabel = (row: ParkVisit) => VEHICLE_STATUSES[parkVisitStatus(row)];
const nextField = computed(() => selected.value ? PARK_LIFECYCLE_FIELDS[stageIndex(selected.value) + 1] : undefined);
const queueCount = computed(() => records.value.filter(row => parkVisitStatus(row) === "queued").length);
const activeCount = computed(() => records.value.filter(row => row.departedAt === undefined && parkVisitStatus(row) !== "queued").length);
const departedCount = computed(() => records.value.filter(row => row.departedAt !== undefined).length);
const pendingDepartureCount = computed(() => records.value.filter(row => row.serviceEndedAt !== undefined && row.departedAt === undefined).length);
const filtered = computed(() => records.value.filter(row => (view.value !== "queue" || parkVisitStatus(row) === "queued") && (view.value !== "active" || row.departedAt === undefined && parkVisitStatus(row) !== "queued") &&
  (view.value !== "departed" || (departureFilter.value === "pending" ? row.serviceEndedAt !== undefined && row.departedAt === undefined : departureFilter.value === "completed" ? row.departedAt !== undefined : row.serviceEndedAt !== undefined || row.departedAt !== undefined)) &&
  (!entrance.value || row.road === entrance.value) && (!search.value.trim() || (row.vehicleId + " " + row.visitId).toLowerCase().includes(search.value.trim().toLowerCase())))
  .sort((a, b) => view.value === "departed" ? (b.departedAt ?? b.serviceEndedAt ?? 0) - (a.departedAt ?? a.serviceEndedAt ?? 0) : view.value === "queue" ? a.arrivedAt - b.arrivedAt : b.arrivedAt - a.arrivedAt));
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 10))), pageRows = computed(() => filtered.value.slice((Math.min(page.value, pages.value) - 1) * 10, Math.min(page.value, pages.value) * 10));
const correctionOutdated = computed(() => !!correction.value && JSON.stringify(records.value.find(row => row.visitId === correction.value!.visitId)) !== correctionOriginal.value);
const actionCurrentTime = ref(true), actionAt = ref(""), distanceKm = ref<string | number>(""), energyKwh = ref<string | number>("");
const displayTime = (at: number | undefined) => at === undefined ? "尚未记录" : shanghaiDateTime(at);
function fail(cause: unknown) { failed.value = true; message.value = cause instanceof Error ? cause.message : String(cause); }
function adopt(snapshot: ParkSnapshot) {
  if (snapshot.visits.some(row => row.carrierId !== props.scopeCarrier)) throw new Error("返回记录包含其他承运商，已停止载入。");
  records.value = snapshot.visits; version.value = snapshot.version; loadedOnce.value = true;
  if (!records.value.some(row => row.visitId === selectedId.value)) selectedId.value = [...records.value].sort((a, b) => b.arrivedAt - a.arrivedAt)[0]?.visitId ?? "";
  if (view.value !== "admission" && !correctionDirty.value && !filtered.value.some(row => row.visitId === selectedId.value)) selectedId.value = filtered.value[0]?.visitId ?? "";
  emit("loaded", snapshot.catalog, props.scopeCarrier);
}
async function load() {
  if (busy.value) return; busy.value = true;
  try { adopt(await carrierApi<ParkSnapshot>(props.scopeCarrier, "/api/carrier/visits")); }
  catch (cause) { fail(cause); } finally { busy.value = false; }
}
async function persist(path: string, method: string, value: unknown) {
  if (busy.value) return; busy.value = true; message.value = ""; failed.value = false;
  try { const snapshot = await carrierApi<ParkSnapshot>(props.scopeCarrier, path, { method, body: JSON.stringify(value) }); adopt(snapshot); emit("saved", snapshot.catalog, props.scopeCarrier); return snapshot; }
  catch (cause) { fail(cause); } finally { busy.value = false; }
}
function chooseVehicle() {
  const vehicle = entryVehicle.value; if (!vehicle) return;
  const previous = [...records.value].filter(row => row.vehicleId === vehicle.vehicleId && isParkEntrance(row.road)).sort((a, b) => b.arrivedAt - a.arrivedAt)[0];
  entry.road = previous?.road ?? vehicle.lastVisit?.road ?? (vehicle.allowedRoads.length === 1 ? vehicle.allowedRoads[0] : "");
}
function resetEntry(visit?: ParkVisit) {
  if (entryDirty.value && !window.confirm("当前车次信息尚未确认，是否清空并重新填写？")) return false;
  Object.assign(entry, emptyVisit(props.scopeCarrier)); entryMode.value = "known"; registrationMode.value = "queue"; entryCurrentTime.value = true; entryAttempted.value = false; entryBaseline.value = entrySignature();
  if (visit) { entry.vehicleId = visit.vehicleId; entry.road = visit.road; entryMode.value = vehicles.value.some(row => row.vehicleId === visit.vehicleId) ? "known" : "temporary"; }
  view.value = "admission"; return true;
}
async function confirmAdmission() {
  entryAttempted.value = true;
  if (!canEnter.value) { fail(new Error(activeEntry.value ? "该车辆已有排队或未离园车次，请打开当前车次继续办理。" : admissionProblems.value.join(" "))); return false; }
  const visitId = entry.visitId, snapshot = await persist("/api/carrier/visits/admissions", "POST", admissionPayload(entry, entryCurrentTime.value));
  if (!snapshot) return false;
  const admitted = snapshot.visits.find(row => row.visitId === visitId);
  if (!admitted || admitted.enteredAt === undefined) { fail(new Error("服务未确认入园结果，填写内容已保留，请刷新记录后核对。")); return false; }
  selectedId.value = admitted.visitId; entryBaseline.value = entrySignature(); resetEntry(); view.value = "active";
  message.value = admitted.vehicleId + "已确认入园，入口为" + admitted.road + "，时间为" + displayTime(admitted.enteredAt) + "。"; return true;
}
async function confirmQueue() {
  entryAttempted.value = true;
  if (!canQueue.value) { fail(new Error(activeEntry.value ? "该车辆已有排队或未离园车次，请打开当前车次继续办理。" : queueProblems.value.join(" "))); return false; }
  const visitId = entry.visitId, snapshot = await persist("/api/carrier/visits/queue", "POST", queuePayload(entry, entryCurrentTime.value));
  if (!snapshot) return false;
  const queued = snapshot.visits.find(row => row.visitId === visitId);
  if (!queued) { fail(new Error("服务未返回排队登记结果，填写内容已保留，请刷新记录后核对。")); return false; }
  selectedId.value = queued.visitId; entryBaseline.value = entrySignature(); resetEntry();
  view.value = parkVisitStatus(queued) === "queued" ? "queue" : queued.departedAt === undefined ? "active" : "all";
  message.value = queued.vehicleId + "排队登记已保存，到达" + queued.road + "的时间为" + displayTime(queued.arrivedAt) + "，当前状态为“" + stageLabel(queued) + "”。"; return true;
}
const submitEntry = () => registrationMode.value === "queue" ? confirmQueue() : confirmAdmission();
function discardCorrection() {
  if (correctionDirty.value && !window.confirm("记录更正尚未保存，是否放弃本次更正？")) return false;
  correction.value = undefined; return true;
}
function openRecord(row: ParkVisit) { if (row.visitId !== selectedId.value && !discardCorrection()) return; selectedId.value = row.visitId; }
function openActiveEntry() { if (activeEntry.value) { openRecord(activeEntry.value); view.value = parkVisitStatus(activeEntry.value) === "queued" ? "queue" : "active"; } }
function openDeparture() { departureFilter.value = selected.value?.departedAt === undefined ? "pending" : "completed"; view.value = "departed"; message.value = ""; }
watch(selectedId, () => { actionCurrentTime.value = true; actionAt.value = ""; distanceKm.value = ""; energyKwh.value = ""; });
async function advance() {
  const row = selected.value, field = nextField.value; if (!row || !field || busy.value) return false;
  if (field === "departedAt" && view.value !== "departed") { openDeparture(); message.value = "请核对离园时间后确认离园。"; return false; }
  if (correctionDirty.value) { fail(new Error("请先保存或取消记录更正，再推进生命周期。")); return false; }
  const value: Record<string, unknown> = { field, baseVersion: version.value };
  if (!actionCurrentTime.value) {
    const at = parseParkTimestamp(actionAt.value); if (!Number.isFinite(at) || at < 0 || at > Date.now()) { fail(new Error("请选择非未来的有效上海时间。")); return false; }
    value.at = actionAt.value;
  }
  if (field === "departedAt") for (const [name, amount] of [["distanceKm", distanceKm.value], ["energyKwh", energyKwh.value]] as const) if (String(amount).trim()) {
    const number = Number(amount); if (!Number.isFinite(number) || number < 0 || number > 1000000) { fail(new Error("里程和电耗须为0—1000000，未知时留空。")); return false; } value[name] = number;
  }
  const snapshot = await persist("/api/carrier/visits/" + encodeURIComponent(row.visitId) + "/lifecycle", "POST", value);
  if (!snapshot) return false;
  const updated = snapshot.visits.find(item => item.visitId === row.visitId)!; selectedId.value = row.visitId;
  actionCurrentTime.value = true; actionAt.value = ""; distanceKm.value = ""; energyKwh.value = "";
  if (field === "enteredAt") view.value = "active";
  if (field === "serviceEndedAt") { departureFilter.value = "pending"; view.value = "departed"; }
  if (field === "departedAt") { departureFilter.value = "completed"; view.value = "departed"; }
  message.value = field === "serviceEndedAt" ? row.vehicleId + "已结束作业，请核对离园时间后确认离园。" : row.vehicleId + "已记录“" + PARK_TIME_LABELS[field] + "”，时间为" + displayTime(updated[field]) + "，入口继续沿用" + updated.road + "。"; return true;
}
function beginCorrection() {
  if (!selected.value || !discardCorrection()) return;
  correction.value = visitDraft(selected.value); correctionBaseline.value = JSON.stringify(correction.value); correctionVersion.value = version.value; correctionOriginal.value = JSON.stringify(selected.value);
}
async function saveCorrection() {
  if (!correction.value || correctionOutdated.value || busy.value) return false;
  try {
    const snapshot = await persist("/api/carrier/visits/" + encodeURIComponent(correction.value.visitId), "PUT", { visit: visitPayload([correction.value])[0], baseVersion: correctionVersion.value });
    if (!snapshot) return false; correction.value = undefined; message.value = "记录更正已保存，后续统计使用更正后的快照，已有签名报告保持原样。"; return true;
  } catch (cause) { fail(cause); return false; }
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error("文件最大4 MiB。");
    const preview = importedVisitDrafts(JSON.parse(await file.text()));
    if (!preview.length) throw new Error("文件中没有可追加的记录。");
    if (preview.some(row => row.carrierId !== props.scopeCarrier)) throw new Error("文件含其他承运商车次，请只导入本方记录，原预览已保留。");
    visitPayload(preview); importRows.value = preview; importName.value = file.name; importVersion.value = version.value; failed.value = false; message.value = "已预览" + preview.length + "条历史记录，尚未保存；确认后追加，现有车次保留。";
  } catch (cause) { fail(cause); } finally { input.value = ""; }
}
async function confirmImport() {
  if (!importRows.value.length || busy.value) return false;
  try {
    const snapshot = await persist("/api/carrier/visits/import", "POST", { visits: visitPayload(importRows.value), baseVersion: importVersion.value });
    if (!snapshot) return false; importRows.value = []; importName.value = ""; view.value = "all"; message.value = "历史车次已追加，现有车次和其他承运商记录均保留。"; return true;
  } catch (cause) { fail(cause); return false; }
}
watch(() => props.focusVehicleId, id => { if (!id || entryDirty.value || !vehicles.value.some(row => row.vehicleId === id)) return; entry.vehicleId = id; chooseVehicle(); view.value = "admission"; }, { immediate: true });
watch(() => props.catalog.version, value => { if (loadedOnce.value && !busy.value && value !== version.value) void load(); });
watch([view, search, entrance, departureFilter], () => { page.value = 1; if (view.value !== "admission" && !correctionDirty.value && !filtered.value.some(row => row.visitId === selectedId.value)) selectedId.value = filtered.value[0]?.visitId ?? ""; });
onMounted(load);
onActivated(() => { if (loadedOnce.value && !busy.value && props.catalog.version !== version.value) void load(); });
</script>

<template>
  <section class="visit-workspace" aria-label="本承运商车次登记">
    <div class="visits-heading"><div><span class="visits-eyebrow">本方车次与作业进度</span><h2>车次登记</h2><p>到达入口后先登记排队，确认入园后继续作业与离园；已到达入园环节也可直接确认入园。</p></div><UiButton class="visits-secondary" :disabled="busy" @click="load">{{ busy ? '处理中…' : '刷新记录' }}</UiButton></div>
    <nav class="visits-tabs" aria-label="车次工作区">
      <UiButton :class="{ active: view === 'admission' }" :disabled="busy" @click="view = 'admission'">新增车次<span v-if="entryDirty"> · 待确认</span></UiButton>
      <UiButton :class="{ active: view === 'queue' }" :disabled="busy" @click="view = 'queue'">排队待入园 <b>{{ queueCount }}</b></UiButton>
      <UiButton :class="{ active: view === 'active' }" :disabled="busy" @click="view = 'active'">在园作业 <b>{{ activeCount }}</b></UiButton>
      <UiButton :class="{ active: view === 'departed' }" :disabled="busy" @click="departureFilter = 'pending'; view = 'departed'; message = ''">离园记录 <b>{{ pendingDepartureCount }}</b></UiButton>
      <UiButton :class="{ active: view === 'all' }" :disabled="busy" @click="view = 'all'">全部记录 <b>{{ records.length }}</b></UiButton>
    </nav>
    <UiAlert v-if="message" class="visits-feedback" :class="{ error: failed }" role="status">{{ message }}</UiAlert>
    <p v-if="!loadedOnce" class="visits-loading">{{ busy ? '正在载入本方车次…' : '车次尚未载入，请刷新记录。' }}</p>
    <template v-else>
      <form v-if="view === 'admission'" class="admission-layout" @submit.prevent="submitEntry">
        <section class="visits-panel admission-fields"><div class="visits-panel-title"><span class="visits-number">1</span><div><h3>填写车次信息</h3><p>选择本次登记状态，核对车辆和入口后保存。</p></div></div>
          <UiFieldset :disabled="busy">
            <div class="registration-mode" role="group" aria-label="选择车次登记状态"><label :class="{ active: registrationMode === 'queue' }"><input v-model="registrationMode" type="radio" value="queue" /><span><strong>先登记排队</strong><small>记录到达，稍后确认入园</small></span></label><label :class="{ active: registrationMode === 'admission' }"><input v-model="registrationMode" type="radio" value="admission" /><span><strong>直接确认入园</strong><small>车辆已完成入园核对</small></span></label></div>
            <div class="admission-mode"><label><input v-model="entryMode" type="radio" value="known" />已有车辆档案</label><label><input v-model="entryMode" type="radio" value="temporary" />临时车辆登记</label></div>
            <label v-if="entryMode === 'known'" class="visit-field">本方车辆 <em>必填</em><UiSelect v-model="entry.vehicleId" @change="chooseVehicle"><option value="">请选择已保存档案的车辆</option><option v-for="vehicle in vehicles" :key="vehicle.vehicleId" :value="vehicle.vehicleId">{{ vehicle.plateNumber || vehicle.vehicleId }}</option></UiSelect></label>
            <LicensePlateInput v-else :key="'temporary-entry'" v-model="entry.vehicleId" :disabled="busy" />
            <p v-if="entryMode === 'known' && !vehicles.length" class="visits-note">暂无已保存车辆档案，可先切换到“车辆档案”添加，或使用临时车辆登记。</p>
            <div class="entry-owner"><small>所属承运商</small><strong>{{ carrierName }}</strong><span>固定为当前角色</span></div>
            <div class="visit-field">本次实际入口 <em>必填</em><div class="entry-entrances" role="group" aria-label="选择本次实际入园入口"><UiButton v-for="road in PARK_ENTRANCES" :key="road" type="button" :aria-pressed="entry.road === road" :class="{ active: entry.road === road }" @click="entry.road = road">{{ road }}</UiButton></div></div>
            <p class="visits-note">已知车辆优先带入已有入口；排队、入园、作业与离园一直沿用本次入口。</p>
            <label class="visit-check"><input v-model="entryCurrentTime" type="checkbox" />{{ registrationMode === 'queue' ? '登记到达时记录当前上海时间' : '确认入园时记录当前上海时间' }}</label>
            <label v-if="!entryCurrentTime" class="visit-field">{{ registrationMode === 'queue' ? '实际到达入口时间' : '实际入园时间' }} <em>必填</em><UiInput v-model="entry[entryEventField]" type="datetime-local" step="0.001" /></label>
            <details class="visit-extra"><summary>补充跨企业链路与预约信息（可选）</summary><p class="visits-note">按备车、发车、园外集结、到达入口的真实顺序填写，未知时间留空。{{ registrationMode === 'queue' ? '排队登记只记录到达，不生成入园时间。' : '没有单独到达记录时，以确认入园时间作为到达时间。' }}未填环节不会补零。</p><div class="visit-field-grid"><label v-for="field in entryExtraFields" :key="field" class="visit-field">{{ PARK_TIME_LABELS[field] }}<UiInput v-model="entry[field]" type="datetime-local" step="0.001" /></label></div></details>
          </UiFieldset>
        </section>
        <aside class="visits-panel admission-review"><div class="visits-panel-title"><span class="visits-number">2</span><div><h3>{{ registrationMode === 'queue' ? '核对并登记排队' : '核对并确认入园' }}</h3><p>{{ registrationMode === 'queue' ? '保存后进入排队列表，入园时间稍后单独确认。' : '信息通过校验后，才会记录入园。' }}</p></div></div><dl class="visit-facts"><div><dt>车辆</dt><dd>{{ entry.vehicleId || '待选择或填写' }}</dd></div><div><dt>承运商</dt><dd>{{ carrierName }}</dd></div><div><dt>实际入口</dt><dd>{{ entry.road || '待选择' }}</dd></div><div><dt>登记状态</dt><dd>{{ registrationMode === 'queue' ? '排队待入园' : '已入园' }}</dd></div><div><dt>{{ registrationMode === 'queue' ? '到达入口时间' : '入园时间' }}</dt><dd>{{ entryCurrentTime ? '确认时的当前上海时间' : entry[entryEventField].replace('T',' ') || '待填写' }}</dd></div></dl>
          <div v-if="activeEntry" class="admission-warning"><strong>该车辆已有{{ stageLabel(activeEntry) }}车次</strong><p>无需重复登记，请继续办理当前车次。</p><UiButton type="button" class="visits-secondary" @click="openActiveEntry">打开当前车次</UiButton></div>
          <div v-else-if="entryProblems.length" class="admission-checklist" :class="{ invalid: entryAttempted }"><strong>还需补充或核对</strong><ul><li v-for="problem in entryProblems" :key="problem">{{ problem }}</li></ul></div><p v-else class="entry-ready">✓ 车次信息已完整，可以确认。</p>
          <UiButton class="visits-primary admission-confirm" :disabled="!canRegister">{{ busy ? '正在保存…' : registrationMode === 'queue' ? '确认信息并登记排队' : '确认信息并入园' }}</UiButton><UiButton type="button" class="visits-text-button" :disabled="busy" @click="resetEntry()">清空待确认信息</UiButton><p class="visits-note">确认成功后立即保存。填写或切换车辆不会自动登记或入园。</p>
        </aside>
      </form>
      <section v-else-if="view === 'departed'" class="departure-workspace">
        <div class="departure-heading"><div><h3>确认离园</h3><p>作业结束后核对离园时间，确认成功才记录离园。待确认 {{ pendingDepartureCount }} 辆 · 已确认 {{ departedCount }} 辆</p></div><div class="visit-search"><UiInput v-model="search" placeholder="查找车牌或车次" aria-label="查找离园车次" /><UiSelect v-model="departureFilter" aria-label="离园确认状态"><option value="pending">待确认离园</option><option value="completed">已确认离园</option><option value="all">全部离园车次</option></UiSelect></div></div>
        <div class="visit-operations-layout departure-layout">
          <section class="visits-panel departure-records">
            <ElTable :data="pageRows" row-key="visitId" :current-row-key="selectedId" highlight-current-row @row-click="row => openRecord(row as ParkVisit)">
              <ElTableColumn prop="vehicleId" label="车辆" min-width="140" />
              <ElTableColumn label="离园时间（上海）" min-width="200"><template #default="{ row }">{{ row.departedAt === undefined ? '待确认' : displayTime(row.departedAt) }}</template></ElTableColumn>
              <ElTableColumn label="状态" width="105"><template #default="{ row }"><UiTag :class="row.departedAt === undefined ? 'queued' : 'completed'">{{ row.departedAt === undefined ? '待确认' : '已确认' }}</UiTag></template></ElTableColumn>
              <ElTableColumn label="操作" width="110"><template #default="{ row }"><UiButton class="visits-text-button" :disabled="busy" @click.stop="openRecord(row as ParkVisit)">{{ row.departedAt === undefined ? '办理离园' : '查看' }}</UiButton></template></ElTableColumn>
              <template #empty><div class="visit-empty"><strong>{{ departureFilter === 'pending' ? '暂无待确认离园车次' : '暂无符合条件的离园记录' }}</strong><p>在园作业中确认结束作业后，车次会进入待确认离园列表。</p></div></template>
            </ElTable>
            <ElPagination v-model:current-page="page" :page-size="10" :total="filtered.length" :disabled="busy" layout="total, prev, pager, next" />
          </section>
          <aside v-if="selected && filtered.some(row => row.visitId === selectedId)" class="visits-panel departure-confirmation">
            <div class="visit-detail-heading"><div><small>{{ carrierName }}</small><h3>{{ selected.vehicleId }}</h3></div><UiTag :class="selected.departedAt === undefined ? 'queued' : 'completed'">{{ selected.departedAt === undefined ? '待确认离园' : '已确认离园' }}</UiTag></div>
            <div class="departure-time"><span>离园时间 · 上海</span><strong>{{ selected.departedAt === undefined ? '确认时记录当前时间' : displayTime(selected.departedAt) }}</strong></div>
            <form v-if="selected.departedAt === undefined" class="departure-action" @submit.prevent="advance">
              <label class="visit-check"><input v-model="actionCurrentTime" type="checkbox" :disabled="busy" />使用确认时的当前上海时间</label>
              <label v-if="!actionCurrentTime" class="visit-field">实际离园时间<UiInput v-model="actionAt" type="datetime-local" step="0.001" :disabled="busy" required /></label>
              <details class="departure-extras"><summary>补充里程与用电（可选）</summary><div class="visit-field-grid"><label class="visit-field">本车次里程（km）<UiInput v-model="distanceKm" type="number" min="0" max="1000000" step="0.0001" :disabled="busy" /></label><label class="visit-field">本车次用电（kWh）<UiInput v-model="energyKwh" type="number" min="0" max="1000000" step="0.0001" :disabled="busy" /></label></div></details>
              <UiButton class="visits-primary" :disabled="busy || correctionDirty">{{ busy ? '正在保存…' : '确认离园' }}</UiButton>
            </form>
            <div v-else class="visit-completed"><p>离园已确认，完整生命周期可在“全部记录”查看。</p><UiButton class="visits-secondary" :disabled="busy" @click="resetEntry(selected)">填写再次入园信息</UiButton></div>
          </aside>
          <aside v-else class="visits-panel visit-empty">选择一辆待确认车辆办理离园。</aside>
        </div>
      </section>
      <div v-else class="visit-operations-layout">
        <section class="visits-panel visit-records"><div class="visit-search"><UiInput v-model="search" placeholder="查找车牌或车次" aria-label="查找车牌或车次" /><UiSelect v-model="entrance" aria-label="按入口筛选"><option value="">全部入口</option><option v-for="road in PARK_ENTRANCES" :key="road" :value="road">{{ road }}</option></UiSelect></div>
          <UiTable v-if="pageRows.length" class="visits-table"><thead><tr><th>车辆 / 到达入口时间</th><th>入口</th><th>阶段</th><th></th></tr></thead><tbody><tr v-for="row in pageRows" :key="row.visitId" :class="{ selected: selectedId === row.visitId }"><td><strong>{{ row.vehicleId }}</strong><small>{{ displayTime(row.arrivedAt) }}</small></td><td>{{ row.road }}</td><td><UiTag class="visit-stage-tag" :class="'stage-' + stageIndex(row)">{{ stageLabel(row) }}</UiTag></td><td><UiButton class="visits-text-button" :disabled="busy" @click="openRecord(row)">{{ view === 'queue' ? '办理' : '查看' }}</UiButton></td></tr></tbody></UiTable>
          <div v-else class="visit-empty"><strong>{{ view === 'queue' ? '暂无排队待入园车次' : '暂无符合条件的车次' }}</strong><p>{{ view === 'queue' ? '到达入口后先登记排队，再在这里确认入园。' : '调整筛选，或先填写完整车次信息并确认。' }}</p><UiButton class="visits-secondary" @click="view = 'admission'">前往新增车次</UiButton></div>
          <div class="visits-pagination"><span>{{ filtered.length }} 条记录</span><UiButton :disabled="page <= 1" @click="page--">上一页</UiButton><span>{{ Math.min(page,pages) }} / {{ pages }}</span><UiButton :disabled="page >= pages" @click="page++">下一页</UiButton></div>
        </section>
        <aside v-if="selected" class="visits-panel visit-detail"><div class="visit-detail-heading"><div><small>{{ carrierName }}</small><h3>{{ selected.vehicleId }}</h3></div><span class="visit-entrance-badge">{{ selected.road }}</span></div><p class="visits-note">本车次入口持续沿用，无需在每个阶段重新选择。</p>
          <div v-if="parkVisitStatus(selected) === 'queued'" class="admission-warning"><strong>排队待入园</strong><p>已记录到达入口，尚未记录入园。核对后点击“确认入园”，继续办理同一车次。</p></div>
          <ol class="visit-timeline"><li v-for="field in (['arrivedAt', ...PARK_LIFECYCLE_FIELDS] as const)" :key="field" :class="{ done: selected[field] !== undefined }"><span class="visit-timeline-dot"></span><div><strong>{{ PARK_TIME_LABELS[field] }}</strong><time>{{ displayTime(selected[field]) }}</time></div></li></ol>
          <form v-if="nextField && nextField !== 'departedAt'" class="visit-next-action" @submit.prevent="advance"><h4>下一步：{{ PARK_TIME_LABELS[nextField] }}</h4><label class="visit-check"><input v-model="actionCurrentTime" type="checkbox" :disabled="busy" />使用确认时的当前上海时间</label><label v-if="!actionCurrentTime" class="visit-field">实际操作时间<UiInput v-model="actionAt" type="datetime-local" step="0.001" :disabled="busy" required /></label><UiButton class="visits-primary" :disabled="busy || correctionDirty">{{ busy ? '正在保存…' : '确认' + PARK_TIME_LABELS[nextField] }}</UiButton><p class="visits-note">操作成功后直接保存，入口继续沿用{{ selected.road }}。</p></form>
          <UiButton v-else-if="nextField === 'departedAt'" class="visits-primary" :disabled="busy" @click="openDeparture">前往确认离园</UiButton>
          <div v-else class="visit-completed"><strong>本次车次已完成</strong><p>再次入园需重新核对完整信息。</p><UiButton class="visits-secondary" :disabled="busy" @click="resetEntry(selected)">填写再次入园信息</UiButton></div>
          <UiButton v-if="view === 'all'" class="visits-text-button" :disabled="busy" @click="beginCorrection">查看或更正历史信息</UiButton><details class="visit-record-id"><summary>车次记录编号</summary><code>{{ selected.visitId }}</code></details>
        </aside><aside v-else class="visits-panel visit-empty">选择一条记录查看生命周期。</aside>
      </div>
      <section v-if="correction && view === 'all'" class="visits-panel visit-correction"><div class="visits-panel-title"><div><h3>记录更正 · {{ correction.vehicleId }}</h3><p>车牌、承运商和车次编号保持原样。仅在核对实际记录后修改。</p></div><UiButton class="visits-text-button" :disabled="busy" @click="discardCorrection">关闭更正</UiButton></div><UiAlert v-if="correctionOutdated" class="visits-feedback error">该记录已更新，当前更正草稿仍保留。请取消更正并刷新后重新核对。</UiAlert><form @submit.prevent="saveCorrection"><UiFieldset :disabled="busy"><div class="visit-field-grid"><label class="visit-field">实际入口<UiSelect v-model="correction.road"><option v-for="road in PARK_ENTRANCES" :key="road" :value="road">{{ road }}</option></UiSelect></label><label v-for="field in visitTimeFields" :key="field" class="visit-field">{{ PARK_TIME_LABELS[field] }}<UiInput v-model="correction[field]" type="datetime-local" step="0.001" /></label><label class="visit-field">完整里程（km）<UiInput v-model="correction.distanceKm" type="number" min="0" max="1000000" step="0.0001" /></label><label class="visit-field">完整用电（kWh）<UiInput v-model="correction.energyKwh" type="number" min="0" max="1000000" step="0.0001" /></label></div></UiFieldset><UiButton class="visits-primary" :disabled="busy || !correctionDirty || correctionOutdated">保存本条更正</UiButton></form></section>
      <details v-if="view === 'all'" class="visits-panel visit-import"><summary>历史车次导入</summary><p class="visits-note">载入本方车次数组并核对预览，再确认追加。保留现有记录，不自动填充历史时间；车次编号重复或数据不完整时拒绝保存。</p><input type="file" accept=".json,application/json" :disabled="busy" aria-label="选择本方历史车次文件" @change="importFile" /><template v-if="importRows.length"><h4>{{ importName }} · {{ importRows.length }} 条待确认</h4><UiTable class="visits-table"><thead><tr><th>车辆</th><th>入口</th><th>到达时间（上海）</th></tr></thead><tbody><tr v-for="row in importRows.slice(0,5)" :key="row.visitId"><td>{{ row.vehicleId }}</td><td>{{ row.road }}</td><td>{{ row.arrivedAt.replace('T',' ') }}</td></tr></tbody></UiTable><p v-if="importRows.length > 5" class="visits-note">这里只展示前5条，确认时校验全部记录。</p><UiButton class="visits-primary" :disabled="busy" @click="confirmImport">确认追加这些车次</UiButton><UiButton class="visits-text-button" :disabled="busy" @click="importRows = []; importName = ''">取消导入预览</UiButton></template></details>
    </template>
  </section>
</template>

<style scoped>
.visit-workspace{margin-top:24px;color:#456351}.visits-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;margin:8px 0 20px}.visits-heading h2{margin:4px 0;font-size:23px;font-weight:600}.visits-heading p,.visits-note{font-size:11px;line-height:1.9;color:#82958a;margin:5px 0 12px}.visits-eyebrow{font-size:10px;color:#59997c;letter-spacing:1.5px}.visits-tabs{display:flex;gap:8px;margin:0 0 22px;padding:5px;border-radius:10px;background:#eff5f0;border:1px solid #dfe8e1}.visits-tabs button{display:flex;align-items:center;gap:8px;flex:1;justify-content:center;padding:11px 12px;border:0;border-radius:7px;background:transparent;color:#7d9386;font-size:12px}.visits-tabs button.active{background:#fff;color:#347354;box-shadow:0 2px 7px #355f4210}.visits-tabs b{font-size:10px;font-weight:500;padding:1px 6px;border-radius:4px;background:#eaf2ec}.visits-tabs span{font-size:10px}.visits-panel{min-width:0;padding:23px;border:1px solid #dfe8e1;border-radius:13px;background:white}.visits-panel-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:0 0 22px}.visits-panel-title h3{margin:0 0 5px;font-size:15px}.visits-panel-title p{margin:0;color:#8b9d91;font-size:11px;line-height:1.8}.visits-number{display:grid;place-items:center;width:26px;height:26px;background:#e7f3eb;border-radius:8px;color:#36835a;font-size:12px;flex:none}.visits-panel-title>div{flex:1}.admission-layout{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(300px,1fr);gap:20px;align-items:start}.admission-fields fieldset,.visit-correction fieldset{margin:0;padding:0;border:0;min-width:0}.admission-mode{display:flex;gap:25px;margin-bottom:22px;font-size:12px;color:#688474}.admission-mode label,.visit-check{display:flex;align-items:center;gap:8px}.admission-mode input,.visit-check input{width:14px;height:14px;accent-color:#3f8b64;margin:0}.visit-field{display:grid;gap:8px;font-size:12px;color:#5c7867;margin-bottom:20px}.visit-field em{font-style:normal;font-size:10px;color:#ad9978;display:inline}.visit-field input,.visit-field select{width:100%;box-sizing:border-box;min-width:0;font-size:12px;background:#fafcfb}.visit-field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px}.entry-owner{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #e4ece6;background:#f7faf7;border-radius:8px;margin:20px 0;font-size:12px}.entry-owner small,.entry-owner span{font-size:10px;color:#92a398}.entry-owner strong{font-weight:550;color:#65816e}.entry-owner span{margin-left:auto}.entry-entrances{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.entry-entrances button{padding:10px 5px;background:#fafcfb;border:1px solid #dfe8e2;border-radius:8px;font-size:11px;color:#809689}.entry-entrances button.active{background:#eaf5ed;border-color:#8fbe9f;color:#3c7b54}.visit-check{font-size:11px;color:#6e8978;margin:20px 0}.visit-extra{padding:14px;border:1px solid #e5ede7;background:#fafcfb;border-radius:9px;font-size:11px;color:#82998a}.visit-extra summary{cursor:pointer}.visit-extra .visit-field-grid{margin-top:18px}.visit-facts{margin:0 0 20px}.visit-facts>div{display:grid;grid-template-columns:80px minmax(0,1fr);gap:12px;padding:12px 0;border-bottom:1px solid #edf2ee;font-size:12px}.visit-facts dt{color:#94a599}.visit-facts dd{margin:0;color:#4f775d;overflow-wrap:anywhere}.admission-checklist,.admission-warning{padding:14px 15px;border-radius:8px;background:#faf7ef;color:#9c8c69;font-size:11px;line-height:1.9;margin:15px 0}.admission-checklist strong,.admission-warning strong{font-weight:550}.admission-checklist ul{margin:7px 0 0;padding-left:17px}.admission-checklist.invalid{background:#fff3eb;color:#aa805f}.admission-warning p{margin:7px 0}.entry-ready{font-size:12px;color:#4d8b63;padding:15px 0}.visits-primary,.visits-secondary,.visits-text-button{font-size:11px;border-radius:7px;padding:9px 13px}.visits-primary{background:#388364;color:#fff;border:1px solid #388364}.visits-secondary{background:#f7faf7;color:#73917c;border:1px solid #dce7df}.visits-text-button{background:transparent;color:#648b72;border:0;padding-left:0;padding-right:0}.admission-confirm{display:block;width:100%;margin-top:16px;padding:13px}.admission-review>.visits-text-button{display:block;margin:6px auto}.admission-review>.visits-note{text-align:center}.visits-feedback{padding:13px 16px;margin:0 0 20px;border-radius:9px;background:#edf7f0;border:1px solid #dceadf;color:#628c6e;font-size:12px;line-height:1.8}.visits-feedback.error{background:#fff5ed;border-color:#ecdcca;color:#a67c5b}.visits-loading{font-size:12px;color:#89a090;padding:25px}.visit-operations-layout{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(320px,1fr);gap:20px;align-items:start}.visit-search{display:flex;gap:12px;margin-bottom:16px}.visit-search input{flex:1;min-width:0;font-size:12px}.visit-search select{max-width:140px;font-size:11px}.visits-table{width:100%;border-collapse:collapse;font-size:11px;color:#718c79;table-layout:fixed}.visits-table th{padding:10px 7px;text-align:left;font-size:10px;color:#92a696;font-weight:500;background:#f5f9f6;border-bottom:1px solid #e3ebe5}.visits-table td{padding:14px 7px;border-bottom:1px solid #eaf0ec;overflow-wrap:anywhere;vertical-align:middle}.visits-table th:first-child{width:38%}.visits-table th:last-child{width:35px}.visits-table td strong{font-weight:550;font-size:12px;color:#4c7058}.visits-table td small{display:block;font-size:9px;color:#97a99c;margin-top:5px;line-height:1.7}.visits-table tr.selected{background:#f0f8f3}.visit-stage-tag{font-size:10px;border-radius:5px;padding:4px 6px;background:#edf3ef;color:#6f8b78;display:inline-block}.visit-stage-tag.stage-1{background:#edf3fb;color:#7892b1}.visit-stage-tag.stage-2{background:#f2eef8;color:#9a82ae}.visit-stage-tag.stage-3{background:#f0f2f5;color:#8b98a6}.visits-pagination{display:flex;align-items:center;gap:12px;margin-top:19px;font-size:10px;color:#97aa9c}.visits-pagination>span:first-child{margin-right:auto}.visits-pagination button{padding:5px 7px;background:#fafcfb;border:1px solid #e3ebe5;color:#7f9b89;font-size:10px;border-radius:5px}.visit-detail-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.visit-detail-heading h3{margin:3px 0;font-size:19px;font-weight:600;color:#4c7458}.visit-detail-heading small{color:#92a697;font-size:10px}.visit-entrance-badge{padding:6px 11px;border-radius:7px;background:#eef6f0;font-size:11px;color:#6f937a}.visit-timeline{list-style:none;margin:22px 0;padding:0}.visit-timeline li{display:flex;align-items:flex-start;gap:13px;position:relative;padding:0 0 22px}.visit-timeline li:not(:last-child):before{content:"";position:absolute;top:10px;bottom:0;left:5px;width:1px;background:#e0e9e2}.visit-timeline-dot{width:11px;height:11px;border-radius:50%;background:#edf2ee;border:1px solid #d9e5dc;margin-top:5px;box-sizing:border-box;z-index:1;flex:none}.visit-timeline .done .visit-timeline-dot{background:#609d76;border-color:#609d76}.visit-timeline strong{display:block;font-size:12px;font-weight:550;color:#7b9281}.visit-timeline .done strong{color:#52795d}.visit-timeline time{display:block;font-size:10px;color:#97a99c;line-height:1.8;margin-top:3px;font-variant-numeric:tabular-nums}.visit-next-action{border-top:1px solid #e5ece6;padding-top:17px}.visit-next-action h4{font-size:13px;color:#5d8268;margin:0}.visit-next-action .visits-primary{width:100%;margin-top:5px}.visit-next-action .visit-field-grid{grid-template-columns:1fr}.visit-completed{padding:15px;background:#f1f7f2;border-radius:8px;margin-bottom:17px;font-size:12px;color:#6a8e75}.visit-completed p{font-size:11px;color:#8fa395}.visit-record-id{font-size:10px;color:#a0b0a4;margin-top:15px}.visit-record-id summary{cursor:pointer}.visit-record-id code{display:block;overflow-wrap:anywhere;margin-top:10px}.visit-correction,.visit-import{margin-top:22px}.visit-correction .visit-field-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.visit-import{font-size:12px;color:#7b9684}.visit-import>summary{cursor:pointer}.visit-import>input{font-size:11px;margin:6px 0 15px;max-width:500px}.visit-import>button{margin:16px 12px 0 0}.visit-import .visits-table th:last-child{width:45%}.visit-empty{text-align:center;padding:42px 17px;color:#8ba292;font-size:12px;line-height:1.9}.visit-empty strong{font-weight:550}.visit-empty p{font-size:11px;color:#a0afa4}button:disabled{opacity:.5;cursor:not-allowed}

.departure-heading{display:flex;align-items:center;justify-content:space-between;gap:24px;margin:3px 0 20px}.departure-heading h3{font-size:20px;margin:0 0 7px}.departure-heading p{font-size:12px;color:#80958a;margin:0;line-height:1.9}.departure-heading .visit-search{margin:0;min-width:360px}.departure-layout{grid-template-columns:minmax(0,1.7fr) minmax(300px,1fr)}.departure-records{padding:0;overflow:hidden}.departure-records .el-pagination{justify-content:flex-end;padding:17px 20px}.departure-confirmation{align-self:start}.departure-time{display:grid;gap:12px;padding:24px 19px;margin:23px 0;border-radius:12px;background:#eff8f3;border:1px solid #d9eadf}.departure-time span{font-size:12px;color:#6d8b78}.departure-time strong{font-size:18px;font-weight:600;color:#2d7251;font-variant-numeric:tabular-nums}.departure-action{display:grid;gap:17px}.departure-extras{font-size:12px;color:#769180}.departure-extras summary{cursor:pointer;padding:10px 0}.departure-extras .visit-field-grid{margin-top:13px}
.registration-mode{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:22px}.registration-mode label{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #dfe8e2;border-radius:8px;cursor:pointer;background:#fafcfb}.registration-mode label.active{border-color:#8fbe9f;background:#eaf5ed}.registration-mode input{accent-color:#3f8b64}.registration-mode strong{display:block;font-size:12px;font-weight:550}.registration-mode small{display:block;margin-top:4px;font-size:10px;color:#82958a}.visit-stage-tag.stage--1{background:#fff6df;color:#96752d}
</style>
