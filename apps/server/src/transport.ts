import { connect, createServer, type TLSSocket } from "node:tls";
import { randomUUID } from "node:crypto";
import { error, type JsonObject, type SignedEnvelope, type Step, type ProtocolMaterials } from "@vectra/shared";
import { Security, authorizeTask, type Identity } from "./security";
import { Store } from "./store";
import { Audit } from "./audit";
import { identityPublic, identityPrivate, signingSections } from "./protocol";

export type Trace = (step: Partial<Step> & Pick<Step, "agent" | "action" | "detail" | "kind"> & { privateDetails?: ProtocolMaterials }) => void;
export function checkPeer(socket: TLSSocket, security: Security, expected?: string): string {
  if (!socket.authorized || socket.getProtocol() !== "TLSv1.3") throw error("tls_invalid", "TLS 1.3 双向身份认证未通过。", 403);
  const peer = socket.getPeerCertificate(), match = security.nodes().find(node => node.fingerprint === peer.fingerprint256);
  if (!match || expected && match.id !== expected) throw error("identity_mismatch", "实际 TLS 对端与登记身份不一致。", 403);
  return match.id;
}
export function receive(socket: TLSSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = "", done = false;
    const finish = (cause?: unknown, value?: unknown) => { if (done) return; done = true; socket.off("data", data); socket.off("error", fail); socket.off("close", close); cause ? reject(cause) : resolve(value); };
    const fail = () => finish(error("transport_failed", "认证连接中断。", 503));
    const close = () => { if (!done) fail(); };
    const data = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 65536) { finish(error("message_too_large", "协议消息过大。", 413)); socket.destroy(); return; }
      const end = buffer.indexOf("\n");
      if (end >= 0) { try { finish(undefined, JSON.parse(buffer.slice(0, end))); } catch { finish(error("invalid_protocol", "协议消息格式无效。", 422)); } }
    };
    socket.on("data", data); socket.once("error", fail); socket.once("close", close);
    socket.setTimeout(15_000, () => { fail(); socket.destroy(); });
  });
}
export function sessionDetails(socket: TLSSocket): JsonObject {
  const peer = socket.getPeerCertificate();
  return { protocol: socket.getProtocol(), cipher: socket.getCipher(), authorized: socket.authorized, peerSubject: peer.subject, peerIssuer: peer.issuer,
    peerFingerprint256: peer.fingerprint256, peerValidFrom: peer.valid_from, peerValidTo: peer.valid_to, ephemeralKey: socket.getEphemeralKeyInfo(),
    note: "记录实际 TLS 会话属性与证书；TLS 临时流量密钥未导出，不能用证书私钥代替流量密钥。" };
}
export async function exchange(security: Security, from: Identity, to: Identity, port: number, payload: unknown, signal?: AbortSignal, onSession?: (session: JsonObject) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, servername: to, ...security.tls(from), minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true });
    const abort = () => socket.destroy(new Error("aborted"));
    if (signal?.aborted) { socket.destroy(); reject(error("cancelled", "任务已取消。", 409)); return; }
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", () => { signal?.removeEventListener("abort", abort); reject(error("transport_failed", "认证连接失败。", 503)); });
    socket.once("secureConnect", () => {
      try {
        checkPeer(socket, security, to);
        onSession?.(sessionDetails(socket));
        const response = receive(socket); socket.write(JSON.stringify(payload) + "\n");
        response.then(resolve, reject).finally(() => { signal?.removeEventListener("abort", abort); socket.end(); });
      } catch (cause) { socket.destroy(); reject(cause); }
    });
    socket.setTimeout(15_000, () => socket.destroy(new Error("timeout")));
  });
}
export async function gateway(security: Security, store: Store, audit: Audit) {
  const sockets = new Set<TLSSocket>();
  const server = createServer({ ...security.tls("rsu"), minVersion: "TLSv1.3", maxVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: true }, socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let identity: string | null = null;
    void (async () => {
      identity = checkPeer(socket, security, "coordinator");
      const envelope = await receive(socket), message = security.verify(envelope, identity);
      if (message.type !== "task.request" || message.sender !== identity || message.recipient !== "rsu" || typeof message.messageId !== "string" || typeof message.at !== "number" || Math.abs(Date.now() - message.at) > 60_000) throw error("message_context_invalid", "消息身份、用途或新鲜性不符合要求。", 403);
      const task = authorizeTask(security, message.task);
      if (message.requestDigest !== task.requestDigest) throw error("message_context_invalid", "外层请求摘要与签名任务不一致。", 403);
      store.acceptMessage(message.messageId);
      const event = audit.append("task_authorized", { taskId: task.taskId, check: "mTLS/Ed25519/policy/replay" }, identity, identity);
      const response = security.sign("rsu", { accepted: true, taskId: task.taskId, requestDigest: message.requestDigest, eventId: event.id, messageId: message.messageId });
      socket.end(JSON.stringify(response) + "\n");
    })().catch(cause => {
      const failure = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "transport_rejected";
      try { audit.append("request_rejected", { code: failure, layer: "RSU" }, null, identity); } catch { /* Preserve original rejection if audit storage is damaged. */ }
      socket.end(JSON.stringify({ rejected: true, code: failure }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    async authorize(task: SignedEnvelope, trace: Trace, signal: AbortSignal) {
      const id = randomUUID(), digest = task.payload.requestDigest;
      trace({ id, agent: "RSU 安全网关", action: "认证任务交换", detail: "通过 TLS 1.3 双向认证发送签名任务，核对登记身份、任务策略和防重放窗口。", status: "running", kind: "exchange", sender: "coordinator", recipient: "rsu", protocol: "mTLS / Ed25519" });
      const message = security.sign("coordinator", { type: "task.request", sender: "coordinator", recipient: "rsu", messageId: randomUUID(), at: Date.now(), task, requestDigest: digest });
      trace({ agent: "coordinator", action: "封装签名授权请求", kind: "security", sender: "coordinator", recipient: "rsu", protocol: "Ed25519 / JSON Lines", detail: "将已签名任务嵌入带消息 ID、发送方、接收方和时间戳的授权请求。",
        protocolDetails: { objective: "防止任务被跨请求、跨方向替换。", operations: ["创建唯一 messageId 和发送时间。", "签署完整 task.request 外层信封。"], sections: signingSections(security, message) }, privateDetails: { sections: identityPrivate(security, "coordinator") } });
      const response = await exchange(security, "coordinator", "rsu", port, message, signal, session => {
        trace({ agent: "RSU 安全网关", action: "建立双向 TLS 会话", kind: "exchange", sender: "coordinator", recipient: "rsu", protocol: "TLS 1.3 / X.509", detail: "双方证书链与登记身份匹配后，才在该连接发送授权请求。",
          protocolDetails: { objective: "认证协议通信双方并加密传输。", operations: ["以本机 CA 验证双方 X.509 证书。", "要求 TLS 1.3，并将对端证书 SHA-256 指纹绑定到 rsu。", "协商会话密码套件并建立认证加密通道。"], sections: [{ title: "实际协商结果", data: session }, { title: "信任根 CA 证书", data: security.ca() }, ...identityPublic(security, "coordinator"), ...identityPublic(security, "rsu")], checks: [{ name: "TLS 1.3 及登记身份", status: "passed" }] },
          privateDetails: { sections: [...identityPrivate(security, "coordinator"), ...identityPrivate(security, "rsu")] } });
      });
      const receipt = security.verify(response, "rsu");
      if (!receipt.accepted || receipt.taskId !== task.payload.taskId || receipt.requestDigest !== digest || receipt.messageId !== message.payload.messageId) throw error("receipt_invalid", "RSU 回执与任务绑定不一致。", 403);
      trace({ id, agent: "RSU 安全网关", action: "认证任务交换", detail: "RSU 返回已签名的接受回执；协调器已验签并逐项核对任务与消息绑定。", status: "completed", kind: "exchange", sender: "rsu", recipient: "coordinator", protocol: "mTLS / Ed25519", evidenceIds: [Number(receipt.eventId)],
        protocolDetails: { objective: "确认 RSU 实际接受了本次唯一授权请求。", operations: ["RSU 检查消息签名、用途、方向及 60 秒新鲜性。", "校验内层任务签名、有效期和固定统计策略。", "SQLite 唯一消息 ID 检查阻止重放，追加 task_authorized 审计。", "RSU 签署接受回执，协调端复核签署者与所有绑定字段。"], sections: signingSections(security, response as SignedEnvelope), checks: ["RSU 签名", "accepted=true", "taskId", "requestDigest", "messageId"].map(name => ({ name, status: "passed" as const })) }, privateDetails: { sections: identityPrivate(security, "rsu") } });
      return receipt;
    },
    close() { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}
export type Gateway = Awaited<ReturnType<typeof gateway>>;
