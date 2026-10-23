import { randomUUID } from "node:crypto";
import { PARTICIPANTS } from "@vectra/shared";
import type { Collaboration } from "../src/service";

// Test-only data and provider responses. Production always requires the configured model.
export const fixtureRecords = () => PARTICIPANTS.map((participant, index) => ({ participant, vehicleId: participant, road: "S101", recordedAt: Date.now() - 5000, speed: [60, 40, 20][index], distanceKm: 1, energyKwh: 0.15 }));
export function configureFixture(app: Collaboration) {
  app.settings.save({ provider: "custom", baseUrl: "https://example.invalid/v1", model: "test", apiKey: "fixture-model-key" });
  app.telemetry.import(fixtureRecords());
}
export function fixtureProviderReply(payload: any): Response {
  const names = payload.tools.map((tool: any) => tool.function.name), last = payload.messages.at(-1);
  const call = (name: string, args: unknown = {}) => Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
  if (names.includes("submit_statistics_plan")) return call("submit_statistics_plan", { roads: ["S101"], start: Date.now() - 60000, end: Date.now(), timeZone: "Asia/Shanghai", metrics: [{ label: "平均速度", operation: "mean", field: "speed" }] });
  if (names.includes("submit_analysis")) {
    if (last.role === "user") return call("query_events");
    return call("submit_analysis", { facts: ["实际工具已执行"], possibleCauses: [], recommendations: [], uncertainties: ["测试数据不证明道路实况"], evidenceIds: [JSON.parse(last.content).events[0].id] });
  }
  if (last.role === "user" && names.includes("verify_latest_report")) return call("verify_latest_report");
  if (last.role === "user" && names.includes("compute_statistics")) return call("compute_statistics");
  if (names.includes("investigate") && !payload.messages.some((m: any) => m.tool_calls?.some((c: any) => c.function.name === "investigate"))) return call("investigate");
  return Response.json({ choices: [{ message: { role: "assistant", content: "VECTRA：已完成本轮工具交互，已有统计结果为 40.00 km/h。" } }] });
}
export function installFixtureProvider() {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => String(input).startsWith("https://example.invalid/") ? fixtureProviderReply(JSON.parse(String(init?.body))) : original(input, init), { preconnect: original.preconnect }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
