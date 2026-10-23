import { Data, Schema, Cause, Runtime } from "effect";
export { sanitizeLogValue } from "./log-redaction";
export { TIME_ZONE, shanghaiTime, shanghaiDay, shanghaiDayIndex, shanghaiTimestamp, shanghaiDateTime } from "./time";
export * from "./statistics";
export * from "./workflow";
export * from "./model-options";
import type { ThinkingProtocol } from "./model-options";
import type { ConversationPhase } from "./workflow";
import type { StatisticsQuery, RoadStatistics } from "./statistics";

export const VERSION = "1.0.3";
export const PARTICIPANTS = ["vehicle-a", "vehicle-b", "vehicle-c"] as const;
export type Participant = typeof PARTICIPANTS[number];
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type StepKind = "model" | "tool" | "security" | "exchange" | "mpc" | "report" | "analysis";
export type Intent = "statistics" | "investigation" | "verification" | "explain";
export type JsonObject = Record<string, unknown>;

export class AppError extends Data.TaggedError("AppError")<{
  code: string; message: string; status: number; cause?: unknown;
}> {}
export const error = (code: string, message: string, status = 400, cause?: unknown) => new AppError({ code, message, status, ...(cause === undefined ? {} : { cause }) });
export const asError = (cause: unknown): AppError => {
  const original = cause;
  for (let depth = 0; depth < 8; depth++) {
    if (cause instanceof AppError) return cause;
    if (!Runtime.isFiberFailure(cause)) break;
    cause = Cause.squash(cause[Runtime.FiberFailureCauseId]);
  }
  return error("internal_error", "操作失败，请查看服务端诊断。", 500, original);
};

