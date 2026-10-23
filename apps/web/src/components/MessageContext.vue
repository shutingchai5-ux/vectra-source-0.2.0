<script setup lang="ts">
import { CONVERSATION_PHASES, type ConversationPhase } from "@vectra/shared";
import type { SecurityProtocol } from "../message-details";
withDefaults(defineProps<{ phase: ConversationPhase; protocols?: SecurityProtocol[]; showPhase?: boolean }>(), { showPhase: true });
</script>
<template>
  <div class="message-context">
    <span v-if="showPhase" class="phase-badge" :data-phase="phase" :title="CONVERSATION_PHASES[phase - 1].description">阶段 {{ phase }}/8 · {{ CONVERSATION_PHASES[phase - 1].title }}</span>
    <div v-if="protocols?.length" class="message-protection"><p>本步涉及的安全机制与用途</p><ul class="message-security" aria-label="本条消息涉及的信息安全协议与机制"><li v-for="protocol in protocols" :key="protocol.id"><strong>{{ protocol.name }}</strong><span>{{ protocol.purpose }}</span></li></ul></div>
  </div>
</template>
