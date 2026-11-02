<script setup lang="ts">
import { computed,onMounted,reactive,ref,watch } from "vue";
import { BUSINESS_DOMAINS,parseParkTimestamp,shanghaiTimestamp,shanghaiDateTime,shanghaiDay,PARK_ENTRANCES,type BusinessDomain,type BusinessSnapshot,type BusinessRecord,type FleetOverview,type ParkSnapshot,type CarrierId } from "@vectra/shared";
import { businessForms,businessDescriptions,businessRecordEnd } from "../business-forms";
import { carrierApi,currentCarrierRole,selectCarrierRole } from "../carrier-role";
const props=defineProps<{domain:BusinessDomain;carrierId:CarrierId}>();
const emit=defineEmits<{dirty:[value:boolean,domain:BusinessDomain];busy:[value:boolean,domain:BusinessDomain]}>();
type Row=Record<string,unknown>;
const records=ref<Row[]>([]),version=ref(""),baseline=ref(""),busy=ref(false),loaded=ref(false),message=ref(""),failed=ref(false),page=ref(1);
const viewVersion=ref(""),activeVersion=ref(""),versions=ref<Array<{version:string;updatedAt:number;rowCount:number}>>([]);
const fleet=ref<FleetOverview>(),visits=ref<ParkSnapshot>(),draft=reactive<Record<string,string|number|undefined>>({}),editing=ref(false),draftBaseline=ref("");
const draftDirty=computed(()=>JSON.stringify(draft)!==draftBaseline.value);
const coverage=reactive({enabled:false,start:"",end:""}),readOnly=computed(()=>!!viewVersion.value),fields=computed(()=>businessForms[props.domain]);
const signature=()=>JSON.stringify([records.value,coverage]);
const dirty=computed(()=>loaded.value&&(signature()!==baseline.value||draftDirty.value));
watch(dirty,value=>emit("dirty",value,props.domain),{flush:"sync"});watch(busy,value=>emit("busy",value,props.domain),{flush:"sync"});
const rows=computed(()=>records.value.slice((page.value-1)*10,page.value*10)),pages=computed(()=>Math.max(1,Math.ceil(records.value.length/10)));
const completed=computed(()=>visits.value?.visits.filter(row=>row.departedAt!==undefined)??[]);
const sourceSnapshots=ref<Record<string,ParkSnapshot>>({}),sourceBusy=ref(false),sourceFailure=ref("");
const sourceVersion=computed(()=>String(draft.sourceParkVersion??visits.value?.version??""));
const sourceVisit=computed(()=>sourceSnapshots.value[sourceVersion.value]?.visits.find(row=>row.visitId===draft.visitId));
const sourceDistance=computed(()=>sourceVisit.value?.distanceKm);
const future=computed(()=>props.domain!=="haulage");
const present=(value:unknown)=>value!==undefined&&value!==null&&String(value).trim()!=="";
const showKm=(value:number)=>value.toLocaleString("zh-CN",{maximumFractionDigits:4});
const mileageSum=computed(()=>{
  if(!present(draft.loadedDistanceKm)||!present(draft.emptyDistanceKm))return;
  const loaded=Number(draft.loadedDistanceKm),empty=Number(draft.emptyDistanceKm);
  return Number.isFinite(loaded)&&Number.isFinite(empty)&&loaded>=0&&empty>=0?loaded+empty:undefined;
});
const mileageDelta=computed(()=>sourceDistance.value!==undefined&&mileageSum.value!==undefined?(Math.round((sourceDistance.value-mileageSum.value)*10000)/10000||0):undefined);
const mileageIssue=computed(()=>{
  const loaded=present(draft.loadedDistanceKm),empty=present(draft.emptyDistanceKm);
  if(!loaded&&!empty)return "";
  if(loaded!==empty)return "载货与空驶里程须成对填写，未知时两项均留空。";
  if(mileageSum.value===undefined)return "载货与空驶里程须为有效非负数。";
  if(sourceBusy.value)return "正在读取来源车次里程，请稍后核对。";
  if(sourceFailure.value||!sourceVisit.value)return "无法核对来源车次里程，请重新选择车次或刷新本方台账。";
  if(sourceDistance.value!==undefined&&Math.abs(mileageSum.value-sourceDistance.value)>0.01){
    const difference=sourceDistance.value-mileageSum.value;
    return "来源车次完整里程为 "+showKm(sourceDistance.value)+" km，已填写合计 "+showKm(mileageSum.value)+" km，"+(difference>0?"还差 ":"超出 ")+showKm(Math.abs(difference))+" km。";
  }
  return "";
});
watch(()=>[draft.visitId,sourceVersion.value] as const,async([visitId,version],_previous,onCleanup)=>{
  sourceBusy.value=false;sourceFailure.value="";
  if(props.domain!=="haulage"||!visitId||!version||sourceSnapshots.value[version])return;
  const controller=new AbortController();onCleanup(()=>controller.abort());sourceBusy.value=true;
  try{
    const snapshot=await carrierApi<ParkSnapshot>(props.carrierId,"/api/carrier/visits?version="+encodeURIComponent(version),{signal:controller.signal});
    if(controller.signal.aborted)return;
    if(snapshot.version!==version||snapshot.catalog.carrierId!==props.carrierId)throw new Error("返回车次与本方来源记录不一致。");
    sourceSnapshots.value[version]=snapshot;
  }catch(cause){if(!controller.signal.aborted)sourceFailure.value=cause instanceof Error?cause.message:String(cause);}
  finally{if(!controller.signal.aborted)sourceBusy.value=false;}
});
const showTime=(value:unknown)=>Number.isFinite(Number(value))?shanghaiDateTime(Number(value)):"未记录";
const frozen=(row:Row)=>future.value&&Number(row.slotStart)<=Date.now();
const removable=(row:Row)=>!frozen(row)||businessRecordEnd(props.domain,row)<=Date.now();
const energy=computed(()=>{const capacity=Number(draft.batteryCapacityKwh),soc=Number(draft.socPercent),target=Number(draft.targetSocPercent);return present(draft.batteryCapacityKwh)&&present(draft.socPercent)&&present(draft.targetSocPercent)&&capacity>0&&soc>=0&&target>soc&&target<=100?(capacity*(target-soc)/100).toLocaleString("zh-CN",{maximumFractionDigits:3}):undefined;});
function fail(cause:unknown){failed.value=true;message.value=cause instanceof Error?cause.message:String(cause);}
function defaults(){
  for(const key of Object.keys(draft))delete draft[key];
  const slot=Math.ceil((Date.now()+1)/1800000)*1800000;
  Object.assign(draft,{id:crypto.randomUUID(),road:"东入口",slotStart:shanghaiTimestamp(slot).slice(0,23),earliestAt:shanghaiTimestamp(slot).slice(0,23),latestAt:shanghaiTimestamp(slot+7200000).slice(0,23),
    availableUntil:shanghaiTimestamp(slot+7200000).slice(0,23),deadlineAt:shanghaiTimestamp(slot+7200000).slice(0,23),reservedTrips:0,minimumCommittedTrips:0,regionCode:"1",connector:"dc"});
  editing.value=false;draftBaseline.value=JSON.stringify(draft);
}
function accept(value:BusinessSnapshot){
  if(value.catalog.carrierId!==props.carrierId||value.catalog.domain!==props.domain)throw new Error("返回台账不属于本公司，已停止载入。");
  records.value=value.records as unknown as Row[];version.value=value.version;
  const slot=Math.ceil((Date.now()+1)/1800000)*1800000;
  coverage.enabled=!!value.catalog.declaration;
  coverage.start=shanghaiTimestamp(value.catalog.declaration?.start??(future.value?slot:parseParkTimestamp(shanghaiDay(Date.now()-86400000)+"T00:00:00"))).slice(0,23);
  coverage.end=shanghaiTimestamp(value.catalog.declaration?.end??(future.value?slot+86400000:parseParkTimestamp(shanghaiDay(Date.now())+"T00:00:00"))).slice(0,23);
  loaded.value=true;baseline.value=signature();page.value=1;defaults();if(!readOnly.value)activeVersion.value=value.version;
}
async function load(){
  if(busy.value)return;
  if(dirty.value&&!window.confirm("本方经营台账有未保存草稿，是否放弃并重新载入？"))return;
  busy.value=true;message.value="";
  try{
    if(!currentCarrierRole.value||currentCarrierRole.value.carrierId!==props.carrierId||currentCarrierRole.value.expiresAt<=Date.now())await selectCarrierRole(props.carrierId);
    const root="/api/carrier/business/"+props.domain;
    const [snapshot,history,vehicles,trips]=await Promise.all([
      carrierApi<BusinessSnapshot>(props.carrierId,root+(viewVersion.value?"?version="+encodeURIComponent(viewVersion.value):"")),
      carrierApi<typeof versions.value>(props.carrierId,root+"/versions"),
      ["haulage","charging"].includes(props.domain)?carrierApi<FleetOverview>(props.carrierId,"/api/carrier/fleet"):undefined,
      props.domain==="haulage"?carrierApi<ParkSnapshot>(props.carrierId,"/api/carrier/visits"):undefined,
    ]);
    accept(snapshot);versions.value=history;if(vehicles)fleet.value=vehicles;if(trips){visits.value=trips;sourceSnapshots.value[trips.version]=trips;}
  }catch(cause){fail(cause);}finally{busy.value=false;}
}
function chooseVisit(){
  const visit=completed.value.find(row=>row.visitId===draft.visitId);if(!visit)return;
  draft.road=visit.road;draft.sourceParkVersion=visits.value!.version;
  const vehicle=fleet.value?.vehicles.find(row=>row.vehicleId===visit.vehicleId);
  if(vehicle?.capacityTonnes!==undefined)draft.loadCapacityTonnes=vehicle.capacityTonnes;
}
function candidate():Row{
  const row:Row={id:draft.id,...(props.domain==="haulage"?{}:{road:draft.road})};
  if(props.domain==="haulage"&&draft.sourceParkVersion)row.sourceParkVersion=draft.sourceParkVersion;
  for(const field of fields.value){
    const value=draft[field.key];if(!present(value)){if(field.required)throw new Error("请填写"+field.label+"。");continue;}
    if(field.kind==="number"){const amount=Number(value);if(!Number.isFinite(amount)||amount<0||field.integer&&!Number.isSafeInteger(amount))throw new Error(field.label+"须为有效非负"+(field.integer?"整数。":"数。"));row[field.key]=amount;}
    else if(field.kind==="time"){const at=parseParkTimestamp(value);if(!Number.isSafeInteger(at))throw new Error(field.label+"须为有效上海时间。");row[field.key]=at;}
    else row[field.key]=field.key==="regionCode"?Number(value):value;
  }
  if(props.domain==="haulage"){
    if(records.value.some(item=>item.id!==row.id&&item.visitId===row.visitId))throw new Error("该车次已有关联事实，请编辑原记录。");
    if(!fields.value.some(field=>field.kind==="number"&&present(row[field.key])))throw new Error("请至少补充一项实际装载或里程信息。");
    if(mileageIssue.value)throw new Error(mileageIssue.value);
  }
  if(future.value&&Number(row.slotStart)<=Date.now())throw new Error("请选择尚未开始的计划时段；历史记录请从本方版本查看。");
  return row;
}
function add(){
  try{const row=candidate(),index=records.value.findIndex(item=>item.id===row.id);if(index<0)records.value.push(row);else records.value[index]=row;
    defaults();page.value=Math.ceil(records.value.length/10)||1;failed.value=false;message.value="已加入本方草稿，保存后才发布新版本。";
  }catch(cause){fail(cause);}
}
function edit(row:Row){
  if(readOnly.value||frozen(row))return;
  if(draftDirty.value&&!window.confirm("当前录入内容尚未加入草稿，是否切换记录？"))return;
  defaults();Object.assign(draft,row);
  for(const field of fields.value)if(field.kind==="time"&&row[field.key]!==undefined)draft[field.key]=shanghaiTimestamp(Number(row[field.key])).slice(0,23);
  editing.value=true;draftBaseline.value=JSON.stringify(draft);
}
function remove(row:Row){if(readOnly.value||!removable(row))return;records.value=records.value.filter(item=>item.id!==row.id);page.value=Math.min(page.value,pages.value);}
function archive(){if(readOnly.value)return;records.value=records.value.filter(row=>!future.value||businessRecordEnd(props.domain,row)>Date.now());page.value=1;}
async function save(){
  if(busy.value||readOnly.value)return;
  if(draftDirty.value){fail(new Error("请先将当前录入内容加入草稿，或清空当前录入。"));return;}
  busy.value=true;message.value="";
  try{
    let declaration:Record<string,number>|undefined;
    if(coverage.enabled){const start=parseParkTimestamp(coverage.start),end=parseParkTimestamp(coverage.end);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=end)throw new Error("请填写有效的本方资料完整时间范围。");declaration={start,end};}
    const snapshot=await carrierApi<BusinessSnapshot>(props.carrierId,"/api/carrier/business/"+props.domain,{method:"PUT",body:JSON.stringify({records:records.value,declaration:declaration??null,baseVersion:version.value})});
    accept(snapshot);versions.value=[{version:snapshot.version,updatedAt:snapshot.catalog.updatedAt,rowCount:snapshot.records.length},...versions.value].slice(0,50);failed.value=false;message.value="本方台账与资料范围已保存，原始内容保存在本企业服务。";
  }catch(cause){fail(cause);}finally{busy.value=false;}
}
async function importFile(event:Event){
  const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;
  try{
    if(file.size>4*1024*1024)throw new Error("文件最多4MiB。");
    const value=JSON.parse(await file.text()),incoming=Array.isArray(value)?value:value.records;
    if(!Array.isArray(incoming)||incoming.length>6000)throw new Error("请提供记录数组，最多6000条。");
    const ids=new Set(records.value.map(row=>row.id));
    for(const row of incoming){if(!row||typeof row!=="object"||Array.isArray(row)||typeof row.id!=="string"||ids.has(row.id))throw new Error("导入记录须有不重复编号。");if(row.carrierId!==undefined&&row.carrierId!==props.carrierId)throw new Error("文件含其他公司资料，未导入。");ids.add(row.id);}
    if(records.value.length+incoming.length>6000)throw new Error("本方台账总计最多6000条。");
    records.value.push(...incoming);failed.value=false;message.value="已载入"+incoming.length+"条到草稿，确认保存前不会发布。";
  }catch(cause){fail(cause);}finally{input.value="";}
}
async function selectVersion(value:string){if(dirty.value&&!window.confirm("切换版本会放弃未保存草稿，是否继续？"))return;baseline.value=signature();draftBaseline.value=JSON.stringify(draft);viewVersion.value=value;await load();}
onMounted(load);
</script>
<template>
  <section class="business-ledger">
    <div class="ledger-heading"><div><h2>{{ BUSINESS_DOMAINS[domain] }}</h2><p>{{ businessDescriptions[domain] }}</p></div><UiButton type="button" :disabled="busy" @click="load">刷新本方台账</UiButton></div>
    <UiAlert v-if="message" :type="failed ? 'error' : 'success'" role="status">{{ message }}</UiAlert>
    <div class="ledger-version"><label>查看台账版本<UiSelect :model-value="viewVersion" :disabled="busy" @update:model-value="value => selectVersion(String(value))"><option value="">当前台账</option><option v-for="item in versions.filter(row => row.version !== activeVersion)" :key="item.version" :value="item.version">{{ shanghaiDateTime(item.updatedAt) }} · {{ item.rowCount }} 条</option></UiSelect></label><UiTag v-if="readOnly">历史只读</UiTag><span v-else>本方 {{ records.length }} 条<span v-if="dirty"> · 有未保存草稿</span></span></div>
    <template v-if="loaded">
      <section class="ledger-coverage">
        <label class="visit-check"><input v-model="coverage.enabled" type="checkbox" :disabled="readOnly || busy" />声明本方资料已完整核对的时间范围</label>
        <p>范围内没有记录表示本方明确为零；未声明或未覆盖的范围会显示“资料待补齐”。{{ domain === 'demand' ? '核对计划到达和最晚到达两种选取口径所需记录。' : '' }}</p>
        <div v-if="coverage.enabled" class="ledger-fields"><label>范围开始（上海）<UiInput v-model="coverage.start" type="datetime-local" step="0.001" :disabled="readOnly || busy" /></label><label>范围结束（上海）<UiInput v-model="coverage.end" type="datetime-local" step="0.001" :disabled="readOnly || busy" /></label></div>
      </section>
      <form v-if="!readOnly" class="ledger-entry" @submit.prevent="add">
        <div class="ledger-subheading"><h3>{{ editing ? '编辑本条记录' : '新增一条本方记录' }}</h3><p>先加入草稿，再统一保存；未知的可选数值留空。</p></div>
        <UiFieldset :disabled="busy"><div class="ledger-fields">
          <label v-if="domain !== 'haulage'">入口<UiSelect v-model="draft.road"><option v-for="road in PARK_ENTRANCES" :key="road" :value="road">{{ road }}</option></UiSelect></label>
          <label v-for="field in fields" :key="field.key">{{ field.label }}<small v-if="field.required">必填</small>
            <UiInput v-if="field.kind === 'number'" v-model="draft[field.key]" type="number" min="0" :step="field.integer ? '1' : '0.0001'" :required="field.required" />
            <UiInput v-else-if="field.kind === 'time'" v-model="draft[field.key]" type="datetime-local" step="0.001" :required="field.required" />
            <UiSelect v-else-if="field.kind === 'visit'" v-model="draft[field.key]" @change="chooseVisit"><option value="">选择本方已离园车次</option><option v-for="visit in completed" :key="visit.visitId" :value="visit.visitId">{{ visit.vehicleId }} · {{ visit.road }} · {{ showTime(visit.departedAt) }}</option></UiSelect>
            <UiSelect v-else-if="field.kind === 'vehicle'" v-model="draft[field.key]"><option value="">选择本方车辆</option><option v-for="vehicle in fleet?.vehicles.filter(row => row.profiled)" :key="vehicle.vehicleId" :value="vehicle.vehicleId">{{ vehicle.plateNumber || vehicle.vehicleId }}</option></UiSelect>
            <UiSelect v-else v-model="draft[field.key]"><option v-for="(label,key) in field.options" :key="key" :value="key">{{ label }}</option></UiSelect>
            <span v-if="field.kind === 'visit' && sourceVisit" class="ledger-source-distance">来源车次完整里程：<strong>{{ sourceDistance === undefined ? '未记录' : showKm(sourceDistance) + ' km' }}</strong></span>
          </label>
        </div></UiFieldset>
        <div v-if="domain === 'haulage'" class="ledger-mileage" :class="{ 'ledger-mileage-error': mileageIssue || sourceFailure }" role="status" aria-live="polite">
          <p v-if="!draft.visitId">选择本方已离园车次后，将显示来源车次完整里程。</p>
          <p v-else-if="sourceBusy">正在读取来源车次完整里程…</p>
          <p v-else-if="sourceFailure">{{ sourceFailure }} 请重新选择车次或刷新本方台账后核对。</p>
          <template v-else-if="sourceVisit">
            <p>来源车次完整里程：<strong>{{ sourceDistance === undefined ? '未记录' : showKm(sourceDistance) + ' km' }}</strong><span v-if="mileageSum !== undefined"> · 已填写合计：<strong>{{ showKm(mileageSum) }} km</strong></span></p>
            <p v-if="mileageIssue">{{ mileageIssue }}</p>
            <p v-else-if="sourceDistance === undefined">来源车次未记录完整里程。可按真实记录成对填写载货与空驶里程；两项均未知时留空。</p>
            <p v-else-if="mileageDelta !== undefined">里程核对通过。</p>
            <p v-else>载货与空驶里程之和应为 {{ showKm(sourceDistance) }} km；两项均未知时留空。</p>
          </template>
          <p v-else>未找到该来源车次，请刷新本方台账后核对。</p>
        </div>
        <p v-if="domain === 'haulage'" class="ledger-note">各装载能力用于同批有效记录的加权比值。</p>
        <p v-if="domain === 'charging'" class="ledger-energy">预计需要补能：<strong>{{ energy ? energy + ' kWh' : '填写电池容量、当前与目标电量后计算' }}</strong></p>
        <UiButton class="primary-button" :disabled="busy || domain === 'haulage' && (sourceBusy || !!mileageIssue)">{{ editing ? '更新本条草稿' : '加入本方草稿' }}</UiButton><UiButton type="button" :disabled="busy" @click="defaults">清空当前录入</UiButton>
      </form>
      <section class="ledger-records"><div class="ledger-subheading"><h3>{{ readOnly ? '该版本记录' : '本方台账草稿' }}</h3><span>{{ records.length }} 条</span></div>
        <UiTable v-if="rows.length"><thead><tr><th>{{ domain === 'haulage' ? '车辆 / 离园时间' : '入口 / 计划时间' }}</th><th>本条内容</th><th>操作</th></tr></thead><tbody><tr v-for="row in rows" :key="String(row.id)"><td><strong>{{ domain === 'haulage' ? row.vehicleId || row.visitId : row.road }}</strong><small>{{ showTime(row.recordedAt ?? row.slotStart) }}</small></td><td><div class="ledger-summary"><span v-for="field in fields.filter(item => item.kind !== 'time' && present(row[item.key]))" :key="field.key">{{ field.label }}：{{ field.options ? field.options[String(row[field.key])] : row[field.key] }}</span></div></td><td><UiButton type="button" :disabled="readOnly || busy || frozen(row)" @click="edit(row)">编辑</UiButton><UiButton type="button" class="remove-button" :disabled="readOnly || busy || !removable(row)" @click="remove(row)">{{ frozen(row) ? '归档' : '移除' }}</UiButton></td></tr></tbody></UiTable>
        <p v-else class="ledger-note">本方暂无记录。若已核对所选范围没有业务，可声明资料范围并保存空台账。</p>
        <div class="ledger-pagination"><span>第 {{ page }} / {{ pages }} 页</span><UiButton type="button" :disabled="page <= 1" @click="page--">上一页</UiButton><UiButton type="button" :disabled="page >= pages" @click="page++">下一页</UiButton></div>
      </section>
      <div v-if="!readOnly" class="ledger-save"><UiButton type="button" class="primary-button" :disabled="busy || !dirty" @click="save">{{ busy ? '正在保存…' : '保存本方台账与资料范围' }}</UiButton><UiButton v-if="future" type="button" :disabled="busy" @click="archive">归档已结束记录</UiButton><label class="ledger-import">导入JSON到草稿<input type="file" accept=".json,application/json" :disabled="busy" @change="importFile" /></label></div>
    </template>
    <p v-else role="status">正在读取本公司台账…</p>
  </section>
