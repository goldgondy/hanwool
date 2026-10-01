import type { ReconcileRow } from "@/lib/ledger/reconcile";

// 잔고 대사 차이 판별. 차이 = 실제 잔고 − 원장 합계
// - 리베이스 토큰(stETH, Aave aToken 등)은 이자·보상으로 잔고가 전송 기록 없이 늘어난다 → 보상으로 제안
// - 그 밖의 증가·감소는 원인을 알 수 없으므로 사용자·세무사 확인 (docs/tax-review-items.md #12)

export type DiffKind = "match" | "rebasing_gain" | "unexplained_gain" | "unexplained_loss";

// 리베이스 토큰 (assetKey). 추가할 때는 컨트랙트 주소를 소문자로.
const REBASING_CONTRACTS = new Set([
  "eth:0xae7ab96520de3a18e5e111b5eaab095312d7fe84", // Lido stETH
]);
// Aave v3 aToken 심볼 규칙: a + 체인 약어 + 기초자산 (예: aEthWETH, aArbUSDC, aBasUSDC)
const AAVE_ATOKEN = /^A(ETH|ARB|BAS|OPT|POL|AVA)[A-Z0-9.]+$/;

export function isRebasing(row: Pick<ReconcileRow, "assetKey" | "asset">) {
  return REBASING_CONTRACTS.has(row.assetKey.toLowerCase()) || AAVE_ATOKEN.test(row.asset.toUpperCase());
}

export interface DiffJudgement {
  kind: DiffKind;
  title: string;
  suggestion: string;
}

export function judgeDiff(row: ReconcileRow): DiffJudgement {
  const d = row.diff;
  if (d.isZero()) return { kind: "match", title: "일치", suggestion: "" };
  if (d.gt(0) && isRebasing(row)) {
    return {
      kind: "rebasing_gain",
      title: "리베이스 토큰 증가",
      suggestion: "이자·보상으로 잔고가 저절로 늘어나는 토큰입니다. 보상(취득가 0원)으로 처리하는 것을 권합니다.",
    };
  }
  if (d.gt(0)) {
    return {
      kind: "unexplained_gain",
      title: "설명되지 않는 증가",
      suggestion: "기록되지 않은 입금·보상이 있을 수 있습니다. 연결하지 않은 계정에서 들어왔다면 그 계정을 연결하세요.",
    };
  }
  return {
    kind: "unexplained_loss",
    title: "설명되지 않는 감소",
    suggestion: "기록되지 않은 출금·수수료·손실이 있을 수 있습니다. 연결하지 않은 계정으로 보냈다면 그 계정을 연결하세요.",
  };
}

export interface ReconcileSummary {
  rows: number;
  matched: number;
  gains: number;
  losses: number;
}

export function summarize(rows: ReconcileRow[]): ReconcileSummary {
  const j = rows.map(judgeDiff);
  return {
    rows: rows.length,
    matched: j.filter((x) => x.kind === "match").length,
    gains: j.filter((x) => x.kind === "rebasing_gain" || x.kind === "unexplained_gain").length,
    losses: j.filter((x) => x.kind === "unexplained_loss").length,
  };
}
