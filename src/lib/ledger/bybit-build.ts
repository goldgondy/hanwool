import Decimal from "@/lib/decimal";
import type { LedgerEntry, LedgerKind } from "@/lib/db";

// 바이비트 API 내역 → 원장. 공식 문서 확인: 2026-09-30
// - 통합 계정 거래 로그(/v5/account/transaction-log): 행마다 잔고 변동(change = cashFlow + funding − fee)
// - 펀딩 계정 입출금(/v5/asset/deposit|withdraw/query-record)
// 바이비트 전체를 한 계정으로 보므로 계정 사이 이동(TRANSFER_IN/OUT)은 건너뛴다.

export interface BybitLog {
  id: string;
  transactionTime: string; // ms
  type: string;
  category?: string; // spot, linear, inverse, option…
  currency: string;
  change: string;
  symbol?: string;
  tradeId?: string;
}

export interface BybitDeposit {
  id?: string;
  coin: string;
  amount: string;
  txID?: string;
  status: number;
  successAt?: string; // ms
}

export interface BybitWithdrawal {
  withdrawId: string;
  coin: string;
  amount: string;
  withdrawFee?: string;
  txID?: string;
  status: string;
  createTime: string;
  updateTime?: string;
}

type Family = "trade" | "convert" | "reward" | "airdrop" | "fee" | "derivative" | "loan" | "skip";

const TYPES: Record<string, Family> = {
  TRADE: "trade",
  CURRENCY_BUY: "convert",
  CURRENCY_SELL: "convert",
  SPOT_REPAYMENT_BUY: "convert",
  SPOT_REPAYMENT_SELL: "convert",
  CONVERT: "convert",
  AIRDROP: "airdrop",
  BONUS: "reward",
  BONUS_TRANSFER_IN: "reward",
  FEE_REFUND: "reward",
  INTEREST: "fee",
  SETTLEMENT: "derivative",
  DELIVERY: "derivative",
  LIQUIDATION: "derivative",
  ADL: "derivative",
  DIVIDEND_SETTLEMENT: "derivative",
  BONUS_RECOLLECT: "derivative",
  BONUS_TRANSFER_OUT: "derivative",
  BORROW: "loan",
  REPAY: "loan",
  TRANSFER_IN: "skip",
  TRANSFER_OUT: "skip",
};

const KIND: Record<Exclude<Family, "skip">, LedgerKind> = {
  trade: "trade",
  convert: "trade",
  reward: "income",
  airdrop: "income",
  fee: "fee",
  derivative: "other",
  loan: "other",
};

export interface BybitBuildResult {
  entries: LedgerEntry[];
  unknownTypes: string[];
  warnings: string[];
}

export function buildBybitEntries(input: {
  sourceId: string;
  logs: BybitLog[];
  deposits: BybitDeposit[];
  withdrawals: BybitWithdrawal[];
}): BybitBuildResult {
  const { sourceId } = input;
  const entries: LedgerEntry[] = [];
  const unknown = new Set<string>();
  let derivatives = 0;
  const base = { sourceId, origin: "exchange" as const };

  for (const r of input.logs) {
    let family = TYPES[r.type];
    if (!family) unknown.add(r.type);
    if (family === "skip") continue;
    // 현물이 아닌 상품(선물·옵션)의 TRADE는 파생상품 손익이다.
    if (family === "trade" && r.category && r.category !== "spot") family = "derivative";
    if (family === "derivative") derivatives++;

    const amount = new Decimal(r.change || 0);
    if (amount.isZero()) continue;
    const time = Number(r.transactionTime);
    entries.push({
      ...base,
      id: `${sourceId}:bybit:log:${r.id}`,
      location: "Bybit 통합 계정",
      time,
      asset: r.currency.toUpperCase(),
      assetKey: r.currency.toUpperCase(),
      amount: amount.toString(),
      kind: family ? KIND[family] : "other",
      groupId:
        family === "trade"
          ? `bybit:trade:${r.tradeId || r.id}`
          : family === "convert"
            ? `bybit:convert:${time}`
            : `bybit:log:${r.id}`,
      tag: family === "reward" ? "reward" : family === "airdrop" ? "airdrop" : undefined,
      rawType: r.category ? `${r.type} (${r.category})` : r.type,
    });
  }

  for (const d of input.deposits) {
    if (d.status !== 3) continue; // 3 = 성공
    const key = d.id || d.txID || `${d.coin}:${d.successAt}:${d.amount}`;
    entries.push({
      ...base,
      id: `${sourceId}:bybit:dep:${key}`,
      location: "Bybit 펀딩",
      time: Number(d.successAt),
      asset: d.coin.toUpperCase(),
      assetKey: d.coin.toUpperCase(),
      amount: new Decimal(d.amount).toString(),
      kind: "transfer",
      groupId: `bybit:dep:${key}`,
      txHash: d.txID || undefined,
      rawType: "Deposit",
    });
  }

  for (const w of input.withdrawals) {
    if (w.status.toLowerCase() !== "success") continue;
    const time = Number(w.updateTime || w.createTime);
    const common = { ...base, location: "Bybit 펀딩", time, asset: w.coin.toUpperCase(), assetKey: w.coin.toUpperCase(), groupId: `bybit:wd:${w.withdrawId}`, txHash: w.txID || undefined };
    entries.push({ ...common, id: `${sourceId}:bybit:wd:${w.withdrawId}`, amount: new Decimal(w.amount).neg().toString(), kind: "transfer", rawType: "Withdraw" });
    const fee = new Decimal(w.withdrawFee || 0);
    if (!fee.isZero()) {
      entries.push({ ...common, id: `${sourceId}:bybit:wd:${w.withdrawId}:fee`, amount: fee.neg().toString(), kind: "fee", rawType: "Withdraw fee" });
    }
  }

  const warnings: string[] = [];
  if (derivatives > 0) warnings.push(`선물·파생상품 관련 기록 ${derivatives}건은 과세 여부 검토가 필요해 미분류로 두었습니다.`);
  return { entries, unknownTypes: [...unknown], warnings };
}
