<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useRoute } from "vue-router";
import { useWorkspace } from "./stores/workspace";
import AppSidebar from "./components/AppSidebar.vue";
const workspace = useWorkspace(), route = useRoute();
onMounted(workspace.init); onUnmounted(workspace.close);
</script>
<template>
  <AppSidebar />
  <div class="app-shell">
    <div v-if="workspace.errorMessage" class="error-banner" role="alert">{{ workspace.errorMessage }}<button @click="workspace.errorMessage = ''" aria-label="关闭提示">×</button></div>
    <main :class="{ 'workspace-main': route.path === '/' }"><RouterView v-if="workspace.overview" /><div v-else class="app-loading" role="status"><span class="assistant-avatar">V</span><p>正在连接协作服务…</p></div></main>
  </div>
</template>
