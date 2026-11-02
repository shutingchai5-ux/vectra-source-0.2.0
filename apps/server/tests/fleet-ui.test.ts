import { test, expect } from "bun:test";
import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, compileScript } from "vue/compiler-sfc";
import { reactive, h, KeepAlive, nextTick } from "vue";
import { defaultParkSettings, type FleetOverview } from "@vectra/shared";
import { mountPageSetup } from "./ui-setup";
import { currentCarrierRole } from "../../web/src/carrier-role";
plugin({ name: "carrier-workspace-handlers", setup(builder) {
  builder.onLoad({ filter: /(?:CarrierWorkspace|CarrierVehicleEditor|ParkVisitEditor|RoadMultiSelect|LicensePlateInput)\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8")).descriptor, { id: "carrier-workspace-handlers" }).content, loader: "ts", resolveDir: dirname(path) }));
} });
const overview = (): FleetOverview => ({ version: "initial", updatedAt: 0, parkVersion: "park", parkUpdatedAt: 0, settings: defaultParkSettings(), roads: ["东入口", "南入口", "西入口", "北入口"], vehicles: [] });

test("road checkboxes support multiple selections and de-duplicate using the real handlers", async () => {
  const { default: component } = await import(fileURLToPath(new URL("../../web/src/components/RoadMultiSelect.vue", import.meta.url)));
  const props = reactive({ modelValue: ["东入口"], options: ["东入口", "西入口"], disabled: false });
  const view = await mountPageSetup(component, props, (_event, value) => { props.modelValue = value; });
  try { view.state.toggle("西入口", true); expect(props.modelValue).toEqual(["东入口", "西入口"]); view.state.toggle("西入口", true); expect(props.modelValue).toHaveLength(2); view.state.toggle("东入口", false); expect(props.modelValue).toEqual(["西入口"]); } finally { view.stop(); }
});

test("vehicle editor only saves vehicle profiles, validates plates and preserves zero without registering entry", async () => {
  const { default: component } = await import(fileURLToPath(new URL("../../web/src/components/CarrierVehicleEditor.vue", import.meta.url))), original = globalThis.fetch;
  currentCarrierRole.value = { carrierId: "carrier-a", token: "role-a", expiresAt: Date.now() + 3600000 };
  let server: FleetOverview = { ...overview(), vehicles: [
    { vehicleId: "沪A12345", plateNumber: "沪A12345", carrierId: "carrier-a", allowedRoads: ["东入口"], profiled: true, status: "no_visit" },
    { vehicleId: "沪B12345", plateNumber: "沪B12345", carrierId: "carrier-b", allowedRoads: ["西入口"], profiled: true, status: "no_visit" },
  ] };
  const sent: any[] = [], events: any[] = [];
  globalThis.fetch = Object.assign(async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(new Headers(init?.headers).get("X-Carrier-Role")).toBe("role-a");
    if (init?.method === "POST") { expect(String(path)).toBe("/api/fleet"); const body = JSON.parse(String(init.body)); sent.push(body); server = { ...server, version: "saved", vehicles: [...server.vehicles.filter(v => v.carrierId !== body.carrierId), ...body.vehicles.map((v: any) => ({ ...v, allowedRoads: server.vehicles.find(previous => previous.vehicleId === v.plateNumber)?.allowedRoads ?? [], vehicleId: v.plateNumber, profiled: true, status: "no_visit" }))] }; }
    return Response.json(server);
  }, { preconnect: original.preconnect }) as typeof fetch;
  const props = reactive({ carrierId: "carrier-a", fleet: server });
  const view = await mountPageSetup(component, props, (...args) => { events.push(args); if (args[0] === "saved") props.fleet = args[1]; });
  try {
    const state = view.state; expect(state.rows.value.map((row: any) => row.plateNumber)).toEqual(["沪A12345"]);
    expect(state.editable.value).toBeFalse(); state.edit(); expect(state.editable.value).toBeTrue();
    state.current.value.capacityTonnes = 12; state.change(); expect(state.dirty.value).toBeTrue();
    state.cancelEdit(); expect(state.editable.value).toBeFalse(); expect(state.current.value.capacityTonnes).toBe(""); expect(state.dirty.value).toBeFalse();
    expect(state.batchCount).toBeUndefined(); expect(state.batchRoads).toBeUndefined(); expect(state.load).toBeUndefined();
    state.add(); expect(state.rows.value).toHaveLength(2); expect(state.editable.value).toBeTrue();
    const draftKey = state.current.value.key; state.add(); expect(state.rows.value).toHaveLength(2); expect(state.current.value.key).toBe(draftKey); expect(state.message.value).toContain("先保存或取消");
    state.cancelEdit(); expect(state.rows.value).toHaveLength(1); expect(state.dirty.value).toBeFalse();
    state.add(); await state.save(); expect(sent).toHaveLength(0); expect(state.message.value).toContain("车牌");
    Object.assign(state.current.value, { plateNumber: "沪A34567", capacityTonnes: 0 });
    state.rows.value.push({ ...state.current.value, key: "duplicate", plateNumber: "沪ａ·３４５６７" }); await state.save(); expect(sent).toHaveLength(0); expect(state.message.value).toContain("重复"); state.rows.value.pop();
    await state.save(); expect(sent).toHaveLength(1); expect(sent[0].vehicles.every((v: any) => v.carrierId === "carrier-a")).toBeTrue();
    expect(sent[0].vehicles[1]).toMatchObject({ plateNumber: "沪A34567", capacityTonnes: 0 });
    expect(sent[0].vehicles.every((vehicle: any) => !("allowedRoads" in vehicle))).toBeTrue(); expect(state.editable.value).toBeFalse();
    expect(state.registerVisit).toBeUndefined(); expect(events.every(event => ["dirty", "busy", "saved"].includes(event[0]))).toBeTrue();
    state.completeProfile(server.vehicles.find(v => v.carrierId === "carrier-b")); expect(state.rows.value).toHaveLength(2); expect(state.message.value).toContain("本承运商");
    state.edit(); state.current.value.capacityTonnes = 8; state.change();
    props.fleet = { ...server, parkVersion: "new-visit", vehicles: [...server.vehicles, { vehicleId: "沪A45678", plateNumber: "沪A45678", carrierId: "carrier-a", allowedRoads: [], profiled: false, status: "queued" }] };
    await nextTick(); expect(state.pending.value.map((vehicle: any) => vehicle.vehicleId)).toContain("沪A45678"); expect(state.current.value.capacityTonnes).toBe(8); expect(state.dirty.value).toBeTrue();
  } finally { view.stop(); globalThis.fetch = original; currentCarrierRole.value = undefined; }
});

test("real KeepAlive retains carrier drafts across role and tab switches and the workspace guards unsaved navigation", async () => {
  const { default: component } = await import(fileURLToPath(new URL("../../web/src/views/CarrierWorkspace.vue", import.meta.url)));
  const { default: profile } = await import(fileURLToPath(new URL("../../web/src/components/CarrierVehicleEditor.vue", import.meta.url)));
  const original = globalThis.fetch, captured: Record<string, any> = {}, server = overview(); currentCarrierRole.value = undefined;
  globalThis.fetch = Object.assign(async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(path) === "/api/carrier-role") { const body = JSON.parse(String(init?.body)); return Response.json({ carrierId: body.carrierId, token: "role-" + body.carrierId, expiresAt: Date.now() + 3600000 }); }
    const role = currentCarrierRole.value!; expect(new Headers(init?.headers).get("X-Carrier-Role")).toBe(role.token);
    if (String(path) === "/api/carrier/fleet") return Response.json({ ...server, carrierId: role.carrierId, scopeVersion: role.carrierId });
    expect(String(path)).toBe("/api/carrier/visits");
    return Response.json({ version: "park", visits: [], catalog: { ...server, dataset: "park_visits", version: "park", carrierId: role.carrierId, scopeVersion: role.carrierId, vehicleCount: 0, sampleCount: 0, visitCount: 0, completedCount: 0, nodes: [], roads: [] } });
  }, { preconnect: original.preconnect }) as typeof fetch;
  const child = { props: profile.props, setup(props: any, context: any) { captured[props.carrierId] = profile.setup(props, context); return () => null; } };
  const view = await mountPageSetup(component, {}, () => {}, "/carriers?carrierId=carrier-a&tab=vehicles", state => h(KeepAlive, null, { default: () => state.fleet.value && state.tab.value === "vehicles" ? h(child, { key: state.carrierId.value, carrierId: state.carrierId.value, fleet: state.fleet.value, onDirty: state.markVehicles, onBusy: state.markVehicleBusy }) : null }));
  const settle = async () => { for (let i = 0; i < 12; i++) { await nextTick(); await Bun.sleep(1); } };
  try {
    await settle(); const a = captured["carrier-a"]; a.add(); a.current.value.plateNumber = "沪A12345";
    await view.state.switchRole("carrier-b"); await settle(); const b = captured["carrier-b"]; b.add(); b.current.value.plateNumber = "沪B12345";
    await view.state.switchRole("carrier-a"); await settle(); expect(captured["carrier-a"]).toBe(a); expect(a.current.value.plateNumber).toBe("沪A12345");
    expect(view.state.vehicleDirty.value).toMatchObject({ "carrier-a": true, "carrier-b": true });
    await view.state.changeTab("visits"); await settle(); await view.state.changeTab("vehicles"); await settle(); expect(captured["carrier-a"]).toBe(a);
    const previousWindow = (globalThis as any).window; (globalThis as any).window = { confirm: () => false, addEventListener() {}, removeEventListener() {} };
    try { await view.router.push("/vehicles"); expect(view.router.currentRoute.value.path).toBe("/carriers"); } finally { if (previousWindow === undefined) delete (globalThis as any).window; else (globalThis as any).window = previousWindow; }
  } finally { view.stop(); globalThis.fetch = original; currentCarrierRole.value = undefined; }
});
