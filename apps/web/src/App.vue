<script setup lang="ts">
import { onUnmounted } from "vue";
import { useRoute,useRouter } from "vue-router";
import type { PortalSession } from "@vectra/shared";
import { useWorkspace } from "./stores/workspace";
import AppSidebar from "./components/AppSidebar.vue";
import PortalGate from "./components/PortalGate.vue";
import CarrierShell from "./components/CarrierShell.vue";
import { setParkSettings } from "./park-state";
import { currentCarrierRole } from "./carrier-role";
import { ElConfigProvider } from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
const workspace = useWorkspace(), route = useRoute(),router=useRouter();
function ready(session:PortalSession){
  document.title="VECTRA · "+(session.role==="carrier"?"企业端 · "+(session.settings?.carriers.find(item=>item.id===session.carrierId)?.name??"本公司"):"园区端");
  if(session.settings)setParkSettings(session.settings);
  if(session.role==="carrier"){
    currentCarrierRole.value=undefined;sessionStorage.removeItem("vectra.carrier-role");
    if(!["/carriers","/business"].includes(route.path))void router.replace("/carriers");
  }else{if(!session.legacy&&["/carriers","/business"].includes(route.path))void router.replace("/");void workspace.init();}
}
onUnmounted(workspace.close);
</script>
<template>
  <ElConfigProvider :locale="zhCn">
  <PortalGate @ready="ready" @signed-out="workspace.close"><template #default="{ session }">
  <CarrierShell v-if="session.role === 'carrier'" />
  <template v-else>
  <AppSidebar />
  <div class="app-shell">
    <UiAlert v-if="workspace.errorMessage" class="error-banner" type="error" closable @close="workspace.errorMessage = ''">{{ workspace.errorMessage }}</UiAlert>
    <main :class="{ 'workspace-main': route.path === '/' }"><RouterView v-if="workspace.overview" /><div v-else class="app-loading" role="status"><span class="assistant-avatar">V</span><p>正在连接协作服务…</p></div></main>
  </div>
  </template></template></PortalGate>
  </ElConfigProvider>
</template>
