<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isCarrierId, PARK_ENTRANCES, PARK_FIELD_LABELS, shanghaiDateTime, type CarrierId, type FleetOverview, type ParkCatalog, type ParkSnapshot } from "@vectra/shared";
import { currentParkSettings, setParkSettings } from "../park-state";
import { carrierApi, currentCarrierRole, selectCarrierRole } from "../carrier-role";
import { useUnsavedChanges } from "../use-unsaved-changes";
import CarrierVehicleEditor from "../components/CarrierVehicleEditor.vue";
import ParkVisitEditor from "../components/ParkVisitEditor.vue";
import ReservationEditor from "../components/ReservationEditor.vue";
import { portalSession } from "../portal";
const route = useRoute(), router = useRouter(), carrierId = ref<CarrierId>(currentCarrierRole.value?.carrierId ?? "carrier-a"), tab = ref("vehicles"), busy = ref(false), message = ref("");
const fleets = ref<Partial<Record<CarrierId, FleetOverview>>>({}), catalogs = ref<Partial<Record<CarrierId, ParkCatalog>>>({});
const vehicleDirty = ref<Partial<Record<CarrierId, boolean>>>({}), visitDirty = ref<Partial<Record<CarrierId, boolean>>>({}), editingBusy = ref<Record<string, boolean>>({});
const reservationDirty = ref<Partial<Record<CarrierId, boolean>>>({});
const fleet = computed(() => fleets.value[carrierId.value]), catalog = computed(() => catalogs.value[carrierId.value]), carrier = computed(() => currentParkSettings.value.carriers.find(item => item.id === carrierId.value));
const blocked = computed(() => busy.value || Object.values(editingBusy.value).some(Boolean));
const unsaved = computed(() => Object.values(vehicleDirty.value).some(Boolean) || Object.values(visitDirty.value).some(Boolean) || Object.values(reservationDirty.value).some(Boolean));
useUnsavedChanges(() => unsaved.value, "承运商工作台");
let pendingRoute = false;
const entryReady = computed(() => !busy.value && (portalSession.value?.role === "carrier" || !isCarrierId(route.query.carrierId) || route.query.carrierId === carrierId.value));
const focusVehicle = computed(() => entryReady.value && tab.value === "vehicles" && typeof route.query.vehicleId === "string" ? route.query.vehicleId : undefined);
const visitFocusVehicle = computed(() => entryReady.value && tab.value === "visits" && typeof route.query.vehicleId === "string" ? route.query.vehicleId : undefined);
const coverage = computed(() => PARK_ENTRANCES.map(id => catalog.value?.roads.find(row => row.id === id) ?? { id, vehicleCount: 0, sampleCount: 0, start: null, end: null, fields: [] }));
const fieldLabel = (field: string) => PARK_FIELD_LABELS[field as keyof typeof PARK_FIELD_LABELS] ?? field;
async function choose(id: CarrierId) {
  if (blocked.value) return; busy.value = true; message.value = "";
  try { await selectCarrierRole(id); carrierId.value = id; const [vehicles, visits] = await Promise.all([carrierApi<FleetOverview>(id, "/api/carrier/fleet"), carrierApi<ParkSnapshot>(id, "/api/carrier/visits")]); fleets.value[id] = vehicles; catalogs.value[id] = visits.catalog; setParkSettings(vehicles.settings); }
  catch (cause) { message.value = cause instanceof Error ? cause.message : String(cause); } finally { busy.value = false; }
}
async function switchRole(id: CarrierId) { if (blocked.value) return; if (id === carrierId.value && route.query.carrierId === id) await choose(id); else await router.replace({ path: "/carriers", query: { carrierId: id, tab: tab.value } }); }
async function changeTab(value: string) { if (blocked.value) return; tab.value = value; await router.replace({ path: "/carriers", query: { carrierId: carrierId.value, tab: value } }); }
function markVehicles(value: boolean, id: CarrierId) { vehicleDirty.value[id] = value; }
function markVisits(value: boolean, id?: CarrierId) { if (id) visitDirty.value[id] = value; }
function markVehicleBusy(value: boolean, id: CarrierId) { editingBusy.value["vehicles:" + id] = value; }
function markVisitBusy(value: boolean, id?: CarrierId) { if (id) editingBusy.value["visits:" + id] = value; }
function markReservations(value: boolean, id?: CarrierId) { if (id) reservationDirty.value[id] = value; }
function markReservationBusy(value: boolean, id?: CarrierId) { if (id) editingBusy.value["reservations:" + id] = value; }
function loaded(value: ParkCatalog, id?: CarrierId) { if (id) catalogs.value[id] = value; }
async function refreshFleet() { const id = carrierId.value; try { fleets.value[id] = await carrierApi<FleetOverview>(id, "/api/carrier/fleet"); } catch (cause) { message.value = String(cause); } }
async function profileSaved(value: FleetOverview, id: CarrierId) { fleets.value[id] = value; try { catalogs.value[id] = (await carrierApi<ParkSnapshot>(id, "/api/carrier/visits")).catalog; } catch (cause) { message.value = String(cause); } }
async function visitsSaved(value: ParkCatalog, id?: CarrierId) { loaded(value, id); if (id === carrierId.value) await refreshFleet(); }
async function syncRoute() {
  if (blocked.value) { pendingRoute = true; return; }
  const id = portalSession.value?.carrierId ?? (isCarrierId(route.query.carrierId) ? route.query.carrierId : currentCarrierRole.value?.carrierId ?? "carrier-a");
  tab.value = route.query.tab === "reservations" ? "reservations" : route.query.tab === "visits" || route.query.action === "new-visit" ? "visits" : "vehicles";
  if (!fleet.value || !catalog.value || carrierId.value !== id || currentCarrierRole.value?.carrierId !== id) await choose(id);
}
watch(() => route.query, syncRoute, { immediate: true });
watch(blocked, value => { if (!value && pendingRoute) { pendingRoute = false; void syncRoute(); } });
</script>
<template>
  <section class="fleet-page carrier-workspace"><div class="fleet-heading carrier-workspace-heading"><div class="carrier-workspace-title"><span class="fleet-eyebrow">本方车辆与运营台账</span><h1>企业车辆与车次</h1><p>维护本方车辆、实际车次与未来预约计划。</p></div>
      <div v-if="!portalSession || portalSession.legacy" class="carrier-role-control"><span class="carrier-role-label">切换承运商角色</span><div class="carrier-role-buttons" role="group" aria-label="切换承运商角色"><UiButton v-for="item in currentParkSettings.carriers" :key="item.id" type="button" :class="{ active: carrierId === item.id }" :aria-pressed="carrierId === item.id" :title="item.name + (vehicleDirty[item.id] || visitDirty[item.id] || reservationDirty[item.id] ? ' · 有未保存草稿' : '')" :disabled="blocked" @click="switchRole(item.id)"><span v-if="carrierId === item.id" aria-hidden="true">✓</span><span class="carrier-role-name">{{ item.name }}</span><i v-if="vehicleDirty[item.id] || visitDirty[item.id] || reservationDirty[item.id]" class="carrier-draft-dot" role="img" aria-label="有未保存草稿"></i></UiButton></div></div>
    </div>
    <p class="carrier-role-note">当前为{{ carrier?.name }}，新增资料自动归属于本方。页签切换会保留本页草稿。</p>
    <UiAlert v-if="message" class="fleet-feedback error" role="alert">{{ message }}</UiAlert><div v-if="busy" class="fleet-feedback" role="status">正在读取本公司车辆与车次…</div>
    <template v-if="fleet && catalog"><div v-if="tab !== 'reservations'" class="fleet-metrics"><div><small>本方车辆</small><strong>{{ fleet.vehicles.length }}<span>辆</span></strong><p>车辆档案与本方车次去重</p></div><div><small>已建车辆档案</small><strong>{{ fleet.vehicles.filter(vehicle => vehicle.profiled).length }}<span>辆</span></strong><p>可以直接带入车次登记</p></div><div><small>本方车次</small><strong>{{ catalog.visitCount }}<span>次</span></strong><p>每次进园单独登记</p></div><div><small>本方已离园车次</small><strong>{{ catalog.completedCount }}<span>次</span></strong><p>已提供实际离园时间</p></div></div>
      <div class="carrier-workspace-tabs" role="tablist" aria-label="本承运商资料"><UiButton role="tab" :aria-selected="tab === 'vehicles'" :class="{ active: tab === 'vehicles' }" :disabled="blocked" @click="changeTab('vehicles')">车辆档案<span v-if="vehicleDirty[carrierId]"> · 未保存</span></UiButton><UiButton role="tab" :aria-selected="tab === 'visits'" :class="{ active: tab === 'visits' }" :disabled="blocked" @click="changeTab('visits')">车次登记<span v-if="visitDirty[carrierId]"> · 未保存</span></UiButton><UiButton role="tab" :aria-selected="tab === 'reservations'" :class="{ active: tab === 'reservations' }" :disabled="blocked" @click="changeTab('reservations')">预约需求与运力<span v-if="reservationDirty[carrierId]"> · 未保存</span></UiButton></div>
      <UiFieldset class="carrier-editing-scope" :disabled="busy"><KeepAlive><CarrierVehicleEditor v-if="tab === 'vehicles'" :key="carrierId" :carrier-id="carrierId" :fleet="fleet" :focus-vehicle-id="focusVehicle" @dirty="markVehicles" @busy="markVehicleBusy" @saved="profileSaved" /></KeepAlive><KeepAlive><ParkVisitEditor v-if="tab === 'visits'" :key="carrierId" :scope-carrier="carrierId" :catalog="catalog" :fleet="fleet" :focus-vehicle-id="visitFocusVehicle" :guard-navigation="false" @dirty="markVisits" @busy="markVisitBusy" @loaded="loaded" @saved="visitsSaved" @refresh-fleet="refreshFleet" /></KeepAlive><KeepAlive><ReservationEditor v-if="tab === 'reservations'" :key="carrierId" :carrier-id="carrierId" @dirty="markReservations" @busy="markReservationBusy" /></KeepAlive></UiFieldset>
      <details v-if="tab === 'visits'" class="fleet-panel"><summary>本承运商的入口数据覆盖</summary><p class="fleet-config-note">{{ catalog.settings.name }} · 快照发布于 {{ shanghaiDateTime(catalog.updatedAt) }}。固定为东、南、西、北四个入口。</p><UiTable class="fleet-table"><thead><tr><th>入口</th><th>本方车辆</th><th>本方车次</th><th>可统计字段</th></tr></thead><tbody><tr v-for="road in coverage" :key="road.id"><td>{{ road.id }}</td><td>{{ road.vehicleCount }}辆</td><td>{{ road.sampleCount }}次</td><td>{{ road.fields.map(fieldLabel).join('、') || '暂无数据' }}</td></tr></tbody></UiTable></details>
      <details v-if="tab === 'visits'" class="fleet-panel"><summary>车次导入格式说明</summary><p class="fleet-config-note">文件只包含需要追加的当前承运商车次数组，carrierId 填写 {{ carrierId }}，vehicleId 填写完整车牌号。必填 visitId、carrierId、vehicleId、road、arrivedAt。到达、核验、入园、作业与离园时间按真实顺序填写，未知事件留空；时间按上海时区处理。先核对预览，再确认追加；保留已有车次与其他承运商记录，重复车次编号会被拒绝。</p><p class="fleet-config-note">园区名称与承运商名称在“园区车辆”页的“园区基础设置”统一维护。车牌号是车辆唯一标识，同一车牌不能跨承运商登记。</p></details>
    </template><p v-else-if="!busy" class="fleet-loading"><UiButton class="secondary" @click="choose(carrierId)">重新载入当前角色资料</UiButton></p>
  </section>
