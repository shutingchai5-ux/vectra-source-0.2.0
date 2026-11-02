import type { JsonObject } from "@vectra/shared";

export interface ToolCall { id: string; type: string; function: { name: string; arguments: string } }
export interface ChatMessage { role: string; content?: string | null; tool_call_id?: string; tool_calls?: ToolCall[]; reasoning_content?: string }
const object = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const invalid = () => new Error("Responses 接口未返回完整、有效的结果，未记录原始响应正文。");

/** Keep provider continuation items only in invocation memory, never in traces or persisted chat history. */
export function parseResponsesReply(value: unknown): { reply: ChatMessage; continuation: JsonObject[] } {
  if (!object(value) || !Array.isArray(value.output) || value.status !== undefined && value.status !== "completed") throw invalid();
  const text: string[] = [], calls: ToolCall[] = [], continuation: JsonObject[] = [];
  for (const item of value.output) {
    if (!object(item) || typeof item.type !== "string" || item.status !== undefined && item.status !== "completed") throw invalid();
    if (item.type === "message") {
      if (item.role !== "assistant" || !Array.isArray(item.content)) throw invalid();
      for (const part of item.content) {
        if (!object(part)) throw invalid();
        if (part.type === "output_text" && typeof part.text === "string") text.push(part.text);
        else if (part.type === "refusal" && typeof part.refusal === "string") text.push(part.refusal);
        else throw invalid();
      }
    } else if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !item.call_id.trim() || typeof item.name !== "string" || typeof item.arguments !== "string") throw invalid();
      calls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
    } else if (item.type !== "reasoning") throw invalid();
    continuation.push(item);
  }
  return { reply: { role: "assistant", content: text.join("\n\n"), ...(calls.length ? { tool_calls: calls } : {}) }, continuation };
}

/** Explicit public projection: opaque reasoning and provider-specific hidden fields never enter UI/log data. */
export function publicResponsesInput(items: JsonObject[]): JsonObject[] {
  return items.filter(item => item.type !== "reasoning").map(item => {
    if (item.type === "function_call") return { type: item.type, call_id: item.call_id, name: item.name, arguments: item.arguments };
    if (item.type === "function_call_output") return { type: item.type, call_id: item.call_id, output: item.output };
    if (item.type === "message") return { type: item.type, role: item.role, ...(item.phase ? { phase: item.phase } : {}), content: (item.content as JsonObject[]).map(part => part.type === "output_text" ? { type: part.type, text: part.text } : { type: part.type, refusal: part.refusal }) };
    return { role: item.role, content: item.content };
  });
}
