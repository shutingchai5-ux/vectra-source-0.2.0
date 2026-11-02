<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { MAX_FLEET_VEHICLES, VEHICLE_TYPES, ENERGY_TYPES, isPlateNumber, normalizePlateNumber, plateNumberError, type CarrierId, type FleetOverview, type ParkVehicle, type VehicleState } from "@vectra/shared";
import { carrierApi } from "../carrier-role";
import { useUnsavedChanges } from "../use-unsaved-changes";
import LicensePlateInput from "./LicensePlateInput.vue";
const props = defineProps<{ carrierId: CarrierId; fleet: FleetOverview; focusVehicleId?: string }>();
const emit = defineEmits<{ dirty: [value: boolean, carrierId: CarrierId]; busy: [value: boolean, carrierId: CarrierId]; saved: [value: FleetOverview, carrierId: CarrierId] }>();
type Draft = { sourceId?: string; key: string; plateNumber: string; vehicleType: string; energyType: string; capacityTonnes: string | number };
const data = ref(props.fleet), rows = ref<Draft[]>([]), selected = ref(""), baseVersion = ref(""), dirty = ref(false), busy = ref(false), message = ref(""), failed = ref(false), page = ref(1), editingKey = ref("");
let originalRows: Draft[] = [];
const current = computed(() => rows.value.find(row => row.key === selected.value)), carrier = computed(() => data.value.settings.carriers.find(carrier => carrier.id === props.carrierId));
const editable = computed(() => !!current.value && editingKey.value === current.value.key);
const newProfile = computed(() => !!current.value && !originalRows.some(row => row.key === current.value!.key));
const pending = computed(() => data.value.vehicles.filter(vehicle => vehicle.carrierId === props.carrierId && !vehicle.profiled && !rows.value.some(row => row.sourceId === vehicle.vehicleId || normalizePlateNumber(row.plateNumber) === vehicle.vehicleId)));
const pages = computed(() => Math.max(1, Math.ceil(rows.value.length / 12))), pageRows = computed(() => rows.value.slice((page.value - 1) * 12, page.value * 12));
const savedPlate = computed(() => { const item = data.value.vehicles.find(vehicle => vehicle.vehicleId === current.value?.sourceId); return item && isPlateNumber(item.plateNumber ?? item.vehicleId); });
useUnsavedChanges(() => dirty.value, "当前承运商车辆档案", () => false);
watch(dirty, value => emit("dirty", value, props.carrierId), { flush: "sync" }); watch(busy, value => emit("busy", value, props.carrierId), { flush: "sync" });
const fromVehicle = (item: ParkVehicle): Draft => ({ sourceId: item.vehicleId, key: crypto.randomUUID(), plateNumber: isPlateNumber(item.plateNumber) ? normalizePlateNumber(item.plateNumber) : isPlateNumber(item.vehicleId) ? normalizePlateNumber(item.vehicleId) : "", vehicleType: item.vehicleType ?? "", energyType: item.energyType ?? "", capacityTonnes: item.capacityTonnes ?? "" });
const signature = (items: Draft[]) => JSON.stringify(items.map(({ key: _key, ...item }) => item));
function adopt(value: FleetOverview, focus = current.value?.plateNumber) {
  data.value = value; baseVersion.value = value.version;
  rows.value = value.vehicles.filter(vehicle => vehicle.carrierId === props.carrierId && vehicle.profiled).map(fromVehicle);
  originalRows = rows.value.map(row => ({ ...row }));
  selected.value = rows.value.find(row => row.plateNumber === focus)?.key ?? rows.value[0]?.key ?? "";
  page.value = Math.max(1, Math.ceil((rows.value.findIndex(row => row.key === selected.value) + 1) / 12)); editingKey.value = ""; dirty.value = false;
}
function change() { dirty.value = signature(rows.value) !== signature(originalRows); }
function fail(cause: unknown) { failed.value = true; message.value = cause instanceof Error ? cause.message : String(cause); }
function selectRow(row: Draft) { if (busy.value) return; selected.value = row.key; editingKey.value = originalRows.some(item => item.key === row.key) ? "" : row.key; }
function edit() { if (busy.value || !current.value) return; editingKey.value = current.value.key; failed.value = false; message.value = ""; }
function cancelEdit() {
  if (busy.value || !current.value) return;
  const row = current.value, original = originalRows.find(item => item.key === row.key);
  if (original) Object.assign(row, original);
  else { rows.value = rows.value.filter(item => item.key !== row.key); selected.value = rows.value[0]?.key ?? ""; page.value = Math.min(page.value, pages.value); }
  editingKey.value = ""; change(); failed.value = false; message.value = original ? "已取消本车修改。" : "已取消新增车辆。";
}
function unfinishedProfile() { return rows.value.find(row => !originalRows.some(item => item.key === row.key)); }
function add() {
  if (busy.value) return;
  const unfinished = unfinishedProfile();
  if (unfinished) { selectRow(unfinished); page.value = Math.ceil((rows.value.indexOf(unfinished) + 1) / 12); fail(new Error("请先保存或取消当前新增车辆，再添加下一辆。")); return; }
  if (rows.value.length >= MAX_FLEET_VEHICLES) { fail(new Error("车辆档案最多" + MAX_FLEET_VEHICLES + "辆。")); return; }
  const row: Draft = { key: crypto.randomUUID(), plateNumber: "", vehicleType: "", energyType: "", capacityTonnes: "" };
  rows.value.push(row); selectRow(row); page.value = pages.value; change(); failed.value = false; message.value = "已新增一辆车的草稿，请填写车牌和基础信息后保存。";
}
function remove(row: Draft) {
  if (busy.value) return;
  rows.value = rows.value.filter(item => item.key !== row.key); selected.value = rows.value[0]?.key ?? ""; editingKey.value = ""; page.value = Math.min(page.value, pages.value); change();
}
function completeProfile(vehicle: VehicleState) {
  if (busy.value) return;
  if (vehicle.carrierId !== props.carrierId) { fail(new Error("当前角色只能维护本承运商车辆。")); return; }
  let row = rows.value.find(item => item.sourceId === vehicle.vehicleId);
  if (!row) {
    const unfinished = unfinishedProfile();
    if (unfinished) { selectRow(unfinished); fail(new Error("请先保存或取消当前新增车辆，再完善其他档案。")); return; }
    row = fromVehicle(vehicle); rows.value.push(row); change();
  }
  selectRow(row); page.value = Math.ceil((rows.value.indexOf(row) + 1) / 12);
  message.value = originalRows.some(item => item.key === row!.key) ? "已打开本方车辆档案，点击“修改车辆信息”后可编辑。" : row.plateNumber ? "已带入本方车辆，请完善基础信息后保存。" : "请补录真实车牌，保存后会关联该车的现有车次。";
}
function focus() {
  if (!props.focusVehicleId) return;
  const vehicle = data.value.vehicles.find(item => item.vehicleId === props.focusVehicleId && item.carrierId === props.carrierId);
  if (vehicle) completeProfile(vehicle); else fail(new Error("当前承运商下未找到该车辆，请核对角色和车牌。"));
}
async function save() {
  if (busy.value) return false;
  if (!dirty.value) return true;
  busy.value = true; failed.value = false; message.value = "";
  try {
    const plates = new Set<string>(), vehicles = rows.value.map((row, index) => {
      const problem = plateNumberError(row.plateNumber); if (problem) throw new Error("第" + (index + 1) + "辆车：" + problem);
      const plateNumber = normalizePlateNumber(row.plateNumber); if (plates.has(plateNumber)) throw new Error("车牌" + plateNumber + "重复，不能重复建档。"); plates.add(plateNumber);
      return { plateNumber, carrierId: props.carrierId, ...(row.sourceId && row.sourceId !== plateNumber ? { sourceVehicleId: row.sourceId } : {}), ...(row.vehicleType ? { vehicleType: row.vehicleType } : {}), ...(row.energyType ? { energyType: row.energyType } : {}), ...(String(row.capacityTonnes).trim() ? { capacityTonnes: Number(row.capacityTonnes) } : {}) };
    });
    const body = JSON.stringify({ carrierId: props.carrierId, vehicles, baseVersion: baseVersion.value }); if (new TextEncoder().encode(body).length > 4 * 1024 * 1024) throw new Error("车辆资料超过4 MiB，请减少记录后保存。");
    const value = await carrierApi<FleetOverview>(props.carrierId, "/api/fleet", { method: "POST", body }); adopt(value, normalizePlateNumber(current.value?.plateNumber ?? "")); emit("saved", value, props.carrierId); message.value = "已保存" + carrier.value?.name + "的车辆档案。"; return true;
  } catch (cause) { fail(cause); return false; } finally { busy.value = false; }
}
adopt(props.fleet); focus();
watch(() => [props.fleet.version, props.fleet.parkVersion], () => { if (!dirty.value && !busy.value && !editingKey.value) adopt(props.fleet); else data.value = props.fleet; });
watch(() => props.focusVehicleId, focus);
</script>
<template>
  <section aria-label="本承运商车辆档案">
    <section v-if="pending.length" class="fleet-panel pending-profiles"><h2>待完善档案 · {{ pending.length }} 辆</h2><p>这些本方车辆已有车次，可以逐辆完善档案。</p><div><UiButton v-for="vehicle in pending.slice(0, 6)" :key="vehicle.vehicleId" class="secondary" :disabled="busy" @click="completeProfile(vehicle)">{{ vehicle.plateNumber || '待补录车牌' }} · 完善档案</UiButton></div></section>
    <section class="fleet-panel fleet-add-panel"><div class="fleet-panel-heading"><div><h2>为{{ carrier?.name }}添加车辆</h2><p>每次手动添加一辆，保存后可继续添加下一辆。</p></div><UiButton class="primary" :disabled="busy" @click="add">新增车辆</UiButton></div><p class="fleet-field-note">归属固定为当前承运商。这里只填写车辆基础信息，实际入口在车次登记时确认。</p></section>
    <UiAlert v-if="message" class="fleet-feedback" :class="{ error: failed }" role="status">{{ message }}</UiAlert>
    <div v-if="rows.length" class="fleet-editor-columns">
      <section class="fleet-panel fleet-vehicle-list"><div class="fleet-panel-heading"><h2>本方车辆档案</h2><span>{{ rows.length }} 辆</span></div><UiButton v-for="row in pageRows" :key="row.key" class="fleet-vehicle-option" :class="{ active: selected === row.key }" :disabled="busy" @click="selectRow(row)"><strong>{{ row.plateNumber || '待填写车牌' }}</strong><span>{{ row.vehicleType ? VEHICLE_TYPES[row.vehicleType as keyof typeof VEHICLE_TYPES] : '车型未提供' }} · {{ row.energyType ? ENERGY_TYPES[row.energyType as keyof typeof ENERGY_TYPES] : '动力未提供' }}</span></UiButton><div class="fleet-pagination"><UiButton :disabled="busy || page <= 1" @click="page--">上一页</UiButton><span>{{ page }} / {{ pages }}</span><UiButton :disabled="busy || page >= pages" @click="page++">下一页</UiButton></div></section>
      <section class="fleet-panel">
        <template v-if="current">
          <div class="fleet-panel-heading"><div><h2>车辆基础信息</h2><p>所属承运商：{{ carrier?.name }}（当前角色）</p></div><div class="button-row"><UiButton v-if="!editable" class="secondary" :disabled="busy" @click="edit">修改车辆信息</UiButton><UiButton v-else class="secondary" :disabled="busy" @click="cancelEdit">{{ newProfile ? '取消新增' : '取消修改' }}</UiButton><UiButton v-if="!newProfile" class="fleet-remove" :disabled="busy" @click="remove(current)">删除此档案</UiButton></div></div>
          <form @submit.prevent="save" @input="change" @change="change"><div class="fleet-form-grid">
            <LicensePlateInput :key="current.key" v-model="current.plateNumber" :readonly="!editable || !!savedPlate" :disabled="busy" @update:model-value="change" />
            <label>车辆类型<UiSelect v-model="current.vehicleType" :disabled="busy || !editable"><option value="">暂未提供</option><option v-for="(label, value) in VEHICLE_TYPES" :key="value" :value="value">{{ label }}</option></UiSelect></label>
            <label>动力类型<UiSelect v-model="current.energyType" :disabled="busy || !editable"><option value="">暂未提供</option><option v-for="(label, value) in ENERGY_TYPES" :key="value" :value="value">{{ label }}</option></UiSelect></label>
            <label>额定载重（吨）<UiInput v-model="current.capacityTonnes" type="number" min="0" max="1000" step="0.01" :disabled="busy || !editable" placeholder="未知可留空" /></label>
            <p class="fleet-field-note">{{ editable ? '核对基础信息后点击下方保存。' : '档案已保存，点击“修改车辆信息”后可编辑。' }}车牌唯一识别车辆，已保存车牌不能直接改号。建档不代表已经进园。</p>
          </div></form>
        </template>
      </section>
    </div>
    <section v-else class="fleet-panel fleet-empty"><strong>本承运商尚无车辆档案</strong><p>点击“新增车辆”，填写一辆车的基础信息后保存。</p></section>
    <div class="fleet-save-bar"><div><strong>{{ carrier?.name }} · {{ rows.length }} 辆车</strong><span>{{ dirty ? '有未保存修改' : '档案已同步' }}。保存只更新本承运商，删除档案不删除车次。</span></div><UiButton class="primary" :disabled="busy || !dirty" @click="save">{{ busy ? '正在保存…' : '保存车辆档案' }}</UiButton></div>
  </section>
</template>
