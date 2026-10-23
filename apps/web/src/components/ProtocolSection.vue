<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ProtocolSection } from "@vectra/shared";
import { pretty } from "../api";
import ReadableData from "./ReadableData.vue";
import MarkdownContent from "./MarkdownContent.vue";
import { sectionPresentation } from "../conversation";
const props = defineProps<{ section: ProtocolSection }>();
const copied = ref(false);
const raw = ref(false);
const presentation = computed(() => sectionPresentation(props.section.title));
watch(() => props.section.data, () => { copied.value = false; });
const text = () => typeof props.section.data === "string" ? props.section.data : pretty(props.section.data);
async function copy() {
  try { await navigator.clipboard.writeText(text()); copied.value = true; }
  catch { copied.value = false; }
}
</script>
<template>
  <section class="protocol-section">
    <div class="protocol-section-heading"><h4>{{ presentation.title }}</h4><div class="protocol-section-actions"><button v-if="typeof section.data === 'object' && section.data !== null" @click="raw = !raw" :aria-pressed="raw">{{ raw ? '返回易读说明' : '查看原始 JSON' }}</button><button @click="copy">{{ copied ? '已复制原文' : '复制原文' }}</button></div></div>
    <MarkdownContent class="protocol-section-description" :content="presentation.description" explain-protocols />
    <pre v-if="raw">{{ text() }}</pre>
    <ReadableData v-else :value="section.data" />
  </section>
</template>
