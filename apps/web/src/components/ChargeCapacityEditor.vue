<script setup lang="ts">
import { computed,onMounted,reactive,ref,watch } from "vue";
import { PARK_ENTRANCES,CHARGE_CONNECTORS,parseParkTimestamp,shanghaiTimestamp,shanghaiDateTime,type ChargeCapacitySlot,type ChargeConnector } from "@vectra/shared";
import { api } from "../api";
import { useUnsavedChanges } from "../use-unsaved-changes";
const emit=defineEmits<{dirty:[value:boolean];busy:[value:boolean]}>();
const rows=ref<ChargeCapacitySlot[]>([]),version=ref(""),baseline=ref("[]"),busy=ref(false),message=ref(""),failed=ref(false),page=ref(1);
const draft=reactive({road:"东入口",slot:shanghaiTimestamp(Math.ceil((Date.now()+1)/1800000)*1800000).slice(0,16),count:1,connector:"dc" as ChargeConnector,ports:"",maxPowerKw:"",capacityKwh:"",useMaximum:true});
const dirty=computed(()=>JSON.stringify(rows.value)!==baseline.value),physical=computed(()=>Number(draft.ports)*Number(draft.maxPowerKw)*0.5);
const visible=computed(()=>rows.value.slice((page.value-1)*12,page.value*12)),pages=computed(()=>Math.max(1,Math.ceil(rows.value.length/12)));
watch(dirty,value=>emit("dirty",value),{flush:"sync"});watch(busy,value=>emit("busy",value),{flush:"sync"});
useUnsavedChanges(()=>dirty.value,"园区充电容量");
function accept(value:{version:string;slots:ChargeCapacitySlot[]}){rows.value=value.slots;version.value=value.version;baseline.value=JSON.stringify(rows.value);page.value=1;}
function fail(cause:unknown){failed.value=true;message.value=cause instanceof Error?cause.message:String(cause);}
async function load(){if(busy.value)return;if(dirty.value&&!window.confirm("充电容量草稿尚未保存，是否放弃并刷新？"))return;busy.value=true;try{accept(await api("/api/charging-capacity"));}catch(cause){fail(cause);}finally{busy.value=false;}}
function add(){
  try{
    const slotStart=parseParkTimestamp(draft.slot),count=Number(draft.count),ports=Number(draft.ports),maxPowerKw=Number(draft.maxPowerKw),capacityKwh=draft.useMaximum?physical.value:Number(draft.capacityKwh);
    if(!Number.isSafeInteger(slotStart)||slotStart<=Date.now()||slotStart%1800000||!Number.isInteger(count)||count<1||count>48||!String(draft.ports).trim()||!String(draft.maxPowerKw).trim()||!draft.useMaximum&&!String(draft.capacityKwh).trim()||![ports,maxPowerKw,capacityKwh].every(value=>Number.isFinite(value)&&value>=0)||!Number.isInteger(ports))throw new Error("请填写完整半小时时段、1—48个连续时段及有效容量数值。");
    const pending=Array.from({length:count},(_,i)=>({road:draft.road,slotStart:slotStart+i*1800000,connector:draft.connector,ports,maxPowerKw,capacityKwh}));
    if(pending.some(row=>rows.value.some(old=>old.road===row.road&&old.slotStart===row.slotStart&&old.connector===row.connector)))throw new Error("所选时段已存在相同入口和接口，请编辑原容量。");
    if(rows.value.length+pending.length>6000)throw new Error("容量台账最多6000条。");
    rows.value.push(...pending);page.value=Math.ceil(rows.value.length/12);failed.value=false;message.value="已加入容量草稿，保存后才用于后续任务。";
  }catch(cause){fail(cause);}
}
async function save(){if(busy.value)return;busy.value=true;try{accept(await api("/api/charging-capacity",{method:"PUT",body:JSON.stringify({slots:rows.value,baseVersion:version.value})}));failed.value=false;message.value="园区充电容量已保存，历史签名结果继续使用原容量版本。";}catch(cause){fail(cause);}finally{busy.value=false;}}
function remove(row:ChargeCapacitySlot){if(row.slotStart<=Date.now()&&row.slotStart+1800000>Date.now())return;rows.value=rows.value.filter(item=>item!==row);page.value=Math.min(page.value,pages.value);}
async function importFile(event:Event){
 const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;
 try{if(file.size>4*1024*1024)throw new Error("文件最多4MiB。");const incoming=JSON.parse(await file.text());if(!Array.isArray(incoming)||rows.value.length+incoming.length>6000)throw new Error("请提供容量数组，总计最多6000条。");
 const keys=new Set(rows.value.map(row=>row.road+":"+row.slotStart+":"+row.connector)),pending:ChargeCapacitySlot[]=[];
 for(const raw of incoming){const slotStart=parseParkTimestamp(raw.slotStart),key=raw.road+":"+slotStart+":"+raw.connector;if(keys.has(key)||!Number.isSafeInteger(slotStart))throw new Error("存在重复时段或无效时间。");keys.add(key);pending.push({...raw,slotStart});}rows.value.push(...pending);failed.value=false;message.value="已导入草稿，保存时完整校验。";
 }catch(cause){fail(cause);}finally{input.value="";}
}
onMounted(load);
</script>
<template>
 <section class="charge-capacity panel"><div class="panel-heading"><div><h2>园区分时充电容量</h2><p class="muted">按入口、半小时时段和接口分别维护。未配置表示未知；显式填零表示该时段不提供相应补能。</p></div><UiButton type="button" :disabled="busy" @click="load">刷新容量</UiButton></div>
 <UiAlert v-if="message" :type="failed ? 'error' : 'success'">{{ message }}</UiAlert>
 <form class="charge-capacity-form" @submit.prevent="add"><label>入口<UiSelect v-model="draft.road"><option v-for="road in PARK_ENTRANCES" :key="road">{{ road }}</option></UiSelect></label><label>开始时段（上海）<UiInput v-model="draft.slot" type="datetime-local" step="1800" required /></label><label>连续半小时时段数<UiInput v-model="draft.count" type="number" min="1" max="48" required /></label><label>接口<UiSelect v-model="draft.connector"><option v-for="(label,key) in CHARGE_CONNECTORS" :key="key" :value="key">{{ label }}</option></UiSelect></label><label>可用接口数量<UiInput v-model="draft.ports" type="number" min="0" step="1" required /></label><label>单接口功率上限（kW）<UiInput v-model="draft.maxPowerKw" type="number" min="0" step="0.0001" required /></label><label class="charge-capacity-check"><input v-model="draft.useMaximum" type="checkbox" />按申报功率上限估算半小时额度</label><label v-if="!draft.useMaximum">每半小时分配电量（kWh）<UiInput v-model="draft.capacityKwh" type="number" min="0" step="0.0001" required /></label><p v-else class="muted">每半小时拟分配 {{ Number.isFinite(physical) ? physical : '—' }} kWh</p><UiButton class="primary-button" :disabled="busy">加入容量草稿</UiButton></form>
 <UiTable v-if="visible.length" class="charge-capacity-table"><thead><tr><th>入口 / 时段（上海）</th><th>接口</th><th>数量</th><th>功率（kW）</th><th>电量（kWh）</th><th></th></tr></thead><tbody><tr v-for="row in visible" :key="row.road + row.slotStart + row.connector"><td>{{ row.road }}<small>{{ shanghaiDateTime(row.slotStart) }}</small></td><td>{{ CHARGE_CONNECTORS[row.connector] }}</td><td><UiInput v-model.number="row.ports" type="number" min="0" step="1" :disabled="busy || row.slotStart <= Date.now()" /></td><td><UiInput v-model.number="row.maxPowerKw" type="number" min="0" step="0.0001" :disabled="busy || row.slotStart <= Date.now()" /></td><td><UiInput v-model.number="row.capacityKwh" type="number" min="0" step="0.0001" :disabled="busy || row.slotStart <= Date.now()" /></td><td><UiButton type="button" class="remove-button" :disabled="busy || row.slotStart <= Date.now() && row.slotStart + 1800000 > Date.now()" @click="remove(row)">{{ row.slotStart <= Date.now() ? '归档' : '移除' }}</UiButton></td></tr></tbody></UiTable>
 <p v-else class="muted">尚未配置充电容量，联合结果会保留需求并提示补齐容量。</p>
 <div class="button-row"><UiButton type="button" class="primary-button" :disabled="busy || !dirty" @click="save">保存园区充电容量</UiButton><UiButton type="button" :disabled="page <= 1" @click="page--">上一页</UiButton><span class="muted">{{ page }} / {{ pages }} · {{ rows.length }} 条</span><UiButton type="button" :disabled="page >= pages" @click="page++">下一页</UiButton><label class="muted">导入JSON<input type="file" accept=".json,application/json" :disabled="busy" @change="importFile" /></label></div>
 <p class="muted">总电量对比只说明容量压力，不能代替包含接口、功率、到达和截止时间的逐车排程。</p>
 </section>
</template>
<style scoped>
.charge-capacity-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:17px;margin:20px 0 25px}.charge-capacity-form label{display:grid;gap:8px;font-size:11px;color:#78917f}.charge-capacity-form .charge-capacity-check{display:flex;align-items:center;gap:8px}.charge-capacity-table{width:100%;font-size:11px}.charge-capacity-table th{text-align:left;background:#f3f7f3;padding:10px}.charge-capacity-table td{padding:10px;border-bottom:1px solid #e8eee8}.charge-capacity-table td:first-child{min-width:190px}.charge-capacity-table small{display:block;color:#97a89b;font-size:9px;margin-top:5px}.charge-capacity-table input{max-width:100px}
</style>

