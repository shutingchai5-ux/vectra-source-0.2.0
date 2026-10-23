import { shanghaiTime, shanghaiTimestamp } from "@vectra/shared";

export function messageTime(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return undefined;
  return { text: shanghaiTime(value, { fractionalSecondDigits: 3 }), iso: new Date(value).toISOString(), full: shanghaiTimestamp(value) };
}
