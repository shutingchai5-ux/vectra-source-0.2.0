import { Effect } from "effect";
import { AppError, error, shanghaiTime } from "@vectra/shared";
import { clientLogsReady, recordClient } from "./diagnostics";

export function request<A>(path: string, options: RequestInit = {}) {
  return Effect.tryPromise({
    try: async signal => {
      const requestId = crypto.randomUUID(), started = performance.now(), method = options.method || "GET";
      const headers = new Headers(options.headers); headers.set("Content-Type", "application/json"); headers.set("X-Request-Id", requestId);
      const diagnostic = (code: string, message: string, status?: number) => recordClient("api.failed", { requestId, method, apiPath: path.split("?")[0].slice(0, 300), code, message, status, durationMs: Math.round(performance.now() - started) });
      let response: Response;
      try { response = await fetch(path, { ...options, credentials: "same-origin", headers, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal }); }
      catch { if (signal.aborted || options.signal?.aborted) throw error("cancelled", "请求已取消。", 409); diagnostic("connection_failed", "无法连接本地服务。"); throw error("connection_failed", "无法连接本地服务；热更新期间会自动重连。", 503); }
      let body: unknown; try { body = await response.json(); } catch { diagnostic("invalid_response", "服务未返回有效 JSON。", response.status); throw error("invalid_response", "服务未返回有效数据。", 502); }
      if (!response.ok) {
        const data = body as { code?: string; message?: string };
        diagnostic(data.code || "request_failed", data.message || "请求未完成。", response.status);
        throw error(data.code ?? "request_failed", data.message ?? "请求未完成。", response.status);
      }
      if (path === "/api/session") clientLogsReady();
      return body as A;
    },
    catch: cause => cause instanceof AppError ? cause : error("request_failed", "请求未完成。", 500),
  });
}
export async function api<A>(path: string, options: RequestInit = {}): Promise<A> {
  const result = await Effect.runPromise(request<A>(path, options).pipe(Effect.either));
  if (result._tag === "Left") throw result.left;
  return result.right;
}
export const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export const time = (value: number) => shanghaiTime(value);
export const statusLabel: Record<string, string> = { queued: "排队中", running: "执行中", completed: "已完成", failed: "未完成", cancelled: "已取消" };