const Text = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000));
export const CreateTaskSchema = Schema.Struct({
  request: Text,
  requestId: Schema.String.pipe(Schema.pattern(/^[a-zA-Z0-9_-]{8,100}$/)),
  conversationId: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-zA-Z0-9_-]{8,100}$/))),
  intent: Schema.optional(Schema.Literal("auto", "statistics", "investigation", "verification", "explain")),
});
export type CreateTask = Schema.Schema.Type<typeof CreateTaskSchema>;
export const ModelSettingsSchema = Schema.Struct({
  mode: Schema.optional(Schema.Literal("llm")),
  provider: Schema.Literal("openai", "deepseek", "qwen", "custom"),
  baseUrl: Schema.String.pipe(Schema.maxLength(2048)),
  model: Schema.String.pipe(Schema.maxLength(200)),
  apiKey: Schema.optional(Schema.String.pipe(Schema.maxLength(4096))),
  clearApiKey: Schema.optional(Schema.Boolean),
  deepThinking: Schema.optional(Schema.Boolean),
  thinkingProtocol: Schema.optional(Schema.Literal("auto", "deepseek", "qwen", "openai")),
});
export type ModelSettingsInput = Schema.Schema.Type<typeof ModelSettingsSchema>;
export const ClientLogSchema = Schema.Struct({
  event: Schema.Literal("navigation", "conversation.new", "conversation.open", "conversation.delete", "message.submit", "task.cancel", "connection.changed", "ui.error", "ui.unhandled_rejection", "api.failed"),
  route: Schema.String.pipe(Schema.maxLength(300)),
  clientTime: Schema.Number,
  message: Schema.optional(Schema.String.pipe(Schema.maxLength(2000))),
  stack: Schema.optional(Schema.String.pipe(Schema.maxLength(4000))),
  code: Schema.optional(Schema.String.pipe(Schema.maxLength(100))),
  apiPath: Schema.optional(Schema.String.pipe(Schema.maxLength(300))),
  method: Schema.optional(Schema.String.pipe(Schema.maxLength(10))),
  requestId: Schema.optional(Schema.String.pipe(Schema.maxLength(100))),
  conversationId: Schema.optional(Schema.String.pipe(Schema.maxLength(100))),
  taskId: Schema.optional(Schema.String.pipe(Schema.maxLength(100))),
  state: Schema.optional(Schema.String.pipe(Schema.maxLength(40))),
  status: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
});
export type ClientLog = Schema.Schema.Type<typeof ClientLogSchema>;
export const ClientLogsSchema = Schema.Struct({ entries: Schema.Array(ClientLogSchema).pipe(Schema.minItems(1), Schema.maxItems(8)) });
export function decode<A, I>(schema: Schema.Schema<A, I>, value: unknown): A {
  try { return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" }); }
  catch { throw error("invalid_request", "请求字段或数据格式无效。", 422); }
}
export interface Conversation { id: string; title: string; createdAt: number; updatedAt: number }
export interface ConversationDeletion { conversationId: string; deleted: true; deletedTaskCount: number; taskIds: string[]; alreadyDeleted: boolean }
export interface Message { id: string; conversationId: string; taskId: string; role: "user" | "assistant"; content: string; createdAt: number }
export interface Plan { intent: Intent; road: string; windowSeconds: number; participants: readonly Participant[]; statistics?: StatisticsQuery; datasetVersion?: string; requires: ("aggregate" | "analysis" | "verification" | "explanation")[] }
export interface ProtocolSection { title: string; data: unknown }
export interface ProtocolCheck { name: string; status: "passed" | "failed" | "pending"; expected?: string; actual?: string }
export interface ProtocolDetails { objective: string; operations: string[]; checks?: ProtocolCheck[]; sections?: ProtocolSection[] }
export interface ProtocolMaterials { sections: ProtocolSection[] }
export interface Step {
  id: string; taskId: string; parentId?: string; agent: string; action: string; kind: StepKind;
  status: TaskStatus; detail: string; sender?: string; recipient?: string; protocol?: string;
  at: number; updatedAt: number; metadata: JsonObject; evidenceIds: number[];
  protocolDetails?: ProtocolDetails; hasPrivateDetails?: boolean; phase?: ConversationPhase;
}
export interface Aggregate { road: string; windowSeconds: number; averageSpeed?: number; participantCount: number; protocol: string; query?: StatisticsQuery; datasetVersion?: string; source?: string; groups?: RoadStatistics[] }
export interface Analysis { facts: string[]; possibleCauses: string[]; recommendations: string[]; uncertainties: string[]; evidenceIds: number[] }
export interface Verification { valid: boolean; reason: string; taskId?: string }
export interface SignedEnvelope { signer: string; payload: JsonObject; signature: string }
export interface TaskTimestamps { startedAt?: number; resultAt?: number; analysisAt?: number; verificationAt?: number; summaryAt?: number; finishedAt?: number }
export interface Task {
  id: string; conversationId: string; requestId: string; request: string; status: TaskStatus; createdAt: number; updatedAt: number;
  plan: Plan; mode: "llm"; model?: string; summary: string; steps: Step[];
  result?: Aggregate; analysis?: Analysis; verification?: Verification; report?: SignedEnvelope;
  error?: { code: string; message: string; phase?: ConversationPhase };
  timestamps?: TaskTimestamps;
}
export interface TaskSummary extends Omit<Task, "steps" | "report"> { steps?: never; report?: never; stepCount: number; hasReport: boolean }
export interface PublicEvent { id: number; type: string; taskId: string | null; conversationId: string | null; at: number; payload: JsonObject }
export interface AuditEvent { id: number; at: number; kind: string; details: JsonObject; claimedIdentity: string | null; verifiedIdentity: string | null; prevHash: string; hash: string }
export interface PublicNode { id: string; role: string; fingerprint: string; signingPublicKey: string; certificateExpires: string }
export interface PublicModelSettings { mode: "llm"; provider: string; baseUrl: string; model: string; hasApiKey: boolean; ready: boolean; saved: boolean; deepThinking: boolean; thinkingProtocol: ThinkingProtocol }
export interface Overview { version: string; mode: string; conversations: Conversation[]; tasks: TaskSummary[]; nodes: PublicNode[]; eventCursor: number; audit: { count: number; lastVerification: Verification & { verifiedAt: number; count: number } | null } }
export const PROVIDERS = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { id: "qwen", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { id: "custom", name: "自定义兼容服务", baseUrl: "", model: "" },
] as const;

export function planTask(request: string, intent: CreateTask["intent"]): Plan {
  const chosen: Intent = intent && intent !== "auto" ? intent
    : /^(请|请你|帮我|能否|可以|麻烦|再|详细|用通俗语言|\s)*(解释|说明|为什么|什么是|如何理解)/.test(request) ? "explain"
    : /统计|计算|汇总|平均|均值|车辆数|多少辆|几辆车|样本数|标准差|方差|占比|比例|能耗|耗电|里程|车流量|中位数|分位数|average|statistics/i.test(request) ? "statistics"
    : /验证.*报告|报告.*验证|验签|verify/i.test(request) ? "verification"
    : /调查|异常|事件|告警|证据|investigat/i.test(request) ? "investigation" : "explain";
  return { intent: chosen, road: "S101", windowSeconds: 60, participants: PARTICIPANTS,
    requires: chosen === "statistics" ? ["aggregate", "analysis"] : chosen === "investigation" ? ["analysis"] : chosen === "verification" ? ["verification"] : ["explanation"] };
}
