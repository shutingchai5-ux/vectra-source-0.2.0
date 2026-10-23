<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../markdown";
const props = defineProps<{ content: string; explainProtocols?: boolean }>();
const rendered = computed(() => renderMarkdown(props.content, props.explainProtocols));
</script>
<template><div class="markdown-body" v-html="rendered"></div></template>
