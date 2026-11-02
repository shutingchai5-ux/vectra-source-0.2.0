/** Mainland civilian plates used by the park. Registry availability is not a format check. */
export const PLATE_PROVINCES = ["京", "津", "沪", "渝", "冀", "豫", "云", "辽", "黑", "湘", "皖", "鲁", "新", "苏", "浙", "赣", "鄂", "桂", "甘", "晋", "蒙", "陕", "吉", "闽", "贵", "粤", "青", "藏", "川", "宁", "琼"] as const;
export const PLATE_LETTERS = [..."ABCDEFGHJKLMNPQRSTUVWXYZ"];
export const PLATE_FORMAT_HINT = "普通车牌填写5位尾号，新能源车牌填写6位尾号；挂车尾号以“挂”结尾。字母不使用 I、O。";
export function normalizePlateNumber(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[\s·•・]/g, "");
}
export function plateNumberError(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return "请填写车牌号。";
  const plate = normalizePlateNumber(value), province = plate[0], letter = plate[1], serial = plate.slice(2);
  if (!PLATE_PROVINCES.some(item => item === province)) return "请选择有效的车牌省份简称。";
  if (!PLATE_LETTERS.includes(letter ?? "")) return "请选择有效的发牌机关字母，不使用 I、O。";
  if (/[IO]/.test(serial)) return "车牌尾号不能包含 I、O，请核对是否为数字 1、0。";
  const ordinary = /^[A-HJ-NP-Z0-9]{5}$/.test(serial) && (serial.match(/[A-Z]/g)?.length ?? 0) <= 2;
  const trailer = /^[A-HJ-NP-Z0-9]{4}挂$/.test(serial) && (serial.match(/[A-Z]/g)?.length ?? 0) <= 2;
  // Validate the arrangement, without guessing whether a regional energy-letter series is issued.
  const electric = /^(?:[A-HJ-NP-Z][A-HJ-NP-Z0-9][0-9]{4}|[0-9]{5}[A-HJ-NP-Z])$/.test(serial);
  if (!ordinary && !trailer && !electric) return "车牌格式不正确。普通车牌如沪A12345，新能源车牌如沪AD12345或沪A12345D，挂车如沪A1234挂。";
}
export const isPlateNumber = (value: unknown): value is string => typeof value === "string" && plateNumberError(value) === undefined;
export function splitPlateNumber(value: string) {
  const plate = normalizePlateNumber(value);
  return { province: PLATE_PROVINCES.some(p => p === plate[0]) ? plate[0]! : "", letter: PLATE_LETTERS.includes(plate[1] ?? "") ? plate[1]! : "", serial: plate.slice(2) };
}
