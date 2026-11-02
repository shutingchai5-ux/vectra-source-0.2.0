import { createServer, type TLSSocket } from "node:tls";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PARTICIPANTS, error, type ProtocolDetails, type ProtocolSection } from "@vectra/shared";
import { authorizeTask, atomicWrite, canonical, Security, seal, unseal } from "../security";
import { identityPrivate, identityPublic, signingSections } from "../protocol";
import { checkPeer, exchange, receive, sessionDetails } from "../transport";
import { mod, parseField, reconstruct, polynomialShares, randomField, PRIME } from "./field";
import { readTelemetry } from "../telemetry";
import { projectParkVisits, readParkCatalog, readParkVisits } from "../park";
import { localVector, finishVector, validateQuery } from "../statistics";
import { readReservationCatalog, readReservationSlots, projectReservations } from "../reservations";
import { reservationContextFor } from "@vectra/shared";

const [root, own, taskFile] = process.argv.slice(2);
if (!root || !PARTICIPANTS.includes(own as typeof PARTICIPANTS[number]) || !taskFile) process.exit(2);
const id = own as typeof PARTICIPANTS[number], ownIndex = PARTICIPANTS.indexOf(id);
const security = await Security.open(root), signed = JSON.parse(readFileSync(taskFile, "utf8"));
const task = authorizeTask(security, signed), taskId = String(task.taskId);
const query = validateQuery(task.statistics);
const parkCatalog = query.dataset === "park_visits" ? readParkCatalog(security, String(task.datasetVersion)) : undefined;
const reservationCatalog = query.dataset === "reservation_plans" ? readReservationCatalog(security, String(task.datasetVersion)) : undefined;
if (parkCatalog && canonical(task.parkContext) !== canonical({ settings: parkCatalog.settings, dataUpdatedAt: parkCatalog.updatedAt })) throw error("unauthorized", "任务中的园区及承运商范围与冻结快照不一致。", 403);
if (parkCatalog) validateQuery(query, parkCatalog);
if (reservationCatalog) {
  validateQuery(query, reservationCatalog);
  if (canonical(task.parkContext) !== canonical({ settings: reservationCatalog.settings, dataUpdatedAt: reservationCatalog.updatedAt }) ||
    canonical(task.reservationContext) !== canonical(reservationContextFor(reservationCatalog.capacitySlots, query))) throw error("unauthorized", "预约容量或园区上下文与冻结快照不一致。", 403);
}
const visits = parkCatalog ? readParkVisits(security, String(task.datasetVersion), id) : undefined;
const slots = reservationCatalog ? readReservationSlots(security, String(task.datasetVersion), id) : undefined;
const records = slots ? projectReservations(slots) : visits ? projectParkVisits(visits, query) : readTelemetry(security, String(task.datasetVersion), id), inputKey = readFileSync(join(root, id, "input.key"));
const selected = records.filter(r => query.roads.includes(r.road) && r.recordedAt >= query.start && r.recordedAt < query.end);
const selectedVisits = visits?.filter(v => { const at = query.cohort === "departures" ? v.departedAt : v.arrivedAt; return at !== undefined && query.roads.includes(v.road) && at >= query.start && at < query.end; });
const selectedSlots = slots?.filter(slot => query.roads.includes(slot.road) && slot.slotStart >= query.start && slot.slotStart < query.end);
const encoded = localVector(records, query), slopes = encoded.map(() => randomField());
const ownShares = encoded.map((value, i) => polynomialShares(value, slopes[i]));
const incoming = new Map<string, bigint[]>([[id, ownShares.map(shares => shares[ownIndex])]]);
const aggregates = new Map<string, bigint[]>();
const parseVector = (value: unknown) => { if (!Array.isArray(value) || value.length !== encoded.length) throw new Error("Invalid vector dimensions"); return value.map(parseField); };
const sockets = new Set<TLSSocket>();
const progress = (action: string, detail: string, kind = "mpc", recipient = "mpc", protocolDetails?: ProtocolDetails, sections: ProtocolSection[] = []) => {
  const traceId = randomUUID();
  // Private numerical transcripts never travel on stdout or diagnostic events.
  if (sections.length) atomicWrite(join(dirname(taskFile), `trace-${id}-${traceId}.enc.json`), canonical(seal({ sections }, security.storageKey(), `worker-protocol:${taskId}:${traceId}`)));
  const receiving = action.startsWith("接收并");
  console.log(JSON.stringify({ type: "progress", traceId, hasPrivateDetails: sections.length > 0, agent: id, action, detail, kind, sender: receiving ? recipient : id, recipient: receiving ? id : recipient, protocol: "TLS 1.3 / Shamir m=3 t=1", protocolDetails }));
};
const waitFor = async (ready: () => boolean) => { const end = Date.now() + 15_000; while (!ready()) { if (Date.now() > end) throw error("party_timeout", "三方协议等待超时。", 503); await Bun.sleep(10); } };
progress("任务与本地输入认证", reservationCatalog ? "本承运商认证解密自己的预约需求与运力申报，按计划时段开始时间筛选；核对冻结的园区容量，不把申报计划当作实际车次。" : parkCatalog ? "本承运商认证解密自己的车次快照，按批准的到达或离园时间选取车次；仅在本地计算承运商待发、运输、园外及园区各环节时长。" : "本承运商协作节点认证解密已绑定版本的车辆记录，按批准路段与起止时间实际筛选样本。", "security", "mpc",
  { objective: "用真实时间序列执行批准的统计方案。", operations: ["验证园区协调 Agent 签名、数据版本和受控指标。", "认证解密本承运商协作节点独立数据快照。", "按 start≤recordedAt<end 筛选路段和时间；缺失字段不补零。"], sections: [{ title: "批准范围", data: { query, datasetVersion: task.datasetVersion, actualTimeFilter: true } }, ...identityPublic(security, id)], checks: [{ name: "任务授权及输入认证", status: "passed" }] },
  [{ title: reservationCatalog ? "本承运商预约需求与可投入运力" : parkCatalog ? "本承运商完整车次与本地派生值" : "车辆完整原始输入", data: selectedSlots ? { slots: selectedSlots, records: selected } : selectedVisits ? { visits: selectedVisits, records: selected } : { speed: selected[0]?.speed ?? null, records: selected } }, { title: "输入 AES-256 密钥（hex）", data: inputKey.toString("hex") }, ...identityPrivate(security, id)]);
