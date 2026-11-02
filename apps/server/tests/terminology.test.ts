import { afterEach, beforeEach, expect, test } from "bun:test";
import { CONVERSATION_PHASES, defaultParkSettings, identityProfile, LEGACY_ROLE_OWNERS, normalizeSystemTerms, REGISTERED_IDENTITIES, registeredIdentityFor, ROLE_NAMES } from "@vectra/shared";
import { friendlyText, readableValue, actorFor, checkLabel } from "../../web/src/conversation";
import { renderMarkdown } from "../../web/src/markdown";
import { setParkSettings, setRegisteredIdentities } from "../../web/src/park-state";
import { stepGuides } from "../../web/src/step-explanations";
import { fixtureIdentities } from "./fixtures";
const reset = () => { setParkSettings(defaultParkSettings()); setRegisteredIdentities(fixtureIdentities()); };
beforeEach(reset); afterEach(reset);

test("one registered principal has one display name and legacy labels resolve to its owner", () => {
  for (const [oldName, principal] of Object.entries(LEGACY_ROLE_OWNERS)) {
    expect(registeredIdentityFor(oldName)).toBe(principal); expect(normalizeSystemTerms(oldName)).toBe(ROLE_NAMES[principal]);
    expect(actorFor(oldName).name).toBe(ROLE_NAMES[principal]);
  }
  for (const id of REGISTERED_IDENTITIES) { const profile = identityProfile(id)!; expect(profile.displayCode).toBe(id); expect(profile.displayName.endsWith("Agent")).toBe(profile.usesLlm); expect(normalizeSystemTerms(profile.displayName)).toBe(profile.displayName); }
  expect(normalizeSystemTerms("RSU（Roadside Unit，路侧单元）")).toBe(ROLE_NAMES.rsu);
  expect(registeredIdentityFor("constructor")).toBeUndefined(); expect(checkLabel("RSU 签名")).not.toContain("RSU");
  for (const phase of CONVERSATION_PHASES) expect(normalizeSystemTerms(phase.description)).toBe(phase.description);
  for (const guide of Object.values(stepGuides)) for (const text of [guide.goal, guide.why, guide.operation, guide.completed, guide.next, ...guide.steps]) expect(normalizeSystemTerms(text), text).toBe(text);
});

test("assistant prose unifies role names while user input, signed examples, links, code and formulas remain verbatim", () => {
  const prose = "任务管家请网关授权，再由运营分析师分析、报告专员交付。自定义网关使用另一个接口。";
  const html = renderMarkdown(prose, true);
  expect(html).toContain(ROLE_NAMES.coordinator); expect(html).toContain(ROLE_NAMES.rsu); expect(html).toContain(ROLE_NAMES.report); expect(html).toContain("自定义模型服务接口"); expect(html).not.toContain("网关");
  const original = [
    "\u0060网关 coordinator rsu\u0060", "",
    "\u0060\u0060\u0060json", '{"signer":"rsu","signature":"keep-signature","request":"网关"}', "\u0060\u0060\u0060", "",
    "[网关地址](https://gateway.invalid/RSU?coordinator=1)", "", "$\\mathrm{RSU}+1$",
  ].join("\n");
  const raw = renderMarkdown(original, true);
  expect(raw).toContain("<code>网关 coordinator rsu</code>"); expect(raw).toContain('&quot;signer&quot;:&quot;rsu&quot;'); expect(raw).toContain("&quot;request&quot;:&quot;网关&quot;");
  expect(raw).toContain('href="https://gateway.invalid/RSU?coordinator=1"'); expect(raw).toContain('application/x-tex">\\mathrm{RSU}+1');
  expect(renderMarkdown(prose)).toContain("任务管家"); expect(readableValue("任务管家", "request")).toBe("任务管家");
  expect(friendlyText(original)).toBe(original);
});

test("configured business names are protected and canonical formatting is idempotent", () => {
  const park = defaultParkSettings(); park.name = "计算节点园区"; park.carriers[0].name = "网关运输公司"; setParkSettings(park); setRegisteredIdentities(fixtureIdentities(park));
  const text = "网关运输公司协作节点在计算节点园区协作，任务管家向网关申请授权。";
  const displayed = renderMarkdown(text, true); expect(displayed).toContain("网关运输公司协作节点"); expect(displayed).toContain("计算节点园区"); expect(displayed).toContain(ROLE_NAMES.rsu);
  const once = friendlyText(text); expect(friendlyText(once)).toBe(once); expect(once).toContain("网关运输公司协作节点"); expect(once).not.toContain("任务管家");
});
