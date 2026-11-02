<script setup lang="ts">
import { computed,ref,watch } from "vue";
import { useRouter } from "vue-router";
import { BUSINESS_DOMAINS,RETURN_REGIONS,PARK_ENTRANCES,shanghaiTimestamp,shanghaiDay,parseParkTimestamp,MAX_WINDOW_MS,businessMetrics,statisticsFrames,type BusinessDomain } from "@vectra/shared";
import RoadMultiSelect from "./RoadMultiSelect.vue";
import ChargeCapacityEditor from "./ChargeCapacityEditor.vue";
const router=useRouter(),domain=ref<BusinessDomain>("demand"),roads=ref<string[]>(["东入口"]),start=ref(""),end=ref(""),bucket=ref(120),selection=ref("planned"),region=ref(""),message=ref("");
const capacityDirty=ref(false),capacityBusy=ref(false),future=computed(()=>domain.value!=="haulage");
function defaults(){const slot=Math.ceil((Date.now()+1)/1800000)*1800000;start.value=future.value?shanghaiTimestamp(slot).slice(0,16):shanghaiDay(Date.now()-86400000)+"T00:00";end.value=future.value?shanghaiTimestamp(slot+6*3600000).slice(0,16):shanghaiDay(Date.now())+"T00:00";message.value="";}
watch(domain,defaults,{immediate:true});
async function ask(){
 const left=parseParkTimestamp(start.value),right=parseParkTimestamp(end.value);
 if(!roads.value.length||!Number.isSafeInteger(left)||!Number.isSafeInteger(right)||left<0||right<=left||right-left>MAX_WINDOW_MS||right>Date.now()+(future.value?MAX_WINDOW_MS:0)){message.value="请选择有效入口与上海时间范围，跨度最多31天；装载空驶事实不能在未来。";return;}
 const metrics=businessMetrics(domain.value),frames=statisticsFrames({dataset:"carrier_business",domain:domain.value,roads:roads.value,start:left,end:right,timeZone:"Asia/Shanghai",metrics,...(future.value?{bucketMinutes:Number(bucket.value)}:{})});
 if(frames.length>128||frames.length*(metrics.length*4+3)>2048){message.value="分组过细，请增大粒度、缩短范围或减少入口。";return;}
 const scope=roads.value.join("、")+"从"+start.value.replace("T"," ")+"至"+end.value.replace("T"," ");
 const detail=domain.value==="demand"?"运输需求与到达弹性，按"+(selection.value==="deadline"?"最晚允许到达":"计划到达")+"选取，比较未预约车次、可调整规模、提前与延后能力和需求作业量，说明资料覆盖。":
 domain.value==="haulage"?"已离园车次的实际装载与空驶，比较货量、载货与空驶里程及载重、容积、托盘三种加权利用率，给出联合空驶率与利用率低于50%的记录比例，不平均企业比例。":
 domain.value==="returns"?(region.value?"仅回程粗区域为"+RETURN_REGIONS[Number(region.value) as keyof typeof RETURN_REGIONS]+"的":"")+"回程运力，汇总可利用回程车次并说明资料范围；不进行逐订单匹配。":
 "充电需求，比较所需电量、各接口需求、短时限请求、车辆功率上限下仍无法完成的请求与园区充电容量，说明缺失信息，不把总量对比当作逐车排程。";
 await router.push({path:"/",query:{ask:"统计"+scope+detail+(future.value?" 按"+bucket.value+"分钟分组。":"")+" 只输出批准的联合结果，不展示单家公司原始明细。"}});
}
</script>
<template>
 <div class="business-operations">
 <section class="panel"><h2>经营信息联合分析</h2><p class="muted">原始需求、装载明细和单车电量由各企业独立保管，通过三方秘密共享计算批准的联合结果。</p>
 <div class="operations-fields"><label>分析内容<UiSelect v-model="domain"><option v-for="(label,key) in BUSINESS_DOMAINS" :key="key" :value="key">{{ label }}</option></UiSelect></label><label v-if="domain === 'demand'">选取需求的时间口径<UiSelect v-model="selection"><option value="planned">按计划到达</option><option value="deadline">按最晚允许到达</option></UiSelect></label><label v-if="domain === 'returns'">回程粗区域<UiSelect v-model="region"><option value="">全部粗区域</option><option v-for="(label,key) in RETURN_REGIONS" :key="key" :value="String(key)">{{ label }}</option></UiSelect></label></div>
 <RoadMultiSelect v-model="roads" :options="[...PARK_ENTRANCES]" label="分析入口" hint="可多选，各入口单独汇总。" />
 <div class="operations-fields"><label>范围开始（上海）<UiInput v-model="start" type="datetime-local" /></label><label>范围结束（上海）<UiInput v-model="end" type="datetime-local" /></label><label v-if="future">分组粒度<UiSelect v-model="bucket"><option v-for="size in [30,60,120,240,720,1440]" :key="size" :value="size">{{ size }} 分钟</option></UiSelect></label></div>
 <UiAlert v-if="message" type="error">{{ message }}</UiAlert><div class="button-row"><UiButton type="button" class="primary-button" :disabled="domain === 'charging' && (capacityBusy || capacityDirty)" @click="ask">带入 AI 对话</UiButton><span class="muted">{{ domain === 'charging' && capacityDirty ? '请先保存或放弃充电容量草稿。' : '先准备问题，确认发送后才执行模型委派与联合计算。' }}</span></div>
 <p class="muted">{{ domain === 'demand' ? '同一需求可能既能提前又能延后，不能将二者相加当作更多可调整车次。当前只统计弹性规模，不自动修改预约。' : domain === 'haulage' ? '每个比例使用同批完整有效记录；缺少里程或容量时不补零。' : domain === 'returns' ? '回程车次为可承接额度，按申报开始时间选取；区域是粗分类，不公开精细路线。' : '紧迫请求按截止在查询起点后两小时内定义；未知车辆功率不会当作零功率。' }}</p>
 </section>
 <ChargeCapacityEditor v-show="domain === 'charging'" @dirty="value => capacityDirty = value" @busy="value => capacityBusy = value" />
 </div>
</template>
<style scoped>
.operations-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin:20px 0}.operations-fields label{display:grid;gap:8px;font-size:12px;color:#78917f}.business-operations>.panel{margin-bottom:20px}
</style>

