import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PARTICIPANTS, error, type Aggregate, type SignedEnvelope, type StepKind, type ProtocolDetails, type ProtocolMaterials, type RoadStatistics } from "@vectra/shared";
import { Security, canonical, unseal } from "../security";
import { signingSections } from "../protocol";
import type { Trace } from "../transport";
import { validateQuery } from "../statistics";
import { resolveStepPhase } from "@vectra/shared";

export class MpcRunner {
  private active = false;
  private taskId: string | undefined;
  private children: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>[] = [];
  constructor(private security: Security, private dataDir: string, private timeout: number) {}
  async close() { for (const child of this.children) if (child.exitCode === null) child.kill(); while (this.active) await Bun.sleep(10); }
  async waitForTask(taskId: string) { while (this.active && this.taskId === taskId) await Bun.sleep(10); }
  async run(task: SignedEnvelope, trace: Trace, signal: AbortSignal): Promise<Aggregate> {
    if (this.active) throw error("mpc_busy", "隐私计算执行通道繁忙。", 409);
    const parent = join(this.dataDir, "mpc-runs"); mkdirSync(parent, { recursive: true, mode: 0o700 });
    const workspace = mkdtempSync(join(parent, "task-")), taskFile = join(workspace, "task.json");
    writeFileSync(taskFile, canonical(task), { mode: 0o600 });
    this.active = true; this.taskId = String(task.payload.taskId);
    const children: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>[] = [];
    this.children = children;
    const peers: Record<string, number> = {};
    const results: SignedEnvelope[] = [];
    let rejectProtocol: (cause: unknown) => void = () => {};
    const failed = new Promise<never>((_, reject) => { rejectProtocol = reject; });
    // Attach immediately so cancellation before the later Promise.race is handled.
    void failed.catch(() => {});
    const abort = () => rejectProtocol(error("cancelled", "任务已取消，三方进程正在停止。", 409));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => rejectProtocol(error("mpc_timeout", "三方协议超时，未发布统计结果。", 504)), this.timeout);
    const readers: Promise<void>[] = [];
    let finished = false;
    try {
      if (signal.aborted) throw error("cancelled", "任务已取消。", 409);
      for (const id of PARTICIPANTS) {
        const worker = fileURLToPath(new URL("./party.ts", import.meta.url));
        const child = Bun.spawn([process.execPath, "--no-env-file", worker, this.security.root, id, taskFile], {
          cwd: workspace, stdin: "pipe", stdout: "pipe", stderr: "pipe",
          env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: workspace, TMP: workspace },
        });
        children.push(child);
        const reader = (async () => {
          const decoder = new TextDecoder(); let buffer = "";
          for await (const chunk of child.stdout) {
            buffer += decoder.decode(chunk, { stream: true });
            if (buffer.length > 131072) throw error("mpc_protocol", "工作进程公开输出超限。", 500);
            let end: number;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              let message: Record<string, unknown>; try { message = JSON.parse(line); } catch { throw error("mpc_protocol", "工作进程返回无效公开消息。", 500); }
              if (message.type === "ready") {
                if (message.agent !== id || peers[id] || !Number.isInteger(message.port) || Number(message.port) < 1024 || Number(message.port) > 65535) throw error("mpc_protocol", "工作进程端点无效。", 500);
                peers[id] = Number(message.port);
              } else if (message.type === "progress") {
                const kinds: StepKind[] = ["security", "exchange", "mpc"];
                if (message.agent !== id || typeof message.action !== "string" || typeof message.detail !== "string" || !kinds.includes(message.kind as StepKind) || message.action.length > 100 || message.detail.length > 1000) throw error("mpc_protocol", "工作进程进度结构无效。", 500);
                if (typeof message.traceId !== "string" || !/^[a-f0-9-]{36}$/.test(message.traceId)) throw error("mpc_protocol", "工作进程详情编号无效。", 500);
                const privateDetails = message.hasPrivateDetails ? unseal(JSON.parse(readFileSync(join(workspace, `trace-${id}-${message.traceId}.enc.json`), "utf8")), this.security.storageKey(), `worker-protocol:${task.payload.taskId}:${message.traceId}`) as ProtocolMaterials : undefined;
                trace({ id: message.traceId, phase: resolveStepPhase({ agent: id, action: message.action, kind: message.kind as StepKind }), agent: id, action: message.action, detail: message.detail, kind: message.kind as StepKind, sender: typeof message.sender === "string" && PARTICIPANTS.includes(message.sender as typeof id) ? message.sender : id,
                  recipient: typeof message.recipient === "string" && [...PARTICIPANTS, "mpc"].includes(message.recipient) ? message.recipient : "mpc", protocol: "TLS 1.3 / Shamir m=3 t=1", metadata: { source: "worker" },
                  protocolDetails: message.protocolDetails as ProtocolDetails | undefined, ...(privateDetails ? { privateDetails } : {}) });
              } else if (message.type === "result") {
                if (id !== "vehicle-a") throw error("mpc_protocol", "非授权节点尝试输出。", 403);
                results.push(message.envelope as SignedEnvelope);
              } else if (message.type === "failed") throw error("mpc_party_failed", "参与节点未完成真实三方协议。", 503);
              else throw error("mpc_protocol", "收到未批准的工作进程消息。", 500);
            }
          }
        })();
        readers.push(reader); void reader.catch(rejectProtocol);
        // Drain diagnostics without persisting possible input or credential material.
        void new Response(child.stderr).text();
        void child.exited.then(code => { if (code !== 0) rejectProtocol(error("mpc_party_failed", "参与节点异常退出。", 503)); });
      }
      await Promise.race([(async () => { while (!finished && Object.keys(peers).length < 3) await Bun.sleep(10); })(), failed]);
      trace({ phase: 4, agent: "隐私计算执行器", action: "三方进程端点就绪", kind: "exchange", protocol: "Bun 子进程 / stdin", detail: "三个独立进程已分别报告真实监听端口，执行器将公开端点映射发送给每个参与者。",
        protocolDetails: { objective: "启动真实三方协议。", operations: ["启动三个独立 Bun 进程，不继承模型凭据。", "等待全部 ready 消息。", "向各进程 stdin 发送端点表。"], sections: [{ title: "实际进程及端点", data: PARTICIPANTS.map((id, index) => ({ id, pid: children[index].pid, host: "127.0.0.1", port: peers[id] })) }] } });
      for (const child of children) { child.stdin.write(JSON.stringify(peers) + "\n"); child.stdin.end(); }
      await Promise.race([Promise.all([...readers, ...children.map(child => child.exited)]), failed]);
      if (results.length !== 1) throw error("mpc_output_missing", "三方协议未返回唯一批准输出。", 503);
      const payload = this.security.verify(results[0], "vehicle-a");
      const query = validateQuery(task.payload.statistics), groups = payload.groups as RoadStatistics[];
      if (payload.taskId !== task.payload.taskId || payload.requestDigest !== task.payload.requestDigest || payload.road !== task.payload.road || payload.windowSeconds !== task.payload.windowSeconds || payload.datasetVersion !== task.payload.datasetVersion || canonical(payload.query) !== canonical(query) || payload.participantCount !== 3 || !Array.isArray(groups) || groups.length !== query.roads.length || groups.some((g, i) => g.road !== query.roads[i] || !Array.isArray(g.metrics) || g.metrics.length !== query.metrics.length || g.metrics.some((m, j) => m.label !== query.metrics[j].label || m.value !== null && (typeof m.value !== "number" || !Number.isFinite(m.value)) || !Number.isSafeInteger(m.validSamples) || m.validSamples < 0 || m.validSamples > 6000))) throw error("mpc_output_invalid", "批准输出与任务绑定或范围不一致。", 403);
      trace({ phase: 6, agent: "隐私计算执行器", action: "复核三方输出签名与绑定", kind: "security", protocol: "Ed25519 / 任务绑定", detail: "工作进程全部完成且输出唯一，vehicle-a 签名、请求摘要及统计范围校验通过。",
        protocolDetails: { objective: "防止协调端接受伪造或跨任务输出。", operations: ["要求三个进程正常结束且仅 vehicle-a 输出一次。", "用登记公钥验证输出 Ed25519 签名。", "比较任务、请求摘要、路段、窗口、人数和数值范围。"], sections: signingSections(this.security, results[0]), checks: [{ name: "唯一合法输出及完整绑定", status: "passed" }] } });
      const meanIndex = query.metrics.findIndex(m => m.operation === "mean" && m.field === "speed" && !m.filter);
      const averageSpeed = groups.length === 1 && meanIndex >= 0 ? groups[0].metrics[meanIndex].value : null;
      return { road: String(payload.road), windowSeconds: Number(payload.windowSeconds), ...(averageSpeed === null ? {} : { averageSpeed }), query, groups, datasetVersion: String(payload.datasetVersion), participantCount: 3, protocol: "Shamir vector m=3 t=1 / TLS 1.3" };
    } finally {
      finished = true;
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled(children.map(child => child.exited));
      await Promise.allSettled(readers);
      this.active = false; this.taskId = undefined; this.children = [];
      if (resolve(workspace).startsWith(resolve(parent) + (process.platform === "win32" ? "\\" : "/"))) rmSync(workspace, { recursive: true, force: true });
    }
  }
}
