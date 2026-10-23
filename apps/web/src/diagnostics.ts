import type { App } from "vue";
import { decode, ClientLogSchema, sanitizeLogValue, type ClientLog } from "@vectra/shared";

const storageKey = "vectra.pending-operations";
const queue: ClientLog[] = [];
let ready = false, sending = false, timer: ReturnType<typeof setTimeout> | undefined;
let delay = 500, previous = "", previousAt = 0;
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
  if (Array.isArray(saved)) for (const entry of saved.slice(-50)) queue.push(decode(ClientLogSchema, sanitizeLogValue(entry)));
} catch { /* Unavailable storage or invalid old data must not prevent the app from starting. */ }

function persist() { try { if (queue.length) localStorage.setItem(storageKey, JSON.stringify(queue)); else localStorage.removeItem(storageKey); } catch {} }
function schedule() { if (!timer && ready && queue.length) timer = setTimeout(() => { timer = undefined; void flush(); }, delay); }
async function flush() {
  if (!ready || sending || !queue.length) return;
  sending = true;
  const entries = queue.slice(0, 8);
  try {
    // Use raw fetch so failures in log delivery cannot recursively generate API logs.
    const response = await fetch("/api/client-logs", { method: "POST", credentials: "same-origin", keepalive: true,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries }), signal: AbortSignal.timeout(5000) });
    if (response.ok || [400, 413, 422].includes(response.status)) { queue.splice(0, entries.length); persist(); delay = 500; }
    else if ([401, 403].includes(response.status)) ready = false;
    else delay = Math.min(delay * 2, 10000);
    await response.body?.cancel();
  } catch { delay = Math.min(delay * 2, 10000); }
  finally { sending = false; schedule(); }
}
export function clientLogsReady() { ready = true; schedule(); }
export function recordClient(event: ClientLog["event"], detail: Omit<ClientLog, "event" | "route" | "clientTime"> = {}) {
  try {
    const route = (location.hash.slice(1).split("?")[0] || "/").slice(0, 300);
    const signature = JSON.stringify({ event, route, ...detail });
    if (signature === previous && Date.now() - previousAt < 1500) return;
    previous = signature; previousAt = Date.now();
    const safe = sanitizeLogValue({ ...detail, event, route, clientTime: Date.now() }) as ClientLog;
    const entry = decode(ClientLogSchema, { ...safe,
      ...(safe.message ? { message: safe.message.slice(0, 2000) } : {}), ...(safe.stack ? { stack: safe.stack.slice(0, 4000) } : {}) });
    queue.push(entry);
    if (queue.length > 50) queue.splice(0, queue.length - 50);
    persist(); schedule();
  } catch { /* Diagnostics must never break an otherwise valid UI interaction. */ }
}
function errorDetails(cause: unknown) { return cause instanceof Error ? { message: cause.message, stack: cause.stack } : { message: String(cause) }; }
export function installClientDiagnostics(app: App) {
  const old = app.config.errorHandler;
  app.config.errorHandler = (cause, instance, info) => {
    const detail = errorDetails(cause);
    recordClient("ui.error", { ...detail, message: `${info}: ${detail.message}` });
    if (old) old(cause, instance, info); else console.error(sanitizeLogValue(detail));
  };
  const onError = (event: ErrorEvent) => recordClient("ui.error", errorDetails(event.error || event.message));
  const onRejection = (event: PromiseRejectionEvent) => recordClient("ui.unhandled_rejection", errorDetails(event.reason));
  const onHide = () => { void flush(); };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("pagehide", onHide);
  if (import.meta.hot) import.meta.hot.dispose(() => {
    window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection); window.removeEventListener("pagehide", onHide);
    if (timer) clearTimeout(timer); void flush();
  });
}
