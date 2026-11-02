<script setup lang="ts">
import { computed,onMounted,ref,watch,nextTick } from "vue";
import type { PortalSession } from "@vectra/shared";
import { api } from "../api";
import { portalSession } from "../portal";
const emit=defineEmits<{ready:[value:PortalSession];signedOut:[]}>();
const username=ref(""),password=ref(""),busy=ref(false),checked=ref(false),message=ref("");
const readyToShow=ref(false);
const heading=computed(()=>portalSession.value?.role==="carrier"?(portalSession.value.settings?.carriers.find(company=>company.id===portalSession.value?.carrierId)?.name??"企业端"):"园区端");
const links=computed(()=>portalSession.value?.companyLinks?.filter(link=>/^https?:\/\//.test(link.url))??[]);
watch(()=>portalSession.value?.authenticated,(value,old)=>{if(!value)readyToShow.value=false;if(old&&!value)emit("signedOut");});
async function accept(value:PortalSession){readyToShow.value=false;portalSession.value=value;username.value=value.username;if(value.authenticated){await api("/api/session");emit("ready",value);await nextTick();readyToShow.value=true;}}
async function load(){busy.value=true;try{await accept(await api<PortalSession>("/api/portal"));}catch(cause){message.value=String(cause);}finally{busy.value=false;checked.value=true;}}
async function login(){if(busy.value)return;busy.value=true;message.value="";try{const value=await api<PortalSession>("/api/portal/login",{method:"POST",body:JSON.stringify({username:username.value,password:password.value})});password.value="";await accept(value);}catch(cause){message.value=cause instanceof Error?cause.message:String(cause);}finally{busy.value=false;}}
onMounted(load);
</script>
<template>
  <slot v-if="portalSession?.authenticated && readyToShow" :session="portalSession" />
  <main v-else class="portal-login">
    <section class="portal-login-card">
      <div class="portal-brand"><span>V</span><div><strong>VECTRA</strong><small>{{ portalSession?.role === 'carrier' ? '承运商 / 贸易公司统一入口' : '园区联合运营服务' }}</small></div></div>
      <h1>{{ heading }}</h1><p>{{ portalSession?.role === 'carrier' ? '使用企业账号登录，系统按账号识别所属公司，仅展示本方车辆、车次与经营台账。' : '登录园区账号，维护公共容量、发起联合分析并查看签名报告。' }}</p>
      <UiAlert v-if="message" type="error" role="alert">{{ message }}</UiAlert>
      <form v-if="checked && portalSession" @submit.prevent="login">
        <label>{{ portalSession.role === 'carrier' ? '企业账号' : '账号' }}<UiInput v-model="username" autocomplete="username" :disabled="busy" required maxlength="100" /></label>
        <label>密码<UiInput v-model="password" type="password" autocomplete="current-password" :disabled="busy" required maxlength="256" show-password /></label>
        <UiButton class="primary-button" :disabled="busy">{{ busy ? '正在登录…' : '登录' + (portalSession.role === 'carrier' ? '企业端' : '园区端') }}</UiButton>
      </form>
      <p v-else role="status">{{ busy ? '正在连接本端服务…' : '无法读取部署信息。' }}</p>
      <div v-if="links.length" class="portal-other"><span>其他独立入口</span><a v-for="link in links" :key="link.id" :href="link.url" target="_blank" rel="noopener">{{ link.name }} ↗</a></div>
      <p class="portal-login-help">首次登录请使用部署管理员提供的本端账号和密码。</p>
    </section>
  </main>
</template>
<style scoped>
.portal-login{min-height:100vh;display:grid;place-items:center;background:radial-gradient(at 15% 10%,#e4f1e8,transparent 50%),#f3f7f4;padding:40px}.portal-login-card{width:460px;max-width:100%;padding:38px;border:1px solid #dce8df;border-radius:18px;background:#fff;box-shadow:0 22px 70px #244c3610}.portal-brand{display:flex;gap:12px;align-items:center;margin-bottom:30px}.portal-brand>span{display:grid;place-items:center;width:42px;height:42px;background:#397e5a;color:#fff;border-radius:12px;font-size:23px}.portal-brand strong{display:block;letter-spacing:2px;color:#345c43}.portal-brand small{display:block;margin-top:4px;color:#8ca092;font-size:11px}.portal-login h1{font-size:25px;color:#345c43;margin:0 0 12px}.portal-login p{font-size:12px;line-height:1.9;color:#7d9485}.portal-login form{display:grid;gap:18px;margin-top:25px}.portal-login label{display:grid;gap:8px;font-size:12px;color:#67836f}.portal-other{display:flex;flex-wrap:wrap;gap:10px;margin-top:25px;border-top:1px solid #e8efe9;padding-top:18px;font-size:11px}.portal-other>span{width:100%;color:#94a59a}.portal-other a{color:#548569}.portal-login .portal-login-help{font-size:10px;color:#a1afa5;margin-top:22px}
</style>

