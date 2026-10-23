<script setup lang="ts">
import type { Actor } from "../conversation";
defineProps<{ actor: Actor; compact?: boolean }>();
</script>
<template>
  <span class="actor-avatar" :class="[`avatar-${actor.tone}`, { compact }]" role="img" :aria-label="`${actor.name} · ${actor.role}`">
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <g v-if="actor.icon === 'car'"><path d="m6 15 3-7h14l3 7M5 15h22v9H5zM8 24v3m16-3v3M9 19h3m8 0h3"/><path d="M12 8v7m8-7v7"/></g>
      <g v-else-if="actor.icon === 'compass'"><circle cx="16" cy="16" r="11"/><path d="m21 11-3 7-7 3 3-7zM16 2v3m0 22v3M2 16h3m22 0h3"/></g>
      <g v-else-if="actor.icon === 'search'"><circle cx="14" cy="14" r="9"/><path d="m21 21 7 7M10 14l3 3 5-6"/></g>
      <g v-else-if="actor.icon === 'tower'"><path d="m16 9-5 18m5-18 5 18M10 27h12m-9-7h6M12 5a7 7 0 0 0 0 10m8-10a7 7 0 0 1 0 10M8 2a12 12 0 0 0 0 18m16-18a12 12 0 0 1 0 18"/></g>
      <g v-else-if="actor.icon === 'shield'"><path d="m16 3 11 5v9c0 6-11 12-11 12S5 23 5 17V8zM10 16l4 4 8-9"/></g>
      <g v-else-if="actor.icon === 'compute'"><rect x="7" y="7" width="18" height="18" rx="4"/><path d="M12 12h8m-8 5h3m3 0h2m-8 4h3m3 0h2M12 3v4m8-4v4M12 25v4m8-4v4M3 12h4m-4 8h4m18-8h4m-4 8h4"/></g>
      <g v-else-if="actor.icon === 'report'"><path d="M8 3h12l6 6v20H8zM20 3v7h6M12 15h10m-10 5h6m1 4 3 2 6-7"/></g>
      <g v-else><rect x="5" y="9" width="22" height="17" rx="6"/><path d="M16 9V4m-2 0h4M10 16h1m10 0h1m-11 5h10M2 14v7m28-7v7"/></g>
    </svg>
    <span v-if="actor.badge && !compact" class="actor-avatar-badge">{{ actor.badge }}</span>
  </span>
</template>
