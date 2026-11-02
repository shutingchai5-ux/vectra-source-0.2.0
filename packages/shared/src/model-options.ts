export type ModelApiFormat = "chat-completions" | "responses";
export type ThinkingProtocol = "auto" | "deepseek" | "qwen" | "openai";
export interface ThinkingOptions { provider: string; baseUrl: string; model: string; apiFormat?: ModelApiFormat; thinkingProtocol?: ThinkingProtocol; deepThinking?: boolean }

/** Clipboard format marks are not part of a model identifier or bearer credential. */
export const normalizeModelSettingText = (value: string) => value.replace(/\p{Cf}/gu, "").trim();

/** Accept a service base or a complete endpoint, and append the selected endpoint exactly once. */
export function normalizeModelBaseUrl(value: string): string {
  const input = value.trim().replace(/\/+$/, "");
  if (/[\s\\]/u.test(input)) return input;
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return input;
    let path = url.pathname.replace(/\/+$/, "");
    while (/\/(?:chat\/completions|responses)$/i.test(path)) path = path.replace(/\/(?:chat\/completions|responses)$/i, "").replace(/\/+$/, "");
    return url.origin + path;
  } catch { return input; }
}
export const modelEndpoint = (baseUrl: string, format: ModelApiFormat = "chat-completions") => normalizeModelBaseUrl(baseUrl) + (format === "responses" ? "/responses" : "/chat/completions");

export function resolveThinkingProtocol(config: ThinkingOptions): Exclude<ThinkingProtocol, "auto"> | null {
  if (config.apiFormat === "responses") return "openai";
  if (config.provider === "deepseek" || config.provider === "qwen" || config.provider === "openai") return config.provider;
  if (config.thinkingProtocol && config.thinkingProtocol !== "auto") return config.thinkingProtocol;
  let host = ""; try { host = new URL(config.baseUrl).hostname; } catch { return null; }
  if (host === "api.deepseek.com") return "deepseek";
  if (/(^|\.)dashscope(?:-[a-z]+)?\.(aliyuncs\.com|ai)$/.test(host)) return "qwen";
  if (host === "api.openai.com") return "openai";
  if (/^deepseek[-/]/i.test(config.model)) return "deepseek";
  if (/^qwen/i.test(config.model)) return "qwen";
  if (/^(?:gpt-|o[1-9](?:-|$))/i.test(config.model)) return "openai";
  return null;
}
