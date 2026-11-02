<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { PLATE_PROVINCES, PLATE_LETTERS, PLATE_FORMAT_HINT, normalizePlateNumber, plateNumberError, splitPlateNumber } from "@vectra/shared";
const props = defineProps<{ modelValue: string; disabled?: boolean; readonly?: boolean; label?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const id = useId(), touched = ref(false), parts = ref(splitPlateNumber(props.modelValue));
let lastEmitted: string | undefined;
watch(() => props.modelValue, value => { if (value !== lastEmitted) { parts.value = splitPlateNumber(value); touched.value = false; } });
const problem = computed(() => touched.value || props.modelValue ? plateNumberError(props.modelValue) : undefined);
const preview = computed(() => normalizePlateNumber(props.modelValue));
function update(part: "province" | "letter" | "serial", value: string) {
  if (props.disabled || props.readonly) return;
  touched.value = true;
  parts.value = { ...parts.value, [part]: normalizePlateNumber(value) };
  lastEmitted = parts.value.province + parts.value.letter + parts.value.serial;
  emit("update:modelValue", lastEmitted);
}
function inputSerial(event: Event) {
  if (props.disabled || props.readonly) return;
  const input = event.target as HTMLInputElement, value = normalizePlateNumber(input.value);
  // A complete pasted plate fills all three controls, including full-width and dotted input.
  if (PLATE_PROVINCES.some(province => value.startsWith(province))) { touched.value = true; parts.value = splitPlateNumber(value); lastEmitted = value; emit("update:modelValue", value); }
  else update("serial", value);
}
</script>
<template>
  <UiFieldset class="plate-field" :disabled="disabled || readonly" :aria-describedby="id + '-help'">
    <legend>{{ label || '车牌号（必填）' }}</legend>
    <div class="plate-controls">
      <UiSelect :value="parts.province" aria-label="车牌省份" :aria-invalid="!!problem" @change="update('province', ($event.target as HTMLSelectElement).value)"><option value="">省份</option><option v-for="province in PLATE_PROVINCES" :key="province" :value="province">{{ province }}</option></UiSelect>
      <UiSelect :value="parts.letter" aria-label="发牌机关字母" :aria-invalid="!!problem" @change="update('letter', ($event.target as HTMLSelectElement).value)"><option value="">字母</option><option v-for="letter in PLATE_LETTERS" :key="letter" :value="letter">{{ letter }}</option></UiSelect>
      <span aria-hidden="true">·</span><UiInput :value="parts.serial" aria-label="车牌剩余号码" :aria-invalid="!!problem" :aria-describedby="id + '-help'" placeholder="剩余5或6位" autocomplete="off" spellcheck="false" @input="inputSerial" @blur="touched = true" />
    </div>
    <p :id="id + '-help'" class="plate-help" :class="{ error: problem }" :role="problem ? 'status' : undefined">{{ problem || (readonly ? '已保存车牌用于关联车辆档案与车次。' : PLATE_FORMAT_HINT) }}</p>
    <p v-if="preview && !problem" class="plate-preview">完整车牌：<strong>{{ preview }}</strong></p>
  </UiFieldset>
</template>
<style scoped>
.plate-field{border:0;padding:0;margin:0;min-width:0;grid-column:1/-1}.plate-field legend{padding:0;margin-bottom:8px;font-size:12px;color:#536b5a}.plate-controls{display:flex;align-items:center;gap:9px;max-width:510px}.plate-controls select{width:86px;flex:0 0 86px}.plate-controls input{min-width:0;flex:1;text-transform:uppercase;letter-spacing:2px}.plate-controls>span{font-size:20px;color:#688a74}.plate-help,.plate-preview{margin:7px 0 0;font-size:11px;line-height:1.7;color:#7a9182}.plate-help.error{color:#a45b37}.plate-preview strong{font-size:14px;color:#32775b;letter-spacing:1px}.plate-field:disabled input,.plate-field:disabled select{background:#f1f5f2;color:#66806d;cursor:default}.plate-controls [aria-invalid=true]{border-color:#c89171}
</style>
