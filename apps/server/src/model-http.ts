import { sanitizeLogValue, type JsonObject } from "@vectra/shared";

const MAX_ERROR_BYTES = 16_384;
export const MAX_MODEL_HTTP_ATTEMPTS = 3;
const transientStatuses = new Set([500, 502, 503, 504, 529]);

/** Provider bodies can echo prompts or credentials. Keep only bounded diagnostic identifiers. */
function identifier(value: unknown, key: string, pattern: RegExp, maximum: number) {
  if (typeof value !== "string" || value.length > maximum || key && value.includes(key)) return undefined;
  const safe = sanitizeLogValue(value, [key]);
  return typeof safe === "string" && pattern.test(safe) ? safe : undefined;
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export class ModelHttpError extends Error {
  constructor(readonly status: number, readonly details: JsonObject, readonly retryAfterMs?: number) {
    super("模型服务返回 HTTP " + status);
    this.name = "ModelHttpError";
  }
}

export async function readModelHttpError(response: Response, key: string, signal?: AbortSignal): Promise<ModelHttpError> {
  signal?.throwIfAborted();
  let parsed: Record<string, unknown> | undefined;
  const reader = response.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0, complete = false;
    const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        const chunk = await reader.read();
        signal?.throwIfAborted();
        if (chunk.done) { complete = true; break; }
        size += chunk.value.byteLength;
        if (size > MAX_ERROR_BYTES) { void reader.cancel().catch(() => {}); break; }
        chunks.push(chunk.value);
      }
      if (complete) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        try { parsed = object(JSON.parse(new TextDecoder().decode(bytes))); } catch { /* No raw text, HTML, or malformed JSON is published. */ }
      }
    } catch (cause) { if (signal?.aborted) throw cause; }
    finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
  }
  const metadata = object(parsed?.ResponseMetadata), failure = object(parsed?.error) ?? object(metadata?.Error);
  const providerCode = identifier(failure?.code ?? failure?.Code, key, /^[A-Za-z0-9_.-]{1,128}$/, 128);
  const providerType = identifier(failure?.type ?? failure?.Type, key, /^[A-Za-z0-9_.-]{1,128}$/, 128);
  const providerParam = identifier(failure?.param, key, /^[A-Za-z0-9_.\[\]-]{1,128}$/, 128);
  const requestIds = [response.headers.get("x-request-id"), response.headers.get("x-tt-logid"), response.headers.get("request-id"), parsed?.request_id, parsed?.requestId, failure?.request_id, metadata?.RequestId];
  const providerRequestId = requestIds.map(value => identifier(value, key, /^[A-Za-z0-9_.:-]{1,256}$/, 256)).find(Boolean);
  const retryAfter = response.headers.get("retry-after");
  let retryAfterMs: number | undefined;
  if (retryAfter !== null) {
    const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(milliseconds)) retryAfterMs = Math.max(0, Math.ceil(milliseconds));
  }
  return new ModelHttpError(response.status, {
    ...(providerCode ? { providerCode } : {}), ...(providerType ? { providerType } : {}),
    ...(providerParam ? { providerParam } : {}), ...(providerRequestId ? { providerRequestId } : {}),
  }, retryAfterMs);
}

export function modelRetryDelay(failure: ModelHttpError, attempt: number): number | undefined {
  if (!transientStatuses.has(failure.status) || attempt >= MAX_MODEL_HTTP_ATTEMPTS) return undefined;
  const delay = failure.retryAfterMs ?? 500 * 2 ** (attempt - 1);
  // A long server backoff ends this call; never retry sooner than Retry-After requests.
  return delay <= 5000 ? delay : undefined;
}

export function waitForModelRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