</template>
<style scoped>
.carrier-workspace-heading{align-items:flex-start;margin-bottom:13px}.carrier-workspace-title{min-width:0;flex:1}.carrier-role-control{display:grid;justify-items:end;gap:7px;flex:none;max-width:54%;padding-top:2px}.carrier-role-label{font-size:10px;color:#8a9b90}.carrier-role-buttons{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}.carrier-role-buttons button{display:inline-flex;align-items:center;gap:5px;max-width:165px;min-height:32px;padding:5px 10px;border:1px solid #dfe8e2;border-radius:7px;background:#fff;color:#74887b;font-size:11px;line-height:1.6}.carrier-role-buttons button.active{background:#edf7f0;border-color:#a6cdb7;color:#387556}.carrier-role-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.carrier-draft-dot{width:5px;height:5px;flex:none;border-radius:50%;background:#bb9957}.carrier-role-note{margin:0 0 22px;font-size:11px;color:#879b8d}.carrier-workspace-tabs{display:flex;gap:12px;border-bottom:1px solid #dce7df;margin-top:25px}.carrier-workspace-tabs button{border:0;border-bottom:2px solid transparent;background:transparent;padding:15px 24px;border-radius:0;color:#8ba18f;font-size:13px}.carrier-workspace-tabs button.active{border-bottom-color:#398864;color:#397e55;background:#eff7ef}.carrier-workspace-tabs span{font-size:10px}.carrier-editing-scope{border:0;margin:0;padding:0;min-width:0}.carrier-editing-scope:disabled{opacity:.65}
</style>
