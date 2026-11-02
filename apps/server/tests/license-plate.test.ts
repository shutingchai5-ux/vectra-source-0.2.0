import { test, expect } from "bun:test";
import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, compileScript } from "vue/compiler-sfc";
import { nextTick, reactive } from "vue";
import { isPlateNumber, normalizePlateNumber, plateNumberError } from "@vectra/shared";
import { validateParkVisits } from "../src/park";
import { importedVisitDrafts, visitDraft, visitPayload } from "../../web/src/visit-drafts";
import { mountPageSetup } from "./ui-setup";

plugin({ name: "plate-input-handlers", setup(builder) {
  builder.onLoad({ filter: /LicensePlateInput\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8")).descriptor, { id: "plate-input-handlers" }).content, loader: "ts", resolveDir: dirname(path) }));
} });

test("plates validate ordinary, new-energy and trailer arrangements and share the same canonical identity", () => {
  for (const plate of ["沪A12345", "粤B12C34", "苏A1BC23", "京AD12345", "沪AA12345", "粤BDF1234", "粤BP12345", "沪A12345D", "浙A1234挂"]) expect(isPlateNumber(plate), plate).toBeTrue();
  for (const plate of ["", "truck-001", "台A12345", "沪I12345", "沪O12345", "沪A12I45", "沪A12O45", "沪A1234", "沪A123456", "沪A1234567", "沪AABC12", "沪AD12A45", "沪A12-345", "沪A12345警"]) expect(plateNumberError(plate), plate).toBeDefined();
  expect(normalizePlateNumber(" 沪ａ·１２３４５ ")).toBe("沪A12345");
  const visit = { visitId: "visit-a", carrierId: "carrier-a", vehicleId: "沪ａ·１２３４５", road: "东入口", arrivedAt: "2026-10-23T08:00:00+08:00" };
  expect(validateParkVisits([visit])[0].vehicleId).toBe("沪A12345");
  expect(importedVisitDrafts([visit])[0].vehicleId).toBe("沪A12345");
  expect(visitPayload(importedVisitDrafts([visit]))[0].vehicleId).toBe("沪A12345");
  expect(() => validateParkVisits([visit, { ...visit, visitId: "visit-b", vehicleId: "沪A12345" }])).toThrow(/重复/);
  expect(() => importedVisitDrafts([{ ...visit, vehicleId: "truck-001" }])).toThrow(/车牌/);
  const legacy = visitDraft({ ...visit, vehicleId: "old-truck", carrierId: "carrier-a", arrivedAt: Date.parse(visit.arrivedAt) });
  expect(legacy.vehicleId).toBe(""); expect(legacy.sourceVehicleId).toBe("old-truck"); expect(() => visitPayload([legacy])).toThrow(/车牌/);
});

test("plate input keeps partial selections, normalises typing and pasting, and follows external record changes", async () => {
  const { default: component } = await import(fileURLToPath(new URL("../../web/src/components/LicensePlateInput.vue", import.meta.url)));
  const props = reactive({ modelValue: "", disabled: false, readonly: false });
  const view = await mountPageSetup(component, props, (_event, value) => { props.modelValue = value; });
  try {
    const state = view.state;
    state.update("letter", "a"); await nextTick(); expect(state.parts.value.letter).toBe("A");
    state.update("province", "沪"); await nextTick(); state.inputSerial({ target: { value: "１２３４５" } }); await nextTick();
    expect(props.modelValue).toBe("沪A12345"); expect(state.problem.value).toBeUndefined();
    state.inputSerial({ target: { value: " 粤ｂ·ｄ１２３４５ " } }); await nextTick();
    expect(props.modelValue).toBe("粤BD12345"); expect(state.parts.value).toEqual({ province: "粤", letter: "B", serial: "D12345" });
    props.modelValue = "浙A1234挂"; await nextTick(); expect(state.parts.value.serial).toBe("1234挂");
    props.readonly = true; state.inputSerial({ target: { value: "99999" } }); state.update("province", "苏"); expect(props.modelValue).toBe("浙A1234挂");
  } finally { view.stop(); }
});
