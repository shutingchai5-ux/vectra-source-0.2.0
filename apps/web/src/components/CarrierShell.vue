<script setup lang="ts">
import { portalSession } from "../portal";
import { useRoute } from "vue-router";
const route=useRoute();
</script>
<template>
  <aside class="sidebar company-sidebar" aria-label="企业端导航">
    <RouterLink to="/carriers" class="brand"><span class="brand-symbol">V</span><span>VECTRA</span></RouterLink>
    <div class="company-identity"><small>企业端 · 承运商 / 贸易公司</small><strong>{{ portalSession?.settings?.carriers.find(company => company.id === portalSession?.carrierId)?.name }}</strong><span>当前账号所属企业 · 仅本方资料</span></div>
    <nav class="company-pages">
      <RouterLink to="/carriers"><span>01</span>车辆与车次</RouterLink>
      <RouterLink to="/business"><span>02</span>私有经营台账</RouterLink>
    </nav>
    <div class="company-boundary"><strong>本方资料在这里维护</strong><p>需求与到达弹性、装载与空驶、回程运力、充电请求由本企业保存。园区接收批准的联合统计结果。</p></div>
    <div class="company-footer">
      <div v-if="portalSession?.companyLinks?.some(item => item.url)" class="company-footer-links"><a v-for="link in portalSession.companyLinks.filter(item => item.url)" :key="link.id" :href="link.url" target="_blank" rel="noopener">{{ link.name }} ↗</a></div>
      <div class="sidebar-session">
        <span class="sidebar-session-label">企业端</span>
        <RouterLink class="sidebar-sign-out" to="/sign-out">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M10 12h11m-4-4 4 4-4 4" /></svg>
          <span>退出登录</span>
        </RouterLink>
      </div>
    </div>
  </aside>
  <div class="app-shell"><main><RouterView v-if="['/carriers','/business','/sign-out'].includes(route.path)" /><p v-else role="status">正在打开本公司工作台…</p></main></div>
</template>
<style scoped>
.company-identity{display:grid;gap:9px;margin:25px 0 28px;padding:18px 12px;border-top:1px solid #e1e9e3;border-bottom:1px solid #e1e9e3}.company-identity small{font-size:10px;color:#8c9e91}.company-identity strong{font-size:16px;color:#456b50}.company-identity span{font-size:10px;color:#8ba190}.company-pages{display:grid;gap:8px}.company-pages a{display:flex;gap:13px;padding:13px;border-radius:8px;color:#718d7a;text-decoration:none;font-size:13px}.company-pages a.router-link-active{background:#eaf4ed;color:#367a51}.company-pages span{font-size:10px;color:#a3b3a7}.company-boundary{margin-top:30px;padding:15px;background:#f1f6f2;border-radius:9px;font-size:11px;line-height:1.9;color:#88a18d}.company-boundary strong{font-weight:550;color:#63856b}.company-boundary p{margin:7px 0 0}
.company-footer{margin-top:auto;border-top:1px solid #dfe7e1;padding-top:12px;font-size:11px}.company-footer-links{display:flex;flex-wrap:wrap;gap:8px 16px;padding:0 8px 12px}.company-footer-links a{color:#60796a}.company-footer-links a:hover{color:#267759}.company-footer .sidebar-session{padding-bottom:2px}
</style>

