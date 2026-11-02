<script setup lang="ts">
import { onMounted, ref, toRaw } from "vue";
import { PARK_ENTRANCES, type ParkCatalog, type ParkSettings, type PublicNode } from "@vectra/shared";
import { api } from "../api";
import { useWorkspace } from "../stores/workspace";
import { setParkSettings, setRegisteredIdentities } from "../park-state";
import { useUnsavedChanges } from "../use-unsaved-changes";
const emit = defineEmits<{ saved: [] }>(), workspace = useWorkspace(), catalog = ref<ParkCatalog>(), draft = ref<ParkSettings>(), editing = ref(false), busy = ref(false), message = ref(""), baseVersion = ref("");
useUnsavedChanges(() => editing.value, "园区基础设置");
const clone = (value: ParkSettings): ParkSettings => ({ ...structuredClone(toRaw(value)), entranceRoads: [...PARK_ENTRANCES] });
async function load() { try { catalog.value = await api<ParkCatalog>("/api/park"); if (!editing.value) draft.value = clone(catalog.value.settings); } catch (cause) { message.value = String(cause); } }
function edit() { if (!catalog.value) return; draft.value = clone(catalog.value.settings); baseVersion.value = catalog.value.version; editing.value = true; message.value = ""; }
function cancel() { editing.value = false; if (catalog.value) draft.value = clone(catalog.value.settings); }
async function save() { busy.value = true; message.value = ""; try { catalog.value = await api<ParkCatalog>("/api/park/settings", { method: "PUT", body: JSON.stringify({ settings: draft.value, baseVersion: baseVersion.value }) }); editing.value = false; draft.value = clone(catalog.value.settings); setParkSettings(catalog.value.settings); if (workspace.overview) workspace.overview.park = catalog.value.settings; const nodes = await api<PublicNode[]>("/api/identities"); setRegisteredIdentities(nodes); if (workspace.overview) workspace.overview.nodes = nodes; message.value = "园区和承运商名称已保存。车辆与车次归属继续按原登记编号关联。"; emit("saved"); } catch (cause) { message.value = String(cause); } finally { busy.value = false; } }
onMounted(load);
</script>
<template>
  <details class="fleet-panel"><summary>园区基础设置</summary><div v-if="draft" class="park-settings-content"><div class="fleet-panel-heading"><div><h2>园区与承运商名称</h2><p>这里维护园区公共信息；车辆与车次由各公司在独立企业端管理。</p></div><UiButton v-if="!editing" class="secondary" :disabled="busy" @click="edit">修改配置</UiButton></div><form @submit.prevent="save"><UiFieldset :disabled="busy || !editing"><label>园区名称<UiInput v-model="draft.name" maxlength="80" required /></label><div class="park-carrier-names"><label v-for="carrier in draft.carriers" :key="carrier.id">承运商名称<UiInput v-model="carrier.name" maxlength="50" required /><small>登记编号：{{ carrier.id }}</small></label></div><div class="park-fixed-entrances"><span v-for="entrance in PARK_ENTRANCES" :key="entrance">{{ entrance }}</span></div><p class="fleet-config-note">园区固定四个入口。入口在每次车次登记时确认，车辆档案不选择入口；同一车次沿用已登记的实际入口。</p></UiFieldset><div v-if="editing" class="button-row"><UiButton class="primary" :disabled="busy">保存配置</UiButton><UiButton type="button" class="secondary" :disabled="busy" @click="cancel">取消修改</UiButton></div></form></div><UiAlert v-if="message" class="fleet-feedback" role="status">{{ message }}</UiAlert></details>
</template>
<style scoped>
.park-settings-content{margin-top:23px}.park-settings-content fieldset{border:0;padding:0;margin:0;min-width:0}.park-settings-content label{display:grid;gap:7px;font-size:12px;color:#6d8a76}.park-settings-content input{width:100%;box-sizing:border-box}.park-settings-content>form>fieldset>label{max-width:600px}.park-carrier-names{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-top:20px}.park-carrier-names small{font-size:10px;color:#a0b1a4}.park-fixed-entrances{display:flex;gap:14px;margin-top:22px}.park-fixed-entrances span{padding:11px 25px;border-radius:8px;background:#f2f8f3;border:1px solid #dfeae1;font-size:12px;color:#64836e}.park-settings-content fieldset:disabled input{background:#f5f8f4;color:#809985}
</style>
