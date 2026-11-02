import { test, expect } from "bun:test";
import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, compileScript } from "vue/compiler-sfc";
import { reactive, nextTick } from "vue";
import { defaultParkSettings, parseParkTimestamp, type FleetOverview, type ParkCatalog, type ParkVisit } from "@vectra/shared";
import { currentCarrierRole } from "../../web/src/carrier-role";
import { mountPageSetup } from "./ui-setup";
plugin({ name: "park-editor-handlers", setup(builder) {
  builder.onLoad({ filter: /(?:ParkVisitEditor|LicensePlateInput)\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8")).descriptor, { id: "park-editor-handlers" }).content, loader: "ts", resolveDir: dirname(path) }));
} });
const at = Date.parse("2026-10-23T08:00:00+08:00");
const historical = (): ParkVisit => ({ visitId: "history-b", vehicleId: "沪B12345", carrierId: "carrier-b", road: "西入口", arrivedAt: at, departedAt: at + 3600000 });
async function editor(initial: ParkVisit[] = [], focusVehicleId?: string) {
  const { default: component } = await import(fileURLToPath(new URL("../../web/src/components/ParkVisitEditor.vue", import.meta.url)));
  const original = globalThis.fetch, originalRole = currentCarrierRole.value, sent: Array<{ path: string; method: string; body: any }> = [];
  let published = structuredClone(initial), serial = 0, rejectAdmission = false;
  const catalog = (): ParkCatalog => ({ dataset: "park_visits", settings: defaultParkSettings(), version: "version-" + serial, source: "import", updatedAt: 0, vehicleCount: new Set(published.map(row => row.vehicleId)).size, sampleCount: published.length, visitCount: published.length, completedCount: published.filter(row => row.departedAt !== undefined).length, nodes: [], roads: [], carrierId: "carrier-b", scopeVersion: "scope-" + serial });
  const snapshot = () => ({ version: catalog().version, visits: published, catalog: catalog() });
  const fleet: FleetOverview = { version: "fleet", updatedAt: 0, parkVersion: catalog().version, parkUpdatedAt: 0, settings: defaultParkSettings(), roads: ["东入口", "南入口", "西入口", "北入口"], vehicles: [{ vehicleId: "沪B12345", carrierId: "carrier-b", plateNumber: "沪B12345", allowedRoads: ["西入口"], profiled: true, status: "no_visit" }] };
  const props = reactive({ catalog: catalog(), fleet, scopeCarrier: "carrier-b" as const, focusVehicleId, guardNavigation: false });
  currentCarrierRole.value = { carrierId: "carrier-b", token: "role-b", expiresAt: Date.now() + 3600000 };
  globalThis.fetch = Object.assign(async (path: Parameters<typeof fetch>[0], options?: RequestInit) => {
    expect(new Headers(options?.headers).get("X-Carrier-Role")).toBe("role-b");
    if (!options?.method || options.method === "GET") { expect(String(path)).toBe("/api/carrier/visits"); return Response.json(snapshot()); }
    const body = JSON.parse(String(options.body)); sent.push({ path: String(path), method: options.method, body });
    if (String(path).endsWith("/queue")) {
      if (rejectAdmission) return Response.json({ code: "queue_rejected", message: "排队未保存" }, { status: 422 });
      published.push({ ...body, carrierId: "carrier-b", arrivedAt: body.arrivedAt ? parseParkTimestamp(body.arrivedAt) : Date.now() });
    } else if (String(path).endsWith("/admissions")) {
      if (rejectAdmission) return Response.json({ code: "admission_rejected", message: "入园未确认" }, { status: 422 });
      const enteredAt = body.enteredAt ? parseParkTimestamp(body.enteredAt) : Date.now();
      published.push({ ...body, carrierId: "carrier-b", enteredAt, arrivedAt: body.arrivedAt ? parseParkTimestamp(body.arrivedAt) : enteredAt });
    } else if (String(path).endsWith("/lifecycle")) {
      const id = String(path).split("/").at(-2)!, row = published.find(row => row.visitId === id)!;
      (row as any)[body.field] = body.at ? parseParkTimestamp(body.at) : Date.now();
      for (const field of ["distanceKm", "energyKwh"]) if (body[field] !== undefined) (row as any)[field] = body[field];
    } else if (String(path).endsWith("/import")) published.push(...body.visits);
    else if (options.method === "PUT") published = published.map(row => row.visitId === body.visit.visitId ? body.visit : row);
    else throw new Error("Unexpected visit request");
    serial++; return Response.json(snapshot());
  }, { preconnect: original.preconnect }) as typeof fetch;
  const view = await mountPageSetup(component, props, (name, value) => { if (name === "saved" || name === "loaded") props.catalog = value; }, "/carriers?tab=visits");
  return { ...view, props, sent, reject(value: boolean) { rejectAdmission = value; }, cleanup() { view.stop(); globalThis.fetch = original; currentCarrierRole.value = originalRole; } };
}
test("incomplete entry and vehicle prefill do not create visits or timestamps; explicit complete confirmation does", async () => {
  const view = await editor();
  try {
    const state = view.state;
    expect(await state.confirmAdmission()).toBeFalse(); expect(view.sent).toHaveLength(0); expect(state.records.value).toHaveLength(0); expect(state.entry.enteredAt).toBe("");
    state.entry.vehicleId = "沪B12345"; state.chooseVehicle();
    expect(state.entry.road).toBe("西入口"); expect(state.canEnter.value).toBeTrue(); expect(state.records.value).toHaveLength(0); expect(state.entry.enteredAt).toBe("");
    const before = Date.now(); expect(await state.confirmAdmission()).toBeTrue();
    expect(view.sent[0].path).toBe("/api/carrier/visits/admissions"); expect(view.sent[0].body).not.toHaveProperty("enteredAt");
    expect(state.records.value).toHaveLength(1); expect(state.records.value[0].enteredAt).toBeGreaterThanOrEqual(before); expect(state.records.value[0].enteredAt).toBeLessThanOrEqual(Date.now());
    expect(state.records.value[0].carrierId).toBe("carrier-b"); expect(state.dirty.value).toBeFalse();
  } finally { view.cleanup(); }
});

test("queue registration records arrival only, stays outside in-park work and enters on the same visit and entrance", async () => {
  const view = await editor([historical()]);
  try {
    const state = view.state;
    expect(state.registrationMode.value).toBe("queue");
    expect(await state.confirmQueue()).toBeFalse(); expect(view.sent).toHaveLength(0);
    state.entry.vehicleId = "沪B12345"; state.chooseVehicle();
    state.entryCurrentTime.value = false; expect(state.canQueue.value).toBeFalse();
    state.entryCurrentTime.value = true; expect(state.canRegister.value).toBeTrue();
    const visitId = state.entry.visitId, before = Date.now();
    view.reject(true); expect(await state.submitEntry()).toBeFalse(); expect(state.entry.visitId).toBe(visitId); expect(state.queueCount.value).toBe(0);
    view.reject(false); expect(await state.submitEntry()).toBeTrue(); await nextTick();
    const queued = state.records.value.find((row: ParkVisit) => row.visitId === visitId);
    expect(view.sent.at(-1)?.path).toBe("/api/carrier/visits/queue");
    expect(view.sent.at(-1)?.body).not.toHaveProperty("arrivedAt"); expect(view.sent.at(-1)?.body).not.toHaveProperty("enteredAt");
    expect(queued.arrivedAt).toBeGreaterThanOrEqual(before); expect(queued.enteredAt).toBeUndefined();
    expect(state.view.value).toBe("queue"); expect(state.queueCount.value).toBe(1); expect(state.activeCount.value).toBe(0); expect(state.departedCount.value).toBe(1);
    expect(state.stageLabel(queued)).toBe("排队待入园"); expect(state.nextField.value).toBe("enteredAt");
    const arrivedAt = queued.arrivedAt;
    expect(await state.advance()).toBeTrue(); await nextTick();
    const admitted = state.records.value.find((row: ParkVisit) => row.visitId === visitId);
    expect(admitted).toMatchObject({ visitId, road: "西入口", arrivedAt });
    expect(admitted.enteredAt).toBeGreaterThanOrEqual(arrivedAt);
    expect(view.sent.at(-1)?.body).toMatchObject({ field: "enteredAt" }); expect(view.sent.at(-1)?.body).not.toHaveProperty("road");
    expect(state.view.value).toBe("active"); expect(state.queueCount.value).toBe(0); expect(state.activeCount.value).toBe(1);
    expect(state.records.value).toHaveLength(2);
  } finally { view.cleanup(); }
});
test("failed admission retains the complete pending form; prefilled old links remain pending and never auto-admit", async () => {
  const view = await editor([], "沪B12345");
  try {
    const state = view.state, pendingId = state.entry.visitId;
    expect(state.entry.vehicleId).toBe("沪B12345"); expect(state.entry.road).toBe("西入口"); expect(view.sent).toHaveLength(0); expect(state.records.value).toHaveLength(0);
    view.reject(true); expect(await state.confirmAdmission()).toBeFalse(); expect(state.entry.visitId).toBe(pendingId); expect(state.entry.vehicleId).toBe("沪B12345"); expect(state.entry.enteredAt).toBe(""); expect(state.records.value).toHaveLength(0);
    view.reject(false); expect(await state.confirmAdmission()).toBeTrue(); expect(view.sent[1].body.visitId).toBe(pendingId);
  } finally { view.cleanup(); }
});
test("confirmed lifecycle actions save immediately with current time, keep the entrance and preserve zero departure metrics", async () => {
  const view = await editor([], "沪B12345");
  try {
    const state = view.state; expect(await state.confirmAdmission()).toBeTrue(); const id = state.selected.value.visitId;
    for (const field of ["serviceStartedAt", "serviceEndedAt", "departedAt"]) {
      if (field === "departedAt") { state.distanceKm.value = 0; state.energyKwh.value = 0; }
      const before = Date.now(); expect(await state.advance()).toBeTrue();
      expect(state.selected.value.visitId).toBe(id); expect(state.selected.value.road).toBe("西入口"); expect(state.selected.value[field]).toBeGreaterThanOrEqual(before);
      expect(view.sent.at(-1)?.body.field).toBe(field); expect(view.sent.at(-1)?.body).not.toHaveProperty("road"); expect(view.sent.at(-1)?.body).not.toHaveProperty("at");
      if (field === "serviceEndedAt") { expect(state.view.value).toBe("departed"); expect(state.departureFilter.value).toBe("pending"); expect(state.pendingDepartureCount.value).toBe(1); expect(state.selected.value.departedAt).toBeUndefined(); }
    }
    expect(state.selected.value).toMatchObject({ distanceKm: 0, energyKwh: 0 }); expect(state.view.value).toBe("departed");
    expect(state.departureFilter.value).toBe("completed"); expect(state.pendingDepartureCount.value).toBe(0);
    const count = view.sent.length; state.resetEntry(state.selected.value); expect(state.entry.vehicleId).toBe("沪B12345"); expect(state.entry.road).toBe("西入口"); expect(state.entry.enteredAt).toBe(""); expect(view.sent).toHaveLength(count); expect(state.records.value).toHaveLength(1);
  } finally { view.cleanup(); }
});

test("departure queue contains only work-finished visits and confirmed times appear after explicit departure", async () => {
  const inside = { visitId: "inside", vehicleId: "沪B23456", carrierId: "carrier-b" as const, road: "西入口", arrivedAt: at, enteredAt: at };
  const ready = { ...inside, visitId: "ready", vehicleId: "沪B34567", serviceStartedAt: at + 60000, serviceEndedAt: at + 120000 };
  const view = await editor([inside, ready, historical()]);
  try {
    const state = view.state; state.view.value = "departed"; await nextTick();
    expect(state.filtered.value.map((row: ParkVisit) => row.visitId)).toEqual(["ready"]);
    expect(state.pendingDepartureCount.value).toBe(1); expect(state.selected.value.departedAt).toBeUndefined(); expect(view.sent).toHaveLength(0);
    expect(await state.advance()).toBeTrue(); expect(view.sent.at(-1)?.body.field).toBe("departedAt");
    expect(state.selected.value.departedAt).toBeGreaterThanOrEqual(ready.serviceEndedAt); expect(state.departureFilter.value).toBe("completed");
    expect(state.filtered.value.map((row: ParkVisit) => row.visitId)).toContain("ready");
    state.departureFilter.value = "all"; await nextTick();
    expect(new Set(state.filtered.value.map((row: ParkVisit) => row.visitId))).toEqual(new Set(["ready", "history-b"]));
    state.departureFilter.value = "pending"; await nextTick(); expect(state.filtered.value).toHaveLength(0); expect(state.selected.value).toBeUndefined();
  } finally { view.cleanup(); }
});
test("view opens a record dialog for an already selected row and can reopen after closing", async () => {
  const completed = { ...historical(), distanceKm: 0, energyKwh: 0 }, view = await editor([completed]);
  try {
    const state = view.state, dialog = { open: false, opens: 0, scrollTop: 200, showModal() { this.open = true; this.opens++; }, close() { this.open = false; } };
    state.recordDialog.value = dialog; state.view.value = "all"; await nextTick();
    expect(state.selectedId.value).toBe(completed.visitId);
    expect(state.openRecord(completed)).toBeTrue(); await nextTick();
    expect(state.recordDetailsOpen.value).toBeTrue(); expect(dialog.open).toBeTrue(); expect(dialog.opens).toBe(1);
    expect(dialog.scrollTop).toBe(0);
    expect(state.selected.value).toMatchObject({ distanceKm: 0, energyKwh: 0 }); expect(view.sent).toHaveLength(0);
    expect(state.closeRecordDetails()).toBeTrue(); expect(dialog.open).toBeFalse();
    expect(state.openRecord(completed)).toBeTrue(); await nextTick(); expect(dialog.opens).toBe(2);
    expect(state.beginCorrection()).toBeTrue(); expect(state.correction.value.distanceKm).toBe(0);
    state.correction.value.distanceKm = 133;
    expect(await state.saveCorrection()).toBeTrue(); expect(view.sent).toHaveLength(1);
    expect(view.sent[0]).toMatchObject({ method: "PUT", body: { visit: { visitId: completed.visitId, distanceKm: 133, energyKwh: 0 } } });
    expect(state.selected.value.distanceKm).toBe(133); expect(state.correction.value).toBeUndefined();
    expect(state.recordDetailsOpen.value).toBeTrue(); expect(state.message.value).toContain("更正已保存");
  } finally { view.cleanup(); }
});

test("completed departure records open details while pending departures keep the confirmation flow", async () => {
  const pending = { ...historical(), visitId: "pending", departedAt: undefined, serviceEndedAt: at + 1800000 }, view = await editor([pending, historical()]);
  try {
    const state = view.state;
    state.view.value = "departed"; await nextTick();
    expect(state.openRecord(pending)).toBeTrue(); expect(state.recordDetailsOpen.value).toBeFalse(); expect(state.selectedId.value).toBe("pending");
    state.departureFilter.value = "completed"; await nextTick();
    expect(state.openRecord(historical())).toBeTrue(); expect(state.recordDetailsOpen.value).toBeTrue();
    expect(view.sent).toHaveLength(0);
  } finally { view.cleanup(); }
});

test("closing or switching a record preserves an unsaved correction when discard is declined", async () => {
  const other = { ...historical(), visitId: "other", vehicleId: "沪B23456" }, view = await editor([historical(), other]);
  const previousWindow = (globalThis as any).window;
  try {
    const state = view.state; state.view.value = "all"; await nextTick(); state.openRecord(historical()); state.beginCorrection();
    state.correction.value.distanceKm = "123";
    (globalThis as any).window = { confirm: () => false, addEventListener() {}, removeEventListener() {} };
    expect(state.closeRecordDetails()).toBeFalse(); expect(state.recordDetailsOpen.value).toBeTrue();
    expect(state.openRecord(other)).toBeFalse(); expect(state.selectedId.value).toBe(historical().visitId); expect(state.correction.value.distanceKm).toBe("123");
    expect(view.sent).toHaveLength(0);
  } finally { if (previousWindow === undefined) delete (globalThis as any).window; else (globalThis as any).window = previousWindow; view.cleanup(); }
});

test("history preview preserves original times, rejects foreign files and appends only after explicit confirmation", async () => {
  const first = { ...historical(), visitId: "earlier", arrivedAt: at - 86400000, departedAt: at - 82800000 }, view = await editor([first]);
  const file = (value: unknown) => ({ target: { files: [new File([JSON.stringify(value)], "visits.json")], value: "selected" } }) as any;
  try {
    const state = view.state;
    await state.importFile(file([historical()])); expect(view.sent).toHaveLength(0); expect(state.records.value).toHaveLength(1); expect(state.importRows.value[0].enteredAt).toBe("");
    await state.importFile(file([{ ...historical(), carrierId: "carrier-a" }])); expect(state.importRows.value).toHaveLength(1); expect(state.message.value).toContain("其他承运商");
    await state.importFile(file([{ ...historical(), arrivedAt: "2026-02-30T08:00:00" }])); expect(state.importRows.value[0].visitId).toBe("history-b");
    expect(await state.confirmImport()).toBeTrue(); expect(view.sent[0].path).toBe("/api/carrier/visits/import"); expect(view.sent[0].body.visits).toHaveLength(1); expect(state.records.value).toHaveLength(2); expect(state.importRows.value).toHaveLength(0);
  } finally { view.cleanup(); }
});
