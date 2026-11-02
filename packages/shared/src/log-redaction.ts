const hidden = "[REDACTED]";
const secretField = /^(?:authorization|proxyauthorization|cookies?|setcookie|(?:api|private|session|storage|input|tls|signing)?key|apikey|accesstoken|refreshtoken|controltoken|carrierroletoken|previousToken|xcarrierrole|token|password|secret|ciphertext|nonce|tag|shares?|inputs?|rawspeed|reasoning|reasoningcontent|thinking|visits?|vehicles?|platenumber|visitid|vehicleid|sourcevehicleid|records|slots|dispatchreadyat|dispatchedat|offsitearrivedat|arrivedat|gatestartedat|enteredat|readyat|servicestartedat|serviceendedat|departedat|appointmentstart|appointmentend|businessrecords|demands?|haulage|batterycapacitykwh|socpercent|targetsocpercent|minimumcommittedtrips|reservedtrips|cargotonnes|cargovolumem3|actualLoadTonnes|actualvolumem3|loadcapacitytonnes|loadcapacityvolumem3|loadcapacitypallets|loadeddistancekm|emptydistancekm|pallets|maxpowerkw)$/i;

/** Both browser queues and repository logs pass through the same redaction rules. */
export function sanitizeLogValue(value: unknown, knownSecrets: readonly string[] = []): unknown {
  const secrets = [...knownSecrets].filter(secret => secret.length >= 4).sort((a, b) => b.length - a.length);
  const seen = new WeakSet<object>();
  function text(input: string) {
    if (input.startsWith("主智能体选取的长期记忆参考")) return "[AGENT_MEMORY_CONTEXT_REMOVED]";
    let output = input;
    for (const secret of secrets) output = output.split(secret).join(hidden);
    output = output
      .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, hidden)
      .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, "[INTERNAL_REASONING_REMOVED]")
      .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, `$1 ${hidden}`)
      .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, hidden)
      .replace(/(["']?(?:api[_-]?key|authorization|cookie|set-cookie|vectra_session|session[_-]?(?:key|token)|control[_-]?token|access[_-]?token|refresh[_-]?token|password|secret|private[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&<>]+)/gi, `$1${hidden}`)
      .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, `$1${hidden}@`);
    return output.length > 32000 ? output.slice(0, 32000) + "[TRUNCATED]" : output;
  }
  function visit(input: unknown, depth: number): unknown {
    if (typeof input === "string") return text(input);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : String(input);
    if (typeof input === "bigint") return String(input);
    if (typeof input !== "object") return undefined;
    if (seen.has(input)) return "[CIRCULAR]";
    if (depth > 8) return "[DEPTH_LIMIT]";
    seen.add(input);
    if (input instanceof Error) return visit({ name: input.name, message: input.message, stack: input.stack,
      ...("code" in input ? { code: input.code } : {}), ...("status" in input ? { status: input.status } : {}),
      ...(input.cause === undefined ? {} : { cause: input.cause }) }, depth + 1);
    if (Array.isArray(input)) return input.slice(0, 100).map(item => visit(item, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input).slice(0, 100)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      const memoryField = /^(?:memories|memory|memorycontext)$/i.test(key);
      const memoryArguments = key === "arguments" && "name" in input && input.name === "remember_memory";
      result[text(key)] = memoryField || memoryArguments || secretField.test(key.replace(/[^a-zA-Z]/g, "")) ? hidden : visit(item, depth + 1);
    }
    return result;
  }
  return visit(value, 0);
}
