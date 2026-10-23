import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { decode, CreateTaskSchema, asError, error, type Task, type ProtocolMaterials } from "@vectra/shared";
import { canonical, seal, unseal } from "../src/security";
import { shares, reconstruct, mod } from "../src/mpc/field";
import { config } from "../src/config";
import { startServer } from "../src/index";
import { runAgent } from "../src/model";
import { Collaboration, validateAnalysis } from "../src/service";
import { renderMarkdown } from "../../web/src/markdown";
import { configureFixture, fixtureRecords, installFixtureProvider } from "./fixtures";

test("shared input contracts, canonical numbers and Shamir interpolation", () => {
  expect(() => decode(CreateTaskSchema, { request: "统计", requestId: "valid-request", privateOutput: true })).toThrow();
  expect(() => canonical({ number: Number.NaN })).toThrow();
  expect(() => canonical({ number: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  const inputs = [600000n, 400000n, 200000n].map(shares);
  const summed = [0, 1, 2].map(index => mod(inputs.reduce((sum, values) => sum + values[index], 0n)));
  expect(reconstruct(summed)).toBe(1200000n);
  const key = randomBytes(32), encrypted = seal({ approved: true }, key, "test");
  expect(unseal(encrypted, key, "test")).toEqual({ approved: true });
  expect(() => unseal(encrypted, key, "wrong-context")).toThrow();
});

test("Markdown preserves formatting and cannot create executable HTML or remote images", () => {
  const html = renderMarkdown('## 结果\n\n**通过**\n\n|项目|值|\n|---|---:|\n|均值|40|\n\n```ts\nconst x = "<safe>"\n```\n\n<script>alert(1)</script>\n\n[危险](javascript:alert%281%29)\n\n![图](https://example.invalid/image.png)');
  expect(html).toContain('<h2>结果</h2>'); expect(html).toContain('class="align-right"');
  expect(html).toContain('&lt;safe&gt;'); expect(html).not.toMatch(/<script|<img|href="javascript:|style=/i);
});

test("real Bun API, three independent mTLS MPC processes, replayable events and signed reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "vectra-test-core-"));
  const live = await startServer({ ...config(), dataDir: root, logDir: join(root, "logs"), port: 0, cooldown: 0, mpcTimeout: 25000 });
  configureFixture(live.app); const restoreProvider = installFixtureProvider();
  const base = `http://127.0.0.1:${live.server.port}`;
  let cookie = "";
  const send = async (path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method, headers: { Cookie: cookie, "Content-Type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    expect((await send('/api/overview')).status).toBe(401);
    const session = await send('/api/session'); cookie = session.headers.get('set-cookie')!.split(';')[0];
    expect((await send('/api/tasks', 'POST', {}, { Origin: 'https://attacker.invalid' })).status).toBe(403);
    const request = { request: "统计 S101 平均速度", requestId: randomUUID(), intent: "statistics" };
    const created = await (await send('/api/tasks', 'POST', request)).json() as Task;
    expect(created.id).toBeTruthy();
    expect((await (await send('/api/tasks', 'POST', request)).json()).id).toBe(created.id);
    expect((await send('/api/tasks', 'POST', { ...request, request: "不同任务" })).status).toBe(409);
    let task = created;
    const deadline = Date.now() + 35000;
    while (['queued','running'].includes(task.status) && Date.now() < deadline) { await Bun.sleep(40); task = await (await send(`/api/tasks/${task.id}`)).json(); }
    expect(task.error, JSON.stringify(task.error)).toBeUndefined(); expect(task.status).toBe('completed');
    expect(task.result?.averageSpeed).toBe(40); expect(task.steps.filter(step => step.metadata.source === 'worker').length).toBeGreaterThan(8);
    expect(task.steps.every(step => step.protocolDetails?.operations.length)).toBeTrue();
    expect(task.steps.every(step => Number.isInteger(step.phase) && step.phase! >= 1 && step.phase! <= 8)).toBeTrue();
    expect([...new Set(task.steps.map(step => step.phase))].sort()).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(task.steps.find(step => step.action === '生成秘密分享多项式')?.phase).toBe(4);
    expect(task.steps.find(step => step.action === '发送输入份额并核对回执')?.phase).toBe(5);
    expect(task.steps.find(step => step.action === '重构总和并签署批准输出')?.phase).toBe(6);
    expect(task.steps.find(step => step.action === '证据分析完成')?.phase).toBe(7);
    expect(task.steps.find(step => step.action === '报告规范化与签名')?.phase).toBe(8);
    const inputStep = task.steps.find(step => step.agent === 'vehicle-a' && step.action === '任务与本地输入认证')!;
    const materialPath = `/api/tasks/${task.id}/steps/${inputStep.id}/materials`;
    expect((await send(materialPath, 'GET', undefined, { Origin: 'https://attacker.invalid' })).status).toBe(403);
    expect((await send(materialPath, 'GET', undefined, { 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    const materials = await (await send(materialPath)).json() as ProtocolMaterials;
    const privateKey = readFileSync(join(root, 'pki', 'vehicle-a', 'signing.key'), 'utf8');
    expect(materials.sections.some(section => section.data === privateKey)).toBeTrue();
    expect(materials.sections.some(section => (section.data as any)?.speed === 60)).toBeTrue();
    const polynomialStep = task.steps.find(step => step.agent === 'vehicle-a' && step.action === '生成秘密分享多项式')!;
    const polynomialMaterials = await (await send(`/api/tasks/${task.id}/steps/${polynomialStep.id}/materials`)).json() as ProtocolMaterials;
    const polynomial = polynomialMaterials.sections[0].data as any;
    expect(polynomial.shares.map((share: any) => share.value)).toEqual([1n, 2n, 3n].map(x => mod(BigInt(polynomial.secret) + BigInt(polynomial.coefficient) * x).toString()));
    const privateRows = live.app.store.db.query<{ envelope: string }, []>('SELECT envelope FROM protocol_materials').all();
    expect(privateRows.length).toBeGreaterThan(20);
    expect(privateRows.every(row => !row.envelope.includes(privateKey) && !row.envelope.includes(polynomial.coefficient))).toBeTrue();
    const events = live.app.store.events(0, 500);
    const publicText = JSON.stringify([task, events]);
    expect(publicText.includes(privateKey) || publicText.includes(polynomial.coefficient)).toBeFalse();
    const diagnosticText = ['conversations', 'operations'].flatMap(channel => readdirSync(join(root, 'logs', channel)).filter(name => name.endsWith('.jsonl')).map(name => readFileSync(join(root, 'logs', channel, name), 'utf8'))).join('');
    expect(diagnosticText.includes(privateKey) || diagnosticText.includes(polynomial.coefficient)).toBeFalse();
    const started = events.find(event => event.type === 'step.created' && (event.payload.step as any).action === '三方秘密分享计算');
    expect(started).toBeTruthy();
    expect(events.some(event => event.type === 'step.updated' && (event.payload.step as any).id === (started!.payload.step as any).id && (event.payload.step as any).status === 'completed')).toBeTrue();
    expect(() => live.app.store.db.exec('DELETE FROM events')).toThrow();
    const report = await (await send(`/api/reports/${task.id}`)).json();
    expect((await (await send('/api/reports/verify', 'POST', { envelope: report })).json()).valid).toBeTrue();
    report.payload.summary += '篡改';
    expect((await (await send('/api/reports/verify', 'POST', { envelope: report })).json()).valid).toBeFalse();
    const replay = await send(`/api/events?after=${started!.id - 1}`);
    const reader = replay.body!.getReader(), first = new TextDecoder().decode((await reader.read()).value); await reader.cancel();
    expect(first).toContain(`id: ${started!.id}`);
    expect((await send('/api/experiments', 'POST', {})).status).toBe(404);
    const follow = await (await send('/api/tasks', 'POST', { request: '解释上一轮结果', requestId: randomUUID(), conversationId: task.conversationId, intent: 'explain' })).json() as Task;
    await Bun.sleep(100); expect(live.app.store.task(follow.id)?.summary).toContain('40.00');
    const persisted = live.app.store.cursor();
    await live.close();
    const restarted = await startServer({ ...config(), dataDir: root, logDir: join(root, "logs"), port: 0, cooldown: 0 });
    expect(restarted.app.store.task(task.id)?.status).toBe('completed'); expect(restarted.app.store.cursor()).toBeGreaterThanOrEqual(persisted);
    expect(restarted.app.protocolMaterials(task.id, inputStep.id).sections.some(section => section.data === privateKey)).toBeTrue();
    expect(restarted.app.audit.verify().valid).toBeTrue(); await restarted.close();
  } finally {
    await live.close(); restoreProvider();
    if (resolve(root).startsWith(resolve(tmpdir(), 'vectra-test-core-'))) rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test("model requests use approved tools, redact credentials and honor typed completion", async () => {
  const original = globalThis.fetch;
  let round = 0, handled = false;
  globalThis.fetch = (async (_input: unknown, options: RequestInit) => {
    const request = JSON.parse(String(options.body)); expect(request.messages.some((message: any) => 'reasoning_content' in message)).toBeFalse();
    if (request.tools.some((t: any) => t.function.name === 'submit_statistics_plan')) return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'submit_statistics_plan', arguments: JSON.stringify({ roads: ['S101'], start: Date.now() - 60000, end: Date.now(), timeZone: 'Asia/Shanghai', metrics: [{ label: '平均速度', operation: 'mean', field: 'speed' }] }) } }] } }] });
    return Response.json({ choices: [{ message: ++round === 1 ? { role: 'assistant', content: '读取身份', reasoning_content: 'must-never-persist', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'identity_status', arguments: '{}' } }] } : { role: 'assistant', content: '## 完成\nsecret-key' } }] });
  }) as typeof fetch;
  try {
    const progress: unknown[] = [];
    const result = await Effect.runPromise(runAgent({ mode: 'llm', provider: 'custom', baseUrl: 'https://example.invalid/v1', model: 'test', apiKey: 'secret-key' }, '查看身份', [], { identity_status: { description: 'identity', parameters: { type: 'object' }, execute: async () => { handled = true; return { verified: true }; } } }, step => progress.push(step), new AbortController().signal));
    expect(handled).toBeTrue(); expect(result).toContain('[凭据已隐藏]'); expect(JSON.stringify(progress)).not.toContain('must-never-persist');
    const folder = mkdtempSync(join(tmpdir(), 'vectra-test-contract-'));
    const app = await Collaboration.open({ ...config(), dataDir: folder, logDir: join(folder, "logs"), cooldown: 0 });
    app.telemetry.import(fixtureRecords());
    try {
      app.settings.save({ mode:'llm', provider:'custom', baseUrl:'https://example.invalid/v1', model:'test', apiKey:'secret-key' });
      const task = app.submit({ request:'统计平均速度', requestId:randomUUID(), intent:'statistics' });
      const deadline = Date.now()+2000;
      while (['queued','running'].includes(app.store.task(task.id)!.status) && Date.now()<deadline) await Bun.sleep(10);
      expect(app.store.task(task.id)?.status).toBe('failed');
      expect(app.store.task(task.id)?.error?.code).toBe('contract_incomplete');
      expect(app.store.report(task.id)).toBeUndefined();
      // Reproduce the formerly failing statistics/report sequence with a real MPC run and a mock model.
      globalThis.fetch = Object.assign(async (_input: unknown, options: RequestInit) => {
        const payload = JSON.parse(String(options.body)), names = payload.tools.map((tool: any) => tool.function.name);
        const last = payload.messages.at(-1);
        const call = (name: string, args: unknown = {}) => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
        if (names.includes('submit_statistics_plan')) return call('submit_statistics_plan', { roads: ['S101'], start: Date.now()-60000, end: Date.now(), timeZone: 'Asia/Shanghai', metrics: [{ label: '平均速度', operation: 'mean', field: 'speed' }] });
        if (names.includes('submit_analysis')) {
          if (last.role === 'user') return call('query_events');
          const queried = JSON.parse(last.content);
          return call('submit_analysis', { facts: ['真实统计已经完成。'], possibleCauses: [], recommendations: ['保存报告'], uncertainties: ['输入来自预置数据'], evidenceIds: [queried.events[0].id] });
        }
        expect(names).not.toContain('verify_latest_report');
        if (last.role === 'user') return call('compute_statistics');
        if (!payload.messages.some((message: any) => message.tool_calls?.some((item: any) => item.function.name === 'investigate'))) return call('investigate');
        return Response.json({ choices: [{ message: { role: 'assistant', content: '## 统计完成\n\n实际均值 **40 km/h**。' } }] });
      }, { preconnect: original.preconnect }) as typeof fetch;
      const success = app.submit({ request:'统计 S101 路段过去 60 秒的平均速度，保护车辆输入并生成签名报告。', requestId:randomUUID(), intent:'statistics' });
      const completedBy = Date.now() + 25000;
      while (['queued','running'].includes(app.store.task(success.id)!.status) && Date.now() < completedBy) await Bun.sleep(20);
      const completed = app.store.task(success.id)!;
      expect(completed.error, JSON.stringify(completed.error)).toBeUndefined(); expect(completed.status).toBe('completed');
      expect(completed.result?.averageSpeed).toBe(40); expect(app.verifyReport(app.report(success.id)).valid).toBeTrue();
      expect(completed.steps.some(step => step.action === 'submit_analysis' && step.status === 'completed')).toBeTrue();
      expect(completed.steps.filter(step => step.action === 'query_events' && step.status === 'completed')).toHaveLength(1);
      expect(completed.steps.filter(step => step.action === 'submit_analysis' && step.status === 'completed')).toHaveLength(1);
      expect(completed.steps.filter(step => step.action === '模型请求').every(step => step.protocolDetails?.sections?.some(section => section.title === '实际请求正文'))).toBeTrue();
    } finally { await app.close(); rmSync(folder,{recursive:true,force:true}); }
  } finally { globalThis.fetch = original; }
}, 30000);

test("analysis submission rejects missing queries, malformed fields and fabricated evidence with actionable reasons", async () => {
  const analysis = { facts: ['事实'], possibleCauses: [], recommendations: [], uncertainties: [], evidenceIds: [12] };
  expect(validateAnalysis(analysis, true, new Set([12]))).toEqual(analysis);
  expect(() => validateAnalysis(analysis, false, new Set([12]))).toThrow('必须先调用');
  expect(() => validateAnalysis({ ...analysis, facts: '错误类型' }, true, new Set([12]))).toThrow('facts 必须');
  expect(() => validateAnalysis(analysis, true, new Set([13]))).toThrow('evidenceIds 必须');
  try { await Effect.runPromise(Effect.fail(error('analysis_invalid', '具体证据错误', 422))); }
  catch (cause) { expect(asError(cause).code).toBe('analysis_invalid'); expect(asError(cause).message).toBe('具体证据错误'); }
});
