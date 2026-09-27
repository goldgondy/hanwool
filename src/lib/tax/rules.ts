import Decimal from "decimal.js";

// 가상자산 과세 규정 상수 (소득세법·지방세법).
// 법령이 여러 차례 개정·유예되었으므로 시행 전에 반드시 최신 조문과 시행령으로 재확인할 것.

// 과세 시작: 2027-01-01 00:00 KST 이후 양도분
export const TAX_START = Date.parse("2027-01-01T00:00:00+09:00");

// 의제취득가액 기준 시점: 2026-12-31 당시 시가
export const DEEMED_PRICE_DATE = "2026-12-31";

// 기타소득 기본공제 (연간)
export const BASIC_DEDUCTION_KRW = new Decimal(2_500_000);

// 소득세율 20%, 지방소득세는 소득세의 10%
export const INCOME_TAX_RATE = new Decimal("0.2");
export const LOCAL_TAX_RATE = new Decimal("0.1");

export function yearOf(ms: number) {
  // KST 기준 연도
  return new Date(ms + 9 * 3600_000).getUTCFullYear();
}
