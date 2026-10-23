import { test, expect } from "bun:test";
import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, compileScript } from "vue/compiler-sfc";
import { effectScope, reactive } from "vue";

// Run the actual SFC event handlers without starting a browser or adding a DOM dependency.
plugin({ name: "vehicle-editor-regression", setup(builder) {
  builder.onLoad({ filter: /VehicleDataEditor\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8")).descriptor, { id: "vehicle-editor-regression" }).content, loader: "ts", resolveDir: dirname(path) }));
} });

test("vehicle editor adds and saves numeric input values, preserves zero and rejects cleared required input", async () => {
  const componentPath = fileURLToPath(new URL("../../web/src/components/VehicleDataEditor.vue", import.meta.url));
  const { default: component } = await import(componentPath);
  const props = reactive({ version: "initial-version" }), scope = effectScope(), originalFetch = globalThis.fetch;
  const sent: any[] = [], emitted: string[] = [];
  globalThis.fetch = Object.assign(async (path: Parameters<typeof fetch>[0], options?: RequestInit) => {
    expect(String(path)).toBe("/api/telemetry"); expect(options?.method).toBe("POST");
    const data = JSON.parse(String(options?.body)); sent.push(data);
    return Response.json({ version: `saved-${sent.length}`, source: "import", updatedAt: Date.now(), vehicleCount: new Set(data.records.map((r: any) => r.vehicleId)).size, sampleCount: data.records.length, nodes: [], roads: [] });
  }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  try {
    const state: any = scope.run(() => component.setup(props, { expose() {}, emit(name: string, catalog: { version: string }) { emitted.push(name); if (name === "saved") props.version = catalog.version; } }));
    state.batchCount.value = 2; state.batchRoad.value = "S101"; state.batchSpeed.value = 35;
    expect(() => state.addVehicles()).not.toThrow(); expect(state.rows.value).toHaveLength(2);
    expect(state.message.value).toContain("已新增 2 辆车");
    state.rows.value[0].speed = 0; state.rows.value[0].distanceKm = 0; state.rows.value[0].energyKwh = 0;
    state.rows.value[1].distanceKm = 1.2; state.rows.value[1].energyKwh = 0.4;
    await state.save();
    expect(state.failed.value).toBeFalse(); expect(sent).toHaveLength(1); expect(emitted).toEqual(["saved"]);
    expect(sent[0].records[0]).toMatchObject({ speed: 0, distanceKm: 0, energyKwh: 0 });
    expect(sent[0].records[1]).toMatchObject({ speed: 35, distanceKm: 1.2, energyKwh: 0.4 });
    state.rows.value[0].speed = "";
    await state.save(); expect(sent).toHaveLength(1); expect(state.failed.value).toBeTrue(); expect(state.message.value).toContain("速度均须填写");
    state.batchSpeed.value = -1;
    state.addVehicles(); expect(state.rows.value).toHaveLength(2); expect(state.message.value).toContain("0—250");
    state.batchCount.value = 1; state.batchSpeed.value = "";
    state.addVehicles(); expect(state.rows.value).toHaveLength(3); expect(state.rows.value[2].speed).toBe("");
    expect(state.failed.value).toBeFalse();
  } finally { globalThis.fetch = originalFetch; scope.stop(); }
});