progress("生成秘密分享多项式", "在本承运商协作节点计算计数、总和、平方和或分母；为向量每一项独立生成随机系数和三份秘密份额。", "mpc", "mpc",
  { objective: "对每个指标的必要充分统计量执行秘密分享。", operations: ["原始数值以 10000 倍定点编码；平方和使用编码值的平方。", "每个向量分量独立采样随机系数，避免复用随机性。", "按道路、指标排列计数/总和/平方和/分母；园区查询每条道路额外分享总车次、已完成、未完成及有数据承运商计数。"], sections: [{ title: "公开计算约定", data: { prime: PRIME.toString(), degree: 1, scale: 10000, dimensions: encoded.length, mathematicalThreshold: 2, executionRequiresAllThree: true } }] },
  [{ title: "实际多项式与全部份额", data: { secret: encoded[1].toString(), coefficient: slopes[1].toString(), shares: PARTICIPANTS.map((recipient, i) => ({ recipient, x: i + 1, value: ownShares[1][i].toString() })), components: encoded.map((v, i) => ({ index: i, secret: v.toString(), coefficient: slopes[i].toString(), shares: ownShares[i].map(String) })) } }]);
const server = createServer({ ...security.tls(id), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, socket => {
  sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
  void (async () => {
    const peer = checkPeer(socket, security);
    if (!PARTICIPANTS.includes(peer as typeof id) || peer === id) throw new Error("Unapproved MPC peer");
    const message = await receive(socket) as { taskId: string; type: string; shares: unknown };
    if (message.taskId !== taskId) throw new Error("Task binding mismatch");
    if (message.type === "share") {
      if (incoming.has(peer)) throw new Error("Duplicate share");
      incoming.set(peer, parseVector(message.shares));
    } else if (message.type === "aggregate" && ownIndex === 0) {
      if (aggregates.has(peer)) throw new Error("Duplicate output share");
      aggregates.set(peer, parseVector(message.shares));
    } else throw new Error("Protocol direction rejected");
    const receipt = { accepted: true, taskId };
    progress(message.type === "share" ? "接收并确认输入份额" : "接收并确认聚合份额", `收到 ${peer} 的协议消息，完成校验并发送接受回执。`, "exchange", peer,
      { objective: "认证接收对端的实际份额消息。", operations: ["核对 TLS 登记身份、任务 ID 和协议方向。", "检查份额属于有限域且未重复提交。", "存入本承运商协作节点内存并回复 accepted。"], sections: [{ title: "实际接入会话", data: sessionDetails(socket) }], checks: ["登记身份", "任务绑定", "去重", "有限域范围"].map(name => ({ name, status: "passed" as const })) },
      [{ title: "收到的完整协议消息", data: { from: peer, to: id, message } }, { title: "发送的回执", data: receipt }]);
    socket.end(JSON.stringify(receipt) + "\n");
  })().catch(() => socket.destroy());
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
console.log(JSON.stringify({ type: "ready", agent: id, port: (server.address() as { port: number }).port }));
const shutdown = () => { for (const socket of sockets) socket.destroy(); server.close(); };
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
try {
  // Endpoints are public coordination data received on stdin, never input/share material.
  let stdin = "";
  for await (const chunk of Bun.stdin.stream()) { stdin += new TextDecoder().decode(chunk); if (stdin.includes("\n")) break; }
  const peers = JSON.parse(stdin.trim()) as Record<string, number>;
  progress("接收节点端点表", "三个独立进程均已启动，开始建立逐对认证连接。", "exchange", "mpc",
    { objective: "发现其他承运商协作节点。", operations: ["从园区协调 Agent stdin 读取公开端点。", "端口仅用于寻址，后续身份由证书验证。"], sections: [{ title: "实际端点", data: peers }] });
  await Promise.all(PARTICIPANTS.map(async (peer, index) => {
    if (peer === id) return;
    const message = { taskId, type: "share", shares: ownShares.map(shares => shares[index].toString()) };
    let session: unknown;
    const receipt = await exchange(security, id, peer, peers[peer], message, undefined, value => { session = value; }) as { accepted: boolean; taskId: string };
    if (!receipt.accepted || receipt.taskId !== taskId) throw new Error("Invalid share receipt");
    progress("发送输入份额并核对回执", `将 f(${index + 1}) 发送给 ${peer}，核对同一任务的 accepted 回执。`, "exchange", peer,
      { objective: "向登记节点交付它对应的实际输入份额。", operations: ["协商 TLS 1.3，验证证书链和登记指纹。", "发送换行分隔 JSON 份额消息。", "核对返回的 accepted 和 taskId。"], sections: [{ title: "实际协商会话", data: session }], checks: [{ name: "确认回执绑定", status: "passed" }] },
      [{ title: "发送的完整份额消息", data: { from: id, to: peer, x: index + 1, message } }, { title: "实际接收回执", data: receipt }]);
  }));
  await waitFor(() => incoming.size === 3);
  const aggregate = encoded.map((_, index) => mod([...incoming.values()].reduce((sum, value) => sum + value[index], 0n)));
  progress("计算本地聚合份额", "三个来源的输入份额全部到齐，计算本承运商协作节点的有限域聚合值。", "mpc", "mpc",
    { objective: "在本承运商协作节点横坐标上聚合三方份额。", operations: ["等待包含本车份额在内的三个输入。", "G(x)=Σ f_i(x) mod p。"], sections: [{ title: "聚合规则", data: { x: ownIndex + 1, prime: PRIME.toString(), inputs: incoming.size } }] },
    [{ title: "聚合运算实际数值", data: { x: ownIndex + 1, incoming: [...incoming].map(([from, value]) => ({ from, values: value.map(String) })), aggregate: aggregate.map(String) } }]);
  if (ownIndex === 0) {
    aggregates.set(id, aggregate);
    await waitFor(() => aggregates.size === 3);
    const totals = encoded.map((_, i) => reconstruct(PARTICIPANTS.map(peer => aggregates.get(peer)![i])));
    const groups = finishVector(totals, query);
    const output = security.sign(id, { taskId, requestDigest: task.requestDigest, road: task.road, windowSeconds: task.windowSeconds, datasetVersion: task.datasetVersion, ...(task.parkContext ? { parkContext: task.parkContext } : {}), ...(task.reservationContext ? { reservationContext: task.reservationContext } : {}), query, groups, participantCount: 3, protocol: "Shamir vector m=3 t=1 / TLS 1.3" });
    progress("重构总和并签署批准输出", "重构各指标充分统计量，计算批准的结果并将方案和数据版本一同签名。", "mpc", "mpc",
      { objective: "输出与请求、统计方案和数据快照绑定的指标结果。", operations: ["逐分量执行 (3G(1)-3G(2)+G(3)) mod p。", "使用有效样本数计算均值、总体方差、标准差和比例；分母为零返回无数据。", "以 carrier-a 身份签署完整结果。"], sections: signingSections(security, output), checks: [{ name: "三方齐全及输出范围", status: "passed" }] },
      [{ title: "完整重构数值", data: { totals: totals.map(String), coefficients: [3, -3, 1], prime: PRIME.toString(), groups } }, ...identityPrivate(security, id)]);
    console.log(JSON.stringify({ type: "result", envelope: output }));
  } else {
    const message = { taskId, type: "aggregate", shares: aggregate.map(String) };
    let session: unknown;
    const receipt = await exchange(security, id, "carrier-a", peers["carrier-a"], message, undefined, value => { session = value; }) as { accepted: boolean; taskId: string };
    if (!receipt.accepted || receipt.taskId !== taskId) throw new Error("Output receipt rejected");
    progress("发送聚合份额并确认", "将实际聚合份额发给 carrier-a，核对接受回执与任务绑定。", "exchange", "carrier-a",
      { objective: "交付重构输出所需的聚合份额。", operations: ["认证 carrier-a 并建立 TLS 1.3 连接。", "发送 type=aggregate 消息。", "核对 accepted=true 及 taskId。"], sections: [{ title: "实际协商会话", data: session }] },
      [{ title: "完整聚合份额消息", data: message }, { title: "实际回执", data: receipt }]);
  }
  progress("协议完成", "本车收发与计算完成，本机实验详情保留完整数值；公开协议输出只包含批准聚合结果。", "mpc", "mpc",
    { objective: "结束本承运商协作节点协议生命周期。", operations: ["确认本承运商协作节点必要收发已完成。", "关闭 TLS 监听及剩余连接。"], sections: [{ title: "节点状态", data: { id, receivedInputShares: incoming.size, x: ownIndex + 1 } }] });
  shutdown();
} catch {
  console.log(JSON.stringify({ type: "failed", agent: id, code: "mpc_party_failed" })); shutdown(); process.exitCode = 1;
}
