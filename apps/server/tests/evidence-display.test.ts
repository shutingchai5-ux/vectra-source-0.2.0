import { expect, test } from "bun:test";
import type { AuditEvent } from "@vectra/shared";
import { describeAuditEvent, evidenceCategories, filterEvidence, needsAttention, type EvidenceFilters } from "../../web/src/evidence";

const event = (id: number, kind: string, extra: Partial<AuditEvent> = {}): AuditEvent => ({ id, kind, at: 0, details: {}, claimedIdentity: null, verifiedIdentity: null, prevHash: "previous", hash: "hash", ...extra });
const filters: EvidenceFilters = { category: "all", keyword: "", taskId: "", attentionOnly: false };

test("audit categories retain every known, historical and future event without altering original evidence", () => {
  const kinds = ["task_created", "task_failed", "telemetry_imported", "task_authorized", "request_rejected", "mpc_started", "statistics_completed", "report_published", "service_started", "experiment_completed", "future_event"];
  const events = kinds.map((kind, id) => event(id + 1, kind));
  const original = JSON.stringify(events);
  const grouped = evidenceCategories.flatMap(category => filterEvidence(events, { ...filters, category: category.id }));
  expect(grouped.map(item => item.id).sort((a, b) => a - b)).toEqual(events.map(item => item.id));
  expect(describeAuditEvent(events.at(-1)!).category).toBe("other");
  expect(JSON.stringify(events)).toBe(original);
});

test("cancellation, rejected requests and computation progress keep distinct meanings", () => {
  const cancelled = event(1, "task_failed", { details: { code: "cancelled" } });
  expect(describeAuditEvent(cancelled).status).toBe("已取消");
  expect(needsAttention(cancelled)).toBe(false);
  expect(needsAttention(event(2, "task_failed"))).toBe(true);
  expect(needsAttention(event(3, "request_rejected"))).toBe(true);
  expect(describeAuditEvent(event(4, "request_rejected")).summary).toContain("不能确定行为动机");
  expect(describeAuditEvent(event(5, "mpc_started")).status).toBe("已发起");
  expect(describeAuditEvent(event(6, "statistics_completed")).summary).toContain("交付状态请继续核对");
});

test("category, task, attention and Chinese or raw keyword searches compose and preserve newest-first order", () => {
  const events = [
    event(1, "request_rejected", { details: { taskId: "task-a", code: "replay" }, claimedIdentity: "coordinator" }),
    event(2, "task_failed", { details: { taskId: "task-a", code: "timeout" } }),
    event(3, "task_authorized", { details: { taskId: "task-b" }, verifiedIdentity: "coordinator" }),
    event(4, "request_rejected", { details: { taskId: "task-a", code: "replay" } }),
  ];
  expect(filterEvidence(events, { ...filters, category: "security", taskId: "task-a", attentionOnly: true, keyword: "REPLAY" }).map(item => item.id)).toEqual([4, 1]);
  expect(filterEvidence(events, { ...filters, keyword: "任务管家" }).map(item => item.id)).toEqual([3, 1]);
  expect(filterEvidence(events, { ...filters, keyword: "身份与安全" }).map(item => item.id)).toEqual([4, 3, 1]);
  expect(filterEvidence(events, { ...filters, keyword: "#2" }).map(item => item.id)).toEqual([2]);
  expect(filterEvidence(events, { ...filters, taskId: "missing" })).toEqual([]);
  expect(events[0].verifiedIdentity).toBeNull();
});
