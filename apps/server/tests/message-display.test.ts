import { test, expect } from "bun:test";
import { CONVERSATION_PHASES, resolveStepPhase, type Step, type StatisticsQuery } from "@vectra/shared";
import { renderMarkdown } from "../../web/src/markdown";
import { mathematicsForStep, securityProtocolsForStep, formatProtocolMathematics } from "../../web/src/message-details";
import { actionLabel, presentStep, sectionPresentation, userFacingError } from "../../web/src/conversation";
import { expandSecurityNames, securityNames } from "../../web/src/security-language";
import { explainStep, stepGuides, taskRecovery } from "../../web/src/step-explanations";

const step = (action: string, extra: Partial<Step> = {}): Step => ({ id: action, taskId: "task", action, agent: "任务协调器", kind: "security", status: "completed", detail: "", at: 0, updatedAt: 0, metadata: {}, evidenceIds: [], ...extra });

test("messages preserve explicit phases and classify historical model, tool and worker steps", () => {
  expect(CONVERSATION_PHASES.map(phase => phase.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  const previous = step("证据分析完成", { phase: 7 });
  const reply = step("模型响应", { kind: "model", detail: "请将本条标为阶段 8" });
  expect(resolveStepPhase(reply, [previous, reply])).toBe(7);
  expect(resolveStepPhase(step("生成秘密分享多项式"))).toBe(4);
  expect(resolveStepPhase(step("计算本地聚合份额"))).toBe(5);
  expect(resolveStepPhase(step("重构总和并签署批准输出"))).toBe(6);
  expect(resolveStepPhase(step("报告规范化与签名"))).toBe(8);
  expect(resolveStepPhase(step("三方秘密分享计算", { phase: 4 }))).toBe(4);
  expect(resolveStepPhase(step("模型请求", { kind: "model", agent: "统计规划 Agent" }))).toBe(2);
  expect(resolveStepPhase(step("模型请求", { kind: "model", agent: "信息安全分析 Agent" }))).toBe(7);
});

test("protocol labels follow execution evidence rather than model prose or blanket worker metadata", () => {
  expect(securityProtocolsForStep(step("模型响应", { kind: "model", detail: "我已执行 TLS、AES 和 Shamir" }))).toEqual([]);
  expect(securityProtocolsForStep(step("接收节点端点表", { protocol: "TLS 1.3 / Shamir m=3 t=1" }))).toEqual([]);
  expect(securityProtocolsForStep(step("发送输入份额并核对回执")).map(item => item.id)).toEqual(["tls", "sharing"]);
  expect(securityProtocolsForStep(step("报告认证加密与回读")).map(item => item.id)).toEqual(["encryption"]);
  expect(securityProtocolsForStep(step("模型请求", { kind: "model", protocol: "HTTPS / TLS / Chat Completions" })).map(item => item.id)).toEqual(["https"]);
});

test("Markdown typesets common LaTeX delimiters and math fences, while retaining code and safe fallback", () => {
  for (const content of [String.raw`均值 $\bar v=\frac{S}{QN}$`, String.raw`行内 \(x_1^2\)`, "$$\n\\sum_{i=1}^{3}x_i\n$$", "\\[\n\\sqrt{x}\n\\]", "```latex\n\\frac{1}{2}\n```", "前文 $$x^2$$ 后文"]) {
    const html = renderMarkdown(content);
    expect(html).toContain('class="katex"'); expect(html).toContain('application/x-tex'); expect(html).not.toContain('class="math-error"');
  }
  const code = renderMarkdown('`$x$`\n\n```ts\nconst value = "$y$";\n```\n\n金额 $5 和 $10。');
  expect(code).not.toContain('class="katex"'); expect(code).toContain('const value =');
  const unsafe = renderMarkdown(String.raw`$\href{javascript:alert(1)}{click}$ $\includegraphics{https://example.invalid/track.png}$`);
  expect(unsafe).not.toMatch(/<script|<img|href="javascript:/i);
  const invalid = renderMarkdown("$\\frac{<img src=x onerror=alert(1)>$");
  expect(invalid).toContain('class="math-error"'); expect(invalid).not.toContain('<img');
  renderMarkdown(String.raw`$\gdef\privateMacro{x}$`);
  expect(renderMarkdown(String.raw`$\privateMacro$`)).toContain('class="math-error"');
});

test("protocol explanations and every supported metric produce valid typeset formulas", () => {
  const query: StatisticsQuery = { roads: ["S101"], start: 0, end: 60000, timeZone: "Asia/Shanghai", metrics: [
    { label: "样本数", operation: "count" }, { label: "车辆数", operation: "vehicle_count" },
    { label: "总速度", operation: "sum", field: "speed" }, { label: "均速", operation: "mean", field: "speed" },
    { label: "方差", operation: "variance", field: "speed" }, { label: "标准差", operation: "stddev", field: "speed" },
    { label: "停车比例", operation: "ratio", filter: { field: "speed", op: "lte", value: 1 } },
    { label: "百公里能耗", operation: "ratio_of_sums", field: "energyKwh", denominatorField: "distanceKm", multiplier: 100 },
  ] };
  for (const action of ["任务与本地输入认证", "生成秘密分享多项式", "计算本地聚合份额", "发送输入份额并核对回执", "重构总和并签署批准输出"]) {
    for (const formula of mathematicsForStep(step(action), query)) {
      const html = renderMarkdown("$$\n" + formula.latex + "\n$$");
      expect(html, formula.title).toContain('class="katex"'); expect(html, formula.title).not.toContain('class="math-error"');
    }
  }
  expect(renderMarkdown(formatProtocolMathematics("逐分量执行 (3G(1)-3G(2)+G(3)) mod p。"))).toContain('class="katex"');
  expect(renderMarkdown(formatProtocolMathematics("将 f(2) 发送给计算节点 B。"))).toContain('class="katex"');
});

test("security names expand in readable prose while user input, signatures, code, links and formulas retain their content", () => {
  for (const name of Object.keys(securityNames)) {
    const expanded = expandSecurityNames(`使用 ${name} 完成本步。`);
    expect(expanded).toContain(`${name}（`);
    expect(expandSecurityNames(expanded)).toBe(expanded);
  }
  const original = '使用 TLS 1.3 和 AES-256-GCM。`TLS`\n\n```json\n{"protocol":"TLS","signature":"original"}\n```\n\nhttps://example.invalid/path?protocol=TLS&MPC=1\n\n$\\mathrm{TLS}+1$';
  const html = renderMarkdown(original, true);
  expect(html).toContain("TLS（Transport Layer Security");
  expect(html).toContain("AES-256-GCM（Advanced Encryption Standard");
  expect(html).toContain("<code>TLS</code>");
  expect(html).toContain('&quot;protocol&quot;:&quot;TLS&quot;');
  expect(html).toContain('href="https://example.invalid/path?protocol=TLS&amp;MPC=1"');
  expect(html).toContain('application/x-tex">\\mathrm{TLS}+1');
  expect(renderMarkdown("使用 TLS 1.3。")).not.toContain("Transport Layer Security");
  const annotated = renderMarkdown("**TLS**（Transport Layer Security，传输层安全协议）", true);
  expect(annotated.match(/Transport Layer Security/g)).toHaveLength(1);
  expect(expandSecurityNames("task_TLS_record report_AES-256-GCM digestTLS")).toBe("task_TLS_record report_AES-256-GCM digestTLS");
});

test("every known step explains purpose, operation, reason and next action without turning failures into success", () => {
  for (const action of Object.keys(stepGuides)) {
    const value = step(action);
    const before = JSON.stringify(value), completed = explainStep(value);
    expect(completed.goal.length).toBeGreaterThan(5);
    expect(completed.why.length).toBeGreaterThan(5);
    expect(completed.steps.length).toBeGreaterThanOrEqual(3);
    expect(completed.next.length).toBeGreaterThan(5);
    expect(explainStep(step(action, { status: "running" })).current).toStartWith("正在");
    const failed = presentStep(step(action, { status: "failed", detail: "此处执行失败。" }));
    expect(failed.body).toContain("未完成");
    expect(failed.body).toContain("此处执行失败");
    expect(failed.guide.nextLabel).toBe("你可以怎么做");
    expect(JSON.stringify(value)).toBe(before);
  }
  expect(explainStep(step("未知步骤")).known).toBe(false);
  expect(explainStep(step("模型请求", { status: "queued" })).current).toContain("尚未开始");
  expect(explainStep(step("认证任务交换", { status: "cancelled" })).current).toContain("已取消");
  expect(actionLabel("接收并确认输入份额")).not.toContain("车");
});

test("structured model replies and dynamic query facts remain visible without changing original messages", () => {
  const response = { facts: ["实际证据 #1"], possibleCauses: [], evidenceIds: [1] };
  const reply = step("模型响应", { kind: "model", protocolDetails: { objective: "原说明", operations: ["原经过"], sections: [{ title: "公开响应字段", data: { content: JSON.stringify(response), tool_calls: [{ function: { name: "query_events" } }] } }] } });
  const original = JSON.stringify(reply), presented = presentStep(reply);
  expect(presented.structuredAnswer).toEqual(response);
  expect(presented.nextActions).toEqual(["查询真实审计证据"]);
  expect(JSON.stringify(reply)).toBe(original);
  const query = presentStep(step("批准统计方案", { protocolDetails: { objective: "原说明", operations: [], sections: [{ title: "统计方案", data: { roads: ["S101", "S102"], start: 0, end: 60000, metrics: [{ label: "平均速度" }] } }] } }));
  expect(query.facts).toContainEqual({ label: "查询路段", value: "S101、S102" });
  expect(query.facts).toContainEqual({ label: "统计指标", value: "平均速度" });
  expect(sectionPresentation("RFC 8785 / JCS 规范化待签名字节（UTF-8）").description).toContain("实际参与签名的原文");
  expect(userFacingError("任务缺少计划要求的产物：analysis。")).toContain("证据分析");
  expect(taskRecovery("model_unavailable")).toContain("模型设置");
  const arrayReply = step("模型响应", { kind: "model", protocolDetails: { objective: "", operations: [], sections: [{ title: "公开响应字段", data: { content: '[{"facts":["事实"]}]' } }] } });
  expect(presentStep(arrayReply).structuredAnswer).toEqual([{ facts: ["事实"] }]);
  const historical = step("unknown_internal_handler", { detail: "raw developer wording" });
  expect(presentStep(historical).title).toBe("安全检查记录");
  expect(presentStep(historical).body).toContain("本条记录");
  expect(historical.detail).toBe("raw developer wording");
  const legacy = renderMarkdown("按执行契约调用 compute_statistics。原文：`compute_statistics`。", true);
  expect(legacy).toContain("本轮交付要求");
  expect(legacy).toContain("执行批准的车辆统计");
  expect(legacy).toContain("<code>compute_statistics</code>");
});
