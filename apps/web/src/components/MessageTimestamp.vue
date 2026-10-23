<script setup lang="ts">
import { computed } from "vue";
import { messageTime } from "../message-time";
const props = withDefaults(defineProps<{ value?: number; startedAt?: number; label?: string }>(), { label: "记录于" });
const timestamp = computed(() => messageTime(props.value));
const start = computed(() => props.startedAt !== props.value ? messageTime(props.startedAt) : undefined);
</script>
<template>
  <span class="message-timestamp">
    <span v-if="start" class="timestamp-start">开始于 <time :datetime="start.iso" :title="`${start.full}（Asia/Shanghai）`">{{ start.text }}</time></span>
    <span v-if="timestamp">{{ label }} <time :datetime="timestamp.iso" :title="`${timestamp.full}（Asia/Shanghai）`">{{ timestamp.text }}</time><small>上海时间</small></span>
    <span v-else class="timestamp-missing">此项时间未记录</span>
  </span>
</template>
