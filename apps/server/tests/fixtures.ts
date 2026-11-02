import { randomUUID } from "node:crypto";
import { PARTICIPANTS, CARRIER_BINDINGS, REGISTERED_IDENTITIES, LLM_AGENT_IDS, identityProfile, defaultParkSettings, type ParkSettings, type PublicNode } from "@vectra/shared";
import type { Collaboration } from "../src/service";

// Test-only data and provider responses. Production always requires the configured model.
export const fixtureIdentities = (settings: ParkSettings = defaultParkSettings()): PublicNode[] => REGISTERED_IDENTITIES.map(id => ({ id, ...identityProfile(id, settings)!, fingerprint: `test-fingerprint-${id}`, signingPublicKey: `test-public-key-${id}`, certificateExpires: "2027-10-30T00:00:00+08:00" }));
export const fixtureRecords = () => PARTICIPANTS.map((participant, index) => ({ participant, vehicleId: participant, road: "S101", recordedAt: Date.now() - 5000, speed: [60, 40, 20][index], distanceKm: 1, energyKwh: 0.15 }));
export const fixtureVisits = () => CARRIER_BINDINGS.map((carrier, index) => { const arrivedAt = Date.now() - 3 * 3600000; return { visitId: `fixture-visit-${index}`, carrierId: carrier.id, vehicleId: `沪${String.fromCharCode(65 + index)}10001`, road: "东入口", arrivedAt, gateStartedAt: arrivedAt + [60, 40, 20][index] * 60000, departedAt: arrivedAt + 120 * 60000, distanceKm: 1, energyKwh: 0.15 }; });
export function configureFixtureModels(app: Collaboration, apiKey = "fixture-model-key") {
  for (const id of LLM_AGENT_IDS) app.agents.configureModel(id, { provider: "custom", baseUrl: "https://example.invalid/v1", model: "test", apiKey });
}
export function configureFixture(app: Collaboration) {
  configureFixtureModels(app);
  app.telemetry.import(fixtureRecords());
  app.park.import(fixtureVisits(), app.park.catalog().version);
}
export function fixtureProviderReply(payload: any): Response {
  const names = payload.tools.map((tool: any) => tool.function.name), last = payload.messages.at(-1);
  const call = (name: string, args: unknown = {}) => Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
  if (names.includes("submit_statistics_plan")) return call("submit_statistics_plan", { dataset: "park_visits", cohort: "arrivals", roads: ["东入口"], start: Date.now() - 86400000, end: Date.now() - 1000, timeZone: "Asia/Shanghai", metrics: [{ label: "平均排队时长", operation: "mean", field: "queueMinutes" }] });
  if (names.includes("submit_analysis")) {
    if (last.role === "user") return call("query_events");
    return call("submit_analysis", { facts: ["实际工具已执行"], possibleCauses: [], recommendations: [], uncertainties: ["测试数据不证明道路实况"], evidenceIds: [JSON.parse(last.content).events[0].id] });
  }
  if (last.role === "user" && names.includes("verify_latest_report")) return call("verify_latest_report");
  if (last.role === "user" && names.includes("compute_statistics")) return call("compute_statistics");
  if (names.includes("delegate_analysis") && !payload.messages.some((m: any) => m.tool_calls?.some((c: any) => c.function.name === "delegate_analysis"))) return call("delegate_analysis");
  return Response.json({ choices: [{ message: { role: "assistant", content: "VECTRA：已完成本轮工具交互，平均排队时长为 40.00 分钟。" } }] });
}
export function installFixtureProvider() {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => String(input).startsWith("https://example.invalid/") ? fixtureProviderReply(JSON.parse(String(init?.body))) : original(input, init), { preconnect: original.preconnect }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
