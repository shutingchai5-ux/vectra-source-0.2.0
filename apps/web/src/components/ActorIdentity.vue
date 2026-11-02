<script setup lang="ts">
import { ACTOR_LEVELS, type Actor } from "../conversation";
import ActorAvatar from "./ActorAvatar.vue";
defineProps<{ actor: Actor; caption?: string }>();
</script>
<template>
  <aside v-if="actor.registered" class="message-actor" :data-agent-level="actor.level"><ActorAvatar :actor="actor" /><RouterLink v-if="actor.usesLlm" :to="'/agents/' + actor.id" class="agent-detail-link">{{ actor.name }}</RouterLink><strong v-else>{{ actor.name }}</strong><span class="agent-level">{{ ACTOR_LEVELS[actor.level - 1].title }}</span><span class="agent-duty">{{ caption || actor.role }}</span><small class="identity-code" :title="'登记编号：' + actor.code">{{ actor.code }}</small></aside><aside v-else class="message-actor identity-pending"><span>来源待核对</span></aside>
</template>
<style scoped>
.agent-level{display:inline-flex;align-items:center;padding:3px 7px;border-radius:6px;font-size:10px;line-height:1.5;background:#eff3f1;color:#607568;white-space:nowrap}.message-actor[data-agent-level="1"] .agent-level{background:#e4f4ee;color:#237359}.message-actor[data-agent-level="2"] .agent-level{background:#edf0fa;color:#5c6593}.message-actor[data-agent-level="3"] .agent-level{background:#edf0f3;color:#5c6a78}.agent-duty{max-width:100%;overflow-wrap:anywhere}
.identity-code{max-width:100%;font-size:11px;line-height:1.6;color:#697b70;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.identity-pending{font-size:12px;color:#68796f}
.agent-duty{font-size:12px;line-height:1.65;color:#607368}.message-actor>strong{max-width:100%;overflow-wrap:anywhere}
.agent-detail-link{font-weight:600;font-size:13px;line-height:1.6;color:#287359;text-decoration:none;overflow-wrap:anywhere}.agent-detail-link:hover{text-decoration:underline}
</style>
