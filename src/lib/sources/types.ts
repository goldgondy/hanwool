import type Decimal from "decimal.js";

export interface RawBalance {
  location: string;
  asset: string;
  rawAsset: string;
  amount: Decimal;
}

// 계정 전체를 실패시키지 않는 부분 오류를 보고한다.
export type Warn = (message: string) => void;
