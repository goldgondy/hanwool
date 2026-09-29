// 거래 분류 체계. 설계: docs/classification.md

export type Category =
  | "internal_transfer"
  | "trade"
  | "buy_fiat"
  | "sell_fiat"
  | "reward"
  | "airdrop"
  | "wrap"
  | "external_in"
  | "external_out"
  | "fee_only"
  | "spam"
  | "defi_unsupported"
  | "unknown";

export const CATEGORY_LABEL: Record<Category, string> = {
  internal_transfer: "내 계정 간 이체",
  trade: "코인 교환",
  buy_fiat: "원화 매수",
  sell_fiat: "원화 매도",
  reward: "보상·이자",
  airdrop: "에어드랍",
  wrap: "래핑·브릿지",
  external_in: "외부에서 받음",
  external_out: "외부로 보냄",
  fee_only: "수수료만",
  spam: "스팸",
  defi_unsupported: "미지원 DeFi",
  unknown: "미분류",
};

// 사용자가 검토 화면에서 고를 수 있는 분류 (거래소 체결 기록으로만 정해지는 것은 제외)
export const USER_SELECTABLE: Category[] = [
  "internal_transfer",
  "trade",
  "reward",
  "airdrop",
  "wrap",
  "external_in",
  "external_out",
  "spam",
  "defi_unsupported",
];

export type ClassificationStatus = "confirmed" | "suggested" | "needs_review" | "user";

// 사용자 결정. 원장과 따로 저장해 재동기화해도 유지된다.
export interface Decision {
  key: string; // groupId
  category: Category;
  costKrw?: string; // external_in 등의 취득가 (사용자 입력)
  note?: string;
  decidedAt: number;
}

// 규칙 + 결정을 합친 분류 결과. 저장하지 않고 매번 계산한다.
export interface Classification {
  key: string;
  category: Category;
  status: ClassificationStatus;
  rule: string; // "R4" 등, 왜 이렇게 분류했는지
  reason: string; // 사용자에게 보여 줄 설명
  decision?: Decision;
}
