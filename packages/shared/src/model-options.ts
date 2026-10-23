export type ThinkingProtocol = "auto" | "deepseek" | "qwen" | "openai";
export interface ThinkingOptions { provider: string; baseUrl: string; model: string; thinkingProtocol?: ThinkingProtocol; deepThinking?: boolean }

export function resolveThinkingProtocol(config: ThinkingOptions): Exclude<ThinkingProtocol, "auto"> | null {
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
