<script setup lang="ts">
import { computed,ref } from "vue";
import { BUSINESS_DOMAINS,type BusinessDomain } from "@vectra/shared";
import BusinessLedgerEditor from "../components/BusinessLedgerEditor.vue";
import { portalSession } from "../portal";
import { useUnsavedChanges } from "../use-unsaved-changes";
const active=ref<BusinessDomain>("demand"),dirty=ref<Partial<Record<BusinessDomain,boolean>>>({}),busy=ref<Partial<Record<BusinessDomain,boolean>>>({});
const owner=computed(()=>portalSession.value?.carrierId),blocked=computed(()=>Object.values(busy.value).some(Boolean));
useUnsavedChanges(()=>Object.values(dirty.value).some(Boolean),"本方经营台账");
</script>
<template>
  <section class="business-workspace"><div class="business-heading"><span>企业私有经营资料</span><h1>经营信息台账</h1><p>每类资料独立保存版本和完整范围，仅本公司账号可查看与维护。园区通过批准任务获取联合统计，原始记录保留在本企业服务。</p></div>
    <nav class="business-tabs" aria-label="经营台账类型"><UiButton v-for="(label,key) in BUSINESS_DOMAINS" :key="key" type="button" :class="{ active: active === key }" :disabled="blocked" @click="active = key">{{ label }}<small v-if="dirty[key]"> · 待保存</small></UiButton></nav>
    <KeepAlive><BusinessLedgerEditor v-if="owner" :key="active" :domain="active" :carrier-id="owner" @dirty="(value,domain) => dirty[domain] = value" @busy="(value,domain) => busy[domain] = value" /></KeepAlive>
  </section>
</template>
<style scoped>
.business-workspace{max-width:1400px;margin:auto;padding:10px 0 35px}.business-heading>span{font-size:10px;letter-spacing:2px;color:#83a18b}.business-heading h1{font-size:28px;font-weight:600;color:#3f694c;margin:10px 0 14px}.business-heading p{font-size:12px;color:#8b9e90;line-height:1.9;max-width:950px}.business-tabs{display:flex;gap:12px;border-bottom:1px solid #dfe8e2;margin-top:27px}.business-tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;padding:15px 20px;background:transparent;color:#91a396;font-size:12px}.business-tabs button.active{border-bottom-color:#43895f;color:#43845a;background:#f0f7f1}.business-tabs small{font-size:9px;color:#ae925d}
</style>

