<script setup lang="ts">
import { onMounted } from "vue";
import { api } from "../api";
onMounted(async()=>{try{await api("/api/portal/logout",{method:"POST",body:"{}"});}finally{window.location.replace("/");}});
</script>
<template><p class="muted" role="status">正在退出本端账号…</p></template>

