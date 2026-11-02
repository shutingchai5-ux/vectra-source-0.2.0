import { Comment, Fragment, defineComponent, h, inject, normalizeClass, provide, computed, type App, type ComputedRef, type InjectionKey, type PropType, type VNode } from "vue";
import { ElAlert, ElButton, ElInput, ElOption, ElSelect, ElTag } from "element-plus";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/input/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/alert/style/css";
import "element-plus/es/components/tag/style/css";

const fieldDisabled: InjectionKey<ComputedRef<boolean>> = Symbol("field-disabled");
const enabled = (value: unknown) => value === true || value === "" || value === "disabled";
function inputEvent(kind: string, value: unknown) {
  const event = new Event(kind, { bubbles: true });
  Object.defineProperty(event, "target", { value: { value: String(value ?? "") } });
  return event;
}
function buttonStyle(classes: string) {
  if (/danger-button/.test(classes)) return { type: "danger" as const };
  if (/remove|delete/.test(classes)) return { type: "danger" as const, text: true };
  if (/primary|new-conversation|send-button/.test(classes)) return { type: "primary" as const };
  if (/quiet|text-button|reading|icon-button/.test(classes)) return { type: "primary" as const, text: true };
  return {};
}
export const UiButton = defineComponent({
  name: "UiButton", inheritAttrs: false,
  // Preserve native button submission semantics, including existing form submit handlers.
  props: { type: { type: String as PropType<"button" | "submit" | "reset">, default: "submit" } },
  setup(props, { attrs, slots }) {
    const parentDisabled = inject(fieldDisabled, undefined);
    return () => h(ElButton, { ...buttonStyle(normalizeClass(attrs.class)), ...attrs, nativeType: props.type,
      disabled: enabled(attrs.disabled) || parentDisabled?.value, class: ["ui-button", attrs.class] }, slots);
  },
});
export const UiFieldset = defineComponent({
  name: "UiFieldset", inheritAttrs: false,
  props: { disabled: Boolean },
  setup(props, { attrs, slots }) {
    const parent = inject(fieldDisabled, undefined), disabled = computed(() => props.disabled || !!parent?.value);
    provide(fieldDisabled, disabled);
    return () => h("fieldset", { ...attrs, disabled: disabled.value }, slots.default?.());
  },
});
export const UiInput = defineComponent({
  name: "UiInput", inheritAttrs: false,
  props: { modelValue: { type: [String, Number], default: undefined }, value: { type: [String, Number], default: undefined },
    modelModifiers: { type: Object as PropType<{ number?: boolean; trim?: boolean }>, default: () => ({}) } },
  emits: { "update:modelValue": (_value: any) => true, input: (_event: Event) => true, change: (_event: Event) => true },
  setup(props, { attrs, slots, emit }) {
    const parentDisabled = inject(fieldDisabled, undefined);
    const update = (value: string) => {
      let result: string | number = props.modelModifiers.trim ? value.trim() : value;
      if (props.modelModifiers.number && !Number.isNaN(parseFloat(String(result)))) result = parseFloat(String(result));
      emit("update:modelValue", result);
    };
    return () => h(ElInput, { ...attrs, modelValue: props.modelValue ?? props.value ?? "", class: ["ui-input", attrs.class],
      rows: attrs.rows === undefined ? undefined : Number(attrs.rows),
      disabled: enabled(attrs.disabled) || parentDisabled?.value, "onUpdate:modelValue": update,
      onInput: (value: string) => emit("input", inputEvent("input", value)),
      onChange: (value: string) => emit("change", inputEvent("change", value)) }, slots);
  },
});
function textOf(value: unknown): string {
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  const node = value as VNode;
  return node.type === Comment ? "" : textOf(node.children);
}
function optionsOf(nodes: VNode[]): VNode[] {
  return nodes.flatMap(node => node.type === Fragment ? optionsOf(node.children as VNode[])
    : node.type === "option" ? [node] : []);
}
export const UiSelect = defineComponent({
  name: "UiSelect", inheritAttrs: false,
  props: { modelValue: { type: [String, Number, Boolean, Array] as PropType<any>, default: undefined }, value: { type: [String, Number, Boolean, Array] as PropType<any>, default: undefined } },
  emits: { "update:modelValue": (_value: any) => true, change: (_event: Event) => true },
  setup(props, { attrs, slots, emit }) {
    const parentDisabled = inject(fieldDisabled, undefined);
    return () => h(ElSelect, { ...attrs, modelValue: props.modelValue ?? props.value, class: ["ui-select", attrs.class],
      disabled: enabled(attrs.disabled) || parentDisabled?.value, emptyValues: [null, undefined],
      "onUpdate:modelValue": (value: any) => emit("update:modelValue", value),
      onChange: (value: any) => emit("change", inputEvent("change", value)) },
    { default: () => optionsOf(slots.default?.() ?? []).map((node, index) => {
      const label = textOf(node.children).trim(), value = node.props && "value" in node.props ? node.props.value : label;
      return h(ElOption, { key: index, label, value, disabled: enabled(node.props?.disabled) });
    }) });
  },
});
export const UiTable = defineComponent({
  name: "UiTable", inheritAttrs: false,
  setup(_props, { attrs, slots }) { return () => h("table", { ...attrs, class: ["ui-table", attrs.class] }, slots.default?.()); },
});
export const UiTag = defineComponent({
  name: "UiTag", inheritAttrs: false,
  setup(_props, { attrs, slots }) {
    return () => {
      const classes = normalizeClass(attrs.class);
      const type = /failed|error|invalid/.test(classes) ? "danger" : /queued|paused|expired|work_completed/.test(classes) ? "warning" : /completed|in_park|working|active/.test(classes) ? "success" : "info";
      return h(ElTag, { type, effect: "light", ...attrs, class: ["ui-tag", attrs.class] }, slots);
    };
  },
});
export const UiAlert = defineComponent({
  name: "UiAlert", inheritAttrs: false,
  props: { type: String as PropType<"success" | "info" | "warning" | "error">, closable: Boolean },
  setup(props, { attrs, slots }) {
    return () => h(ElAlert, { ...attrs, type: props.type ?? (/error|failed|invalid/.test(normalizeClass(attrs.class)) ? "error" : "info"),
      showIcon: true, closable: props.closable, class: ["ui-alert", attrs.class] }, { title: slots.default });
  },
});
export const uiComponents = { UiButton, UiInput, UiSelect, UiFieldset, UiTable, UiTag, UiAlert };
export function installUi(app: App) { for (const [name, component] of Object.entries(uiComponents)) app.component(name, component); }
