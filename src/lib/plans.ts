import type { Source } from "@/lib/db";

// 요금제 (2026-10-06 세무사 결정: 월 구독 + 연간 할인, 국내 무료 / 해외 9,900 / 지갑 19,900, 세무사 검토는 기본료 + 거래 규모별 추가).
// 결제를 붙이기 전까지는 안내·계산용이다 (베타 기간 무료). 금액은 이 파일 한 곳에서만 고친다.

export type PlanId = "domestic" | "overseas" | "wallet";

export interface Plan {
  id: PlanId;
  name: string;
  monthly: number; // 원
  yearly: number; // 원 (연간 결제)
  summary: string;
  features: string[];
}

export const PLANS: Plan[] = [
  {
    id: "domestic",
    name: "국내",
    monthly: 0,
    yearly: 0,
    summary: "업비트·빗썸 등 국내 거래소만 쓰는 분",
    features: ["국내 거래소 연결 (업비트·빗썸·코인원·고팍스)", "파일·화면 붙여넣기 가져오기", "세금 계산·신고용 엑셀·홈택스 입력 안내", "절세 도구·간이 계산기", "암호화 백업"],
  },
  {
    id: "overseas",
    name: "해외 거래소",
    monthly: 9_900,
    yearly: 99_000,
    summary: "바이낸스·OKX 등 해외 거래소도 쓰는 분",
    features: ["국내 요금제의 모든 기능", "해외 거래소 연결 (바이낸스·OKX·바이비트·비트겟·게이트·MEXC·코인베이스)", "거래소 사이 이체 자동 짝짓기", "선물 손익 집계", "해외금융계좌 신고 확인"],
  },
  {
    id: "wallet",
    name: "개인 지갑",
    monthly: 19_900,
    yearly: 199_000,
    summary: "메타마스크·팬텀 등 개인 지갑까지 쓰는 분",
    features: ["해외 거래소 요금제의 모든 기능", "개인 지갑 연결 (비트코인·이더리움 계열 9개 체인·솔라나·트론·XRP·TON·Aptos·라이트코인)", "지갑 ↔ 거래소 이체를 블록체인 거래 번호로 확정", "잔고 대사로 빠진 기록 찾기", "스팸·사칭 토큰 자동 제외"],
  },
];

const RANK: Record<PlanId, number> = { domestic: 0, overseas: 1, wallet: 2 };
const DOMESTIC_EXCHANGES = new Set(["upbit", "bithumb", "coinone", "gopax", "korbit"]);

// 연결한 계정에 필요한 요금제
export function requiredPlanFor(source: Source): PlanId {
  switch (source.kind) {
    case "evm":
    case "btc":
    case "tron":
    case "solana":
    case "xrp":
    case "ton":
    case "aptos":
      return "wallet";
    case "binance":
    case "okx":
      return "overseas";
    case "xapi":
    case "csv":
      return DOMESTIC_EXCHANGES.has(source.exchange) ? "domestic" : "overseas";
    case "manual":
      return "domestic";
  }
}

export function requiredPlan(sources: Source[]): PlanId {
  return sources.reduce<PlanId>((best, s) => (RANK[requiredPlanFor(s)] > RANK[best] ? requiredPlanFor(s) : best), "domestic");
}

export const planOf = (id: PlanId) => PLANS.find((p) => p.id === id)!;

// ── 세무사 검토 ──
// 기본료(거래 500건까지) + 거래 건수 구간별 추가. DeFi·선물이 있으면 별도 견적. (구간 금액은 초안 — 세무사 확인 후 확정)
export const REVIEW_BASE = 99_000;
export const REVIEW_TIERS: { upTo: number | null; add: number; label: string }[] = [
  { upTo: 500, add: 0, label: "500건까지" },
  { upTo: 2_000, add: 50_000, label: "501~2,000건" },
  { upTo: 10_000, add: 150_000, label: "2,001~10,000건" },
  { upTo: null, add: 0, label: "10,000건 초과" },
];

export interface ReviewQuote {
  price: number | null; // null = 개별 견적
  tierLabel: string;
  needsQuote: string[]; // 개별 견적 사유
}

export function reviewQuote(transactions: number, flags: { derivatives?: boolean; defi?: boolean } = {}): ReviewQuote {
  const tier = REVIEW_TIERS.find((t) => t.upTo === null || transactions <= t.upTo)!;
  const needsQuote: string[] = [];
  if (tier.upTo === null) needsQuote.push("거래 1만 건 초과");
  if (flags.derivatives) needsQuote.push("선물·파생상품 거래");
  if (flags.defi) needsQuote.push("DeFi 거래");
  return { price: needsQuote.length ? null : REVIEW_BASE + tier.add, tierLabel: tier.label, needsQuote };
}
