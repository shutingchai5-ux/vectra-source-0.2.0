<script setup lang="ts">
import { computed } from "vue";
import { fieldLabel, readableValue, record } from "../conversation";
import MarkdownContent from "./MarkdownContent.vue";
import { formatProtocolMathematics, hasMathematics } from "../message-details";
const props = withDefaults(defineProps<{ value: unknown; field?: string }>(), { field: "" });
const object = computed(() => record(props.value));
const entries = computed(() => Object.entries(object.value ?? {}));
const array = computed(() => Array.isArray(props.value) ? props.value : undefined);
const decoded = computed(() => {
  if (typeof props.value !== "string" || !["arguments", "content"].includes(props.field)) return;
  try { const parsed = JSON.parse(props.value.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1")); if (parsed && typeof parsed === "object") return parsed; } catch { /* Text messages retain their original text. */ }
});
const tableKeys = computed(() => {
  const rows = array.value;
  if (!rows?.length || !rows.every(item => record(item))) return [];
  const keys = [...new Set(rows.flatMap(item => Object.keys(record(item)!)))];
  return keys.length <= 6 && !keys.some(key => ["content", "arguments", "description", "signature", "ciphertext"].includes(key)) && rows.every(item => Object.values(record(item)!).every(value => value === null || typeof value !== "object")) ? keys : [];
});
</script>
<template>
  <ReadableData v-if="decoded" :value="decoded" :field="field" />
  <div v-else-if="object" class="readable-object">
    <p v-if="!entries.length" class="readable-empty">无额外字段</p>
    <dl v-else class="readable-fields"><div v-for="([key, child]) in entries" :key="key" class="readable-field"><dt :title="key">{{ fieldLabel(key) }}</dt><dd><ReadableData :value="child" :field="key" /></dd></div></dl>
  </div>
  <div v-else-if="array" class="readable-array">
    <p v-if="!array.length" class="readable-empty">无</p>
    <div v-else-if="tableKeys.length" class="readable-table-container"><table class="readable-table"><thead><tr><th v-for="key in tableKeys" :key="key" :title="key">{{ fieldLabel(key) }}</th></tr></thead><tbody><tr v-for="(row, i) in array" :key="i"><td v-for="key in tableKeys" :key="key"><MarkdownContent v-if="typeof record(row)?.[key] === 'string' && hasMathematics(formatProtocolMathematics(String(record(row)?.[key])))" :content="formatProtocolMathematics(String(record(row)?.[key]))" explain-protocols /><template v-else>{{ readableValue(record(row)?.[key], key) }}</template></td></tr></tbody></table></div>
    <ol v-else class="readable-list"><li v-for="(item, i) in array" :key="i"><ReadableData :value="item" :field="field" /></li></ol>
  </div>
  <MarkdownContent v-else-if="typeof value === 'string' && (['content', 'summary', 'facts', 'possibleCauses', 'recommendations', 'uncertainties', 'note', 'reason', 'description', 'objective', 'operations'].includes(field) || hasMathematics(formatProtocolMathematics(value)))" :content="formatProtocolMathematics(value)" explain-protocols />
  <pre v-else-if="typeof value === 'string' && (value.includes('-----BEGIN ') || value.includes('\n'))" class="readable-text">{{ value }}</pre>
  <span v-else class="readable-scalar" :class="{ 'is-number': typeof value === 'number' || typeof value === 'string' && /^\d{15,}$/.test(value) }">{{ readableValue(value, field) }}</span>
</template>
