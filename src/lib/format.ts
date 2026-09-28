import Decimal from "@/lib/decimal";

export function formatKrw(value: string | null | undefined) {
  if (value == null) return "-";
  return `₩${new Decimal(value).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

export function formatAmount(value: string) {
  const d = new Decimal(value);
  const s = d.toDecimalPlaces(8).toFixed();
  const [int, frac] = s.split(".");
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${intFmt}.${frac}` : intFmt;
}

export function formatDateTime(ms: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(ms);
}

// 의제취득가 기준 시점: 2026-12-31 24:00 KST
export const DEEMED_COST_DEADLINE = Date.parse("2027-01-01T00:00:00+09:00");
