export const TIME_ZONE = "Asia/Shanghai";
const dayFormatter = new Intl.DateTimeFormat("sv-SE", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const logFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23", timeZoneName: "longOffset" });

export function shanghaiTime(value: number | Date, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", ...options, timeZone: TIME_ZONE }).format(value);
}
export const shanghaiDay = (value: number | Date) => dayFormatter.format(value);
export const shanghaiDayIndex = (value: number | Date) => Date.parse(`${shanghaiDay(value)}T00:00:00Z`) / 86_400_000;
export function shanghaiTimestamp(value: number | Date) {
  const parts = Object.fromEntries(logFormatter.formatToParts(value).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${parts.timeZoneName.replace(/^GMT/, "") || "Z"}`;
}
export function shanghaiDateTime(value: number | Date) {
  const timestamp = shanghaiTimestamp(value);
  return `${timestamp.slice(0, 10)} ${timestamp.slice(11, 19)}（上海时间 UTC${timestamp.slice(23)}）`;
}