</template>
<style scoped>
.business-ledger{margin-top:24px}.ledger-heading,.ledger-subheading{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.ledger-heading h2{font-size:20px;color:#426b4d;margin:0 0 10px}.ledger-heading p,.ledger-note,.ledger-coverage p,.ledger-subheading p{font-size:11px;color:#8b9e90;line-height:1.9;margin:5px 0 16px}.ledger-heading>div{max-width:800px}.ledger-version{display:flex;align-items:end;gap:18px;margin:22px 0;font-size:11px;color:#92a296}.ledger-version label{display:grid;gap:7px;width:350px}.ledger-coverage,.ledger-entry,.ledger-records{border:1px solid #dfe8e1;border-radius:12px;padding:22px;background:#fff;margin-top:18px}.ledger-coverage{background:#f7faf7}.ledger-entry fieldset{border:0;padding:0;margin:0;min-width:0}.ledger-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.ledger-fields label{display:grid;gap:7px;font-size:11px;color:#67816f;align-content:start}.ledger-fields small{font-size:9px;color:#ac9672}.ledger-subheading h3{font-size:14px;color:#52765c;margin:0 0 18px}.ledger-subheading span{font-size:11px;color:#95a79a}.ledger-entry>button{margin:18px 10px 0 0}.ledger-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 16px;font-size:10px;color:#80978a;overflow-wrap:anywhere}.ledger-records table{width:100%;font-size:11px}.ledger-records th{background:#f1f6f2;color:#92a599;font-weight:500;padding:12px;text-align:left}.ledger-records td{padding:15px 12px;border-bottom:1px solid #e8eee9;vertical-align:top}.ledger-records td:first-child{width:220px}.ledger-records td:last-child{width:130px}.ledger-records td strong{color:#597c63}.ledger-records td small{display:block;font-size:10px;color:#96a79b;margin-top:8px}.ledger-pagination,.ledger-save{display:flex;gap:12px;align-items:center;margin-top:20px}.ledger-pagination{justify-content:end;font-size:10px;color:#95a69a}.ledger-import{margin-left:auto;font-size:11px;color:#7f9a87}.ledger-import input{display:block;margin-top:7px;max-width:260px;font-size:10px}.ledger-energy{font-size:12px;color:#73917b}.ledger-energy strong{color:#3c8055}
</style>
<style scoped>
.ledger-source-distance{font-size:12px;color:#52685c;line-height:1.7}.ledger-source-distance strong{color:#367a51}.ledger-mileage{margin-top:18px;padding:14px 16px;border:1px solid #dce8df;border-radius:8px;background:#f3f8f5;color:#52685c;font-size:13px;line-height:1.8}.ledger-mileage p{margin:0}.ledger-mileage p+p{margin-top:4px}.ledger-mileage strong{font-weight:600;color:#367a51}.ledger-mileage-error{background:#fff7f0;border-color:#eed2bb}.ledger-mileage-error p+p{color:#a35e2b}
</style>

