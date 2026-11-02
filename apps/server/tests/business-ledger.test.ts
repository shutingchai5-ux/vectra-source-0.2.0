import { expect, test } from "bun:test";
import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileScript, parse } from "vue/compiler-sfc";
import { nextTick } from "vue";
import { defaultParkSettings, type ParkSnapshot, type ParkVisit } from "@vectra/shared";
import { currentCarrierRole } from "../../web/src/carrier-role";
import { mountPageSetup } from "./ui-setup";

plugin({ name: "business-ledger-handlers", setup(builder) {
  builder.onLoad({ filter: /BusinessLedgerEditor\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, "utf8")).descriptor, { id: "business-ledger-handlers" }).content, loader: "ts", resolveDir: dirname(path) }));
} });
const settings = defaultParkSettings();
const visit = (visitId: string, distanceKm?: number): ParkVisit => ({ visitId, carrierId: "carrier-a", vehicleId: "沪A12345", road: "东入口", arrivedAt: Date.now() - 7200000, departedAt: Date.now() - 3600000, ...(distanceKm === undefined ? {} : { distanceKm }) });
async function editor(current: ParkVisit[], original?: ParkVisit[]) {
  const { default: component } = await import(fileURLToPath(new URL("../../web/src/components/BusinessLedgerEditor.vue", import.meta.url)));
  const native = globalThis.fetch, previousRole = currentCarrierRole.value, requests: string[] = [];
  const snapshot = (visits: ParkVisit[], version: string) => ({ version, visits, catalog: { version, settings, carrierId: "carrier-a", nodes: [], roads: [] } }) as unknown as ParkSnapshot;
  currentCarrierRole.value = { carrierId: "carrier-a", token: "role-a", expiresAt: Date.now() + 3600000 };
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const path = String(input); requests.push(path);
    expect(new Headers(options?.headers).get("X-Carrier-Role")).toBe("role-a");
    if (path === "/api/carrier/business/haulage") return Response.json({ version: "ledger-current", records: [], catalog: { domain: "haulage", carrierId: "carrier-a", settings, updatedAt: 0 } });
    if (path === "/api/carrier/business/haulage/versions") return Response.json([]);
    if (path === "/api/carrier/fleet") return Response.json({ vehicles: [] });
    if (path === "/api/carrier/visits") return Response.json(snapshot(current, "park-current"));
    if (path === "/api/carrier/visits?version=park-original") return Response.json(snapshot(original ?? [], "park-original"));
    throw new Error("Unexpected business ledger request: " + path);
  }, { preconnect: native.preconnect }) as typeof fetch;
  try {
    const view = await mountPageSetup(component, { domain: "haulage", carrierId: "carrier-a" });
    return { ...view, requests, cleanup() { view.stop(); globalThis.fetch = native; currentCarrierRole.value = previousRole; } };
  } catch (cause) { globalThis.fetch = native; currentCarrierRole.value = previousRole; throw cause; }
}

test("haulage entry reveals the selected source mileage and rejects mismatches before adding a draft", async () => {
  const view = await editor([visit("known", 100)]);
  try {
    const state = view.state;
    state.draft.visitId = "known"; state.chooseVisit();
    expect(state.sourceDistance.value).toBe(100);
    Object.assign(state.draft, { loadedDistanceKm: "60", emptyDistanceKm: "20" });
    expect(state.mileageSum.value).toBe(80); expect(state.mileageDelta.value).toBe(20);
    expect(state.mileageIssue.value).toContain("还差 20 km");
    state.add(); expect(state.records.value).toHaveLength(0); expect(state.message.value).toContain("100 km");
    state.draft.loadedDistanceKm = "90";
    expect(state.mileageIssue.value).toContain("超出 10 km");
    state.draft.loadedDistanceKm = "80";
    expect(state.mileageIssue.value).toBe(""); state.add();
    expect(state.records.value[0]).toMatchObject({ visitId: "known", sourceParkVersion: "park-current", loadedDistanceKm: 80, emptyDistanceKm: 20 });
    expect(view.requests.every(path => !path.includes("?version="))).toBeTrue();
  } finally { view.cleanup(); }
});

test("haulage distinguishes a zero source mileage from missing mileage and preserves unknown fields", async () => {
  const view = await editor([visit("zero", 0), visit("missing")]);
  try {
    const state = view.state;
    state.draft.visitId = "zero"; state.chooseVisit();
    expect(state.sourceDistance.value).toBe(0);
    Object.assign(state.draft, { loadedDistanceKm: "0", emptyDistanceKm: "0" });
    expect(state.mileageIssue.value).toBe(""); expect(state.candidate()).toMatchObject({ loadedDistanceKm: 0, emptyDistanceKm: 0 });
    state.draft.visitId = "missing"; state.chooseVisit();
    expect(state.sourceDistance.value).toBeUndefined();
    Object.assign(state.draft, { loadedDistanceKm: "5", emptyDistanceKm: "3" });
    expect(state.mileageIssue.value).toBe(""); expect(state.mileageDelta.value).toBeUndefined();
    expect(state.candidate()).toMatchObject({ loadedDistanceKm: 5, emptyDistanceKm: 3 });
    Object.assign(state.draft, { loadedDistanceKm: "", emptyDistanceKm: "", actualLoadTonnes: "2" });
    expect(state.candidate()).not.toHaveProperty("loadedDistanceKm"); expect(state.candidate()).not.toHaveProperty("emptyDistanceKm");
    state.draft.loadedDistanceKm = "0";
    expect(state.mileageIssue.value).toContain("成对填写"); expect(() => state.candidate()).toThrow("成对填写");
  } finally { view.cleanup(); }
});

test("editing a haulage record checks its original source snapshot after the current trip was corrected", async () => {
  const view = await editor([visit("known", 150)], [visit("known", 100)]);
  try {
    const state = view.state;
    state.edit({ id: "saved", visitId: "known", sourceParkVersion: "park-original", loadedDistanceKm: 80, emptyDistanceKm: 20 });
    for (let count = 0; count < 100 && state.sourceDistance.value === undefined; count++) { await nextTick(); await Bun.sleep(1); }
    expect(view.requests).toContain("/api/carrier/visits?version=park-original");
    expect(state.sourceDistance.value).toBe(100); expect(state.mileageIssue.value).toBe("");
    expect(state.candidate().sourceParkVersion).toBe("park-original");
    state.chooseVisit();
    expect(state.sourceDistance.value).toBe(150); expect(state.mileageIssue.value).toContain("还差 50 km");
  } finally { view.cleanup(); }
});

test("haulage accepts the server's mileage precision and keeps drafts intact when the source cannot be found", async () => {
  const view = await editor([visit("known", 0.3)]);
  try {
    const state = view.state;
    state.draft.visitId = "known"; state.chooseVisit();
    Object.assign(state.draft, { loadedDistanceKm: "0.1", emptyDistanceKm: "0.2" });
    expect(state.mileageIssue.value).toBe(""); expect(state.mileageDelta.value).toBe(0);
    state.draft.visitId = "unavailable";
    expect(state.mileageIssue.value).toContain("无法核对"); state.add();
    expect(state.records.value).toHaveLength(0); expect(state.draft.loadedDistanceKm).toBe("0.1");
  } finally { view.cleanup(); }
});
