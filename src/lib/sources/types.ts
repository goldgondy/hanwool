import type Decimal from "decimal.js";

export interface RawBalance {
  location: string;
  asset: string;
  rawAsset: string;
  // 원장과 잔고를 대조하는 계정 내 자산 식별자.
  // EVM: "eth:native", "eth:0x컨트랙트"(소문자) / 거래소: 심볼 (계정 단위로 합산)
  assetKey: string;
  amount: Decimal;
}

// 계정 전체를 실패시키지 않는 부분 오류를 보고한다.
export type Warn = (message: string) => void;
