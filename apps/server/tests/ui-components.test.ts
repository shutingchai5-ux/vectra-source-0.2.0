import { expect, test } from "bun:test";
import { createSSRApp, Fragment, h, reactive } from "vue";
import { renderToString } from "vue/server-renderer";
import { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from "element-plus";
import { UiButton, UiFieldset, UiInput, UiSelect } from "../../web/src/components/ui";
import { mountPageSetup } from "./ui-setup";

test("library inputs preserve numeric zero and native input-event consumers", async () => {
  const events: any[] = [], attrs = reactive({ type: "number", disabled: false });
  const component = { setup(props: any) { return { render: (UiInput.setup as any)(props, { attrs, slots: {}, emit: (...args: any[]) => events.push(args) }) }; } };
  const view = await mountPageSetup(component, reactive({ modelValue: "", modelModifiers: { number: true } }));
  try {
    const node = view.state.render();
    node.props["onUpdate:modelValue"]("0"); node.props.onInput("0");
    expect(events[0]).toEqual(["update:modelValue", 0]);
    expect(events[1][0]).toBe("input"); expect(events[1][1]).toBeInstanceOf(Event); expect(events[1][1].target.value).toBe("0");
    node.props["onUpdate:modelValue"](""); expect(events.at(-1)).toEqual(["update:modelValue", ""]);
    attrs.disabled = true; expect(view.state.render().props.disabled).toBeTrue();
  } finally { view.stop(); }
});

test("library selects preserve empty-all filters, dynamic option labels and existing change handlers", async () => {
  const events: any[] = [], props = reactive({ modelValue: "", value: undefined });
  const component = { setup() { return { render: (UiSelect.setup as any)(props, { attrs: {}, slots: { default: () => [h("option", { value: "" }, "全部入口"), h(Fragment, null, ["东入口", "西入口"].map(road => h("option", { value: road }, road)))] }, emit: (...args: any[]) => events.push(args) }) }; } };
  const view = await mountPageSetup(component, props);
  try {
    const node = view.state.render(), options = node.children.default();
    expect(node.props.modelValue).toBe(""); expect(node.props.emptyValues).not.toContain("");
    expect(options.map((option: any) => [option.props.value, option.props.label])).toEqual([["", "全部入口"], ["东入口", "东入口"], ["西入口", "西入口"]]);
    node.props["onUpdate:modelValue"]("西入口"); node.props.onChange("西入口");
    expect(events[0]).toEqual(["update:modelValue", "西入口"]); expect(events[1][1].target.value).toBe("西入口");
  } finally { view.stop(); }
});

test("disabled form groups disable library controls and retain native submit behavior", async () => {
  const app = createSSRApp({ render: () => h(UiFieldset, { disabled: true }, { default: () => [
    h(UiInput, { modelValue: "基础信息", type: "text" }),
    h(UiSelect, { modelValue: "东入口" }, { default: () => [h("option", { value: "东入口" }, "东入口")] }),
    h(UiButton, null, { default: () => "保存" }),
  ] }) });
  app.provide(ID_INJECTION_KEY, { prefix: 1, current: 0 });
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 });
  const html = await renderToString(app);
  expect(html).toMatch(/<fieldset[^>]*disabled/); expect(html).toMatch(/<input[^>]*disabled/);
  expect(html).toMatch(/<button[^>]*disabled/); expect(html).toMatch(/<button[^>]*type="submit"/);
  expect(html).toContain("el-select"); expect(html).toContain("is-disabled");
});
