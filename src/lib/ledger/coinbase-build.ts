import Decimal from "@/lib/decimal";
import { fiatAssetKey, isFiat } from "@/lib/assets";
import type { LedgerEntry, LedgerKind } from "@/lib/db";

// 코인베이스 거래 내역(v2 /accounts/:id/transactions) → 원장. 공식 문서 확인: 2026-10-01. ⚠ 실제 키로 검증 전.
// - 계정(지갑)마다 모든 잔고 변동이 한 줄씩 나온다. amount는 부호 있는 잔고 변동이라 합계 = 잔고.
// - 전체 기간을 제공한다 (보관 기간 제한 없음).
// - 카드·은행으로 바로 산 경우 법정화폐 지갑 기록이 없으므로, 결제한 법정화폐(native_amount)를 매수 대가로 보충한다.

export interface CoinbaseTx {
  id: string;
  type: string;
  status: string;
  amount: { amount: string; currency: string };
  native_amount?: { amount: string; currency: string };
  created_at: string;
  network?: { hash?: string };
  buy?: { id: string };
  sell?: { id: string };
  trade?: { id: string };
  advanced_trade_fill?: { order_id?: string; product_id?: string };
}

type Family = "trade" | "buy" | "sell" | "convert" | "transfer" | "fiat" | "reward" | "derivative" | "other" | "skip";

const TYPES: Record<string, Family> = {
  advanced_trade_fill: "trade",
  buy: "buy",
  sell: "sell",
  trade: "convert",
  retail_simple_dust: "convert",
  send: "transfer",
  receive: "transfer",
  request: "transfer",
  fiat_deposit: "fiat",
  fiat_withdrawal: "fiat",
  earn_payout: "reward",
  staking_reward: "reward",
  inflation_reward: "reward",
  interest: "reward",
  incentives_rewards_payout: "reward",
  subscription_rebate: "reward",
  derivatives_settlement: "derivative",
  fcm_futures_usdc_sell: "derivative",
  fcm_futures_usdc_sell_additional_encumberment_rollup: "derivative",
  intx_deposit: "derivative",
  intx_withdrawal: "derivative",
  transfer: "skip", // 내 코인베이스 계정 사이 이동 (양쪽 모두 조회되므로 합계 0)
  vault_withdrawal: "skip",
  staking_transfer: "other",
  unstaking_transfer: "other",
  wrap_asset: "other",
  unwrap_asset: "other",
  clawback: "other",
  incentives_shared_clawback: "other",
  subscription: "other",
  unsupported_asset_recovery: "other",
  tx: "other",
};

const KIND: Record<Exclude<Family, "skip">, LedgerKind> = {
  trade: "trade",
  buy: "trade",
  sell: "trade",
  convert: "trade",
  transfer: "transfer",
  fiat: "transfer",
  reward: "income",
  derivative: "other",
  other: "other",
};

export interface CoinbaseBuildResult {
  entries: LedgerEntry[];
  unknownTypes: string[];
  warnings: string[];
}

export function buildCoinbaseEntries(sourceId: string, txs: CoinbaseTx[]): CoinbaseBuildResult {
  const entries: LedgerEntry[] = [];
  const unknown = new Set<string>();
  let derivatives = 0;
  const base = { sourceId, origin: "exchange" as const, location: "Coinbase" };
  const keyOf = (code: string) => (isFiat(code) ? fiatAssetKey(code) : code.toUpperCase());

  for (const t of txs) {
    if (t.status !== "completed") continue;
    const family = TYPES[t.type];
    if (!family) unknown.add(t.type);
    if (family === "skip") continue;
    if (family === "derivative") derivatives++;
    const amount = new Decimal(t.amount.amount || 0);
    if (amount.isZero()) continue;
    const code = t.amount.currency.toUpperCase();
    const groupId =
      family === "trade"
        ? `cb:order:${t.advanced_trade_fill?.order_id ?? t.id}`
        : family === "buy"
          ? `cb:buy:${t.buy?.id ?? t.id}`
          : family === "sell"
            ? `cb:sell:${t.sell?.id ?? t.id}`
            : family === "convert"
              ? `cb:conv:${t.trade?.id ?? t.created_at}`
              : `cb:tx:${t.id}`;
    entries.push({
      ...base,
      id: `${sourceId}:cb:${t.id}`,
      time: Date.parse(t.created_at),
      asset: code,
      assetKey: keyOf(code),
      amount: amount.toString(),
      kind: family ? KIND[family] : "other",
      groupId,
      txHash: t.network?.hash || undefined,
      tag: family === "reward" ? "reward" : undefined,
      rawType: t.type,
    });
  }

  // 카드·은행 결제 매수/매도: 같은 주문에 법정화폐 지갑 기록이 없으면 결제 금액을 보충한다.
  // 결제 수단에서 들어오고(입금) 바로 매수에 쓰인(출금) 두 줄로 넣어 법정화폐 합계는 0으로 유지한다.
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries) if (e.groupId.startsWith("cb:buy:") || e.groupId.startsWith("cb:sell:")) groups.set(e.groupId, [...(groups.get(e.groupId) ?? []), e]);
  const byId = new Map(txs.map((t) => [t.id, t]));
  for (const [groupId, legs] of groups) {
    if (legs.some((e) => e.assetKey.startsWith("fiat:"))) continue;
    const crypto = legs[0];
    const native = byId.get(crypto.id.slice(`${sourceId}:cb:`.length))?.native_amount;
    if (!native || !isFiat(native.currency)) continue;
    const value = new Decimal(native.amount).abs();
    const buy = groupId.startsWith("cb:buy:");
    const fiat = { ...base, location: "Coinbase 결제 수단", time: crypto.time, asset: native.currency.toUpperCase(), assetKey: fiatAssetKey(native.currency) };
    entries.push(
      { ...fiat, id: `${crypto.id}:pay`, amount: (buy ? value.neg() : value).toString(), kind: "trade", groupId, rawType: buy ? "Card/bank payment" : "Payout" },
      { ...fiat, id: `${crypto.id}:pay:ext`, amount: (buy ? value : value.neg()).toString(), kind: "transfer", groupId: `${groupId}:pay`, rawType: buy ? "Card/bank payment" : "Payout" },
    );
  }

  const warnings: string[] = [];
  if (derivatives > 0) warnings.push(`선물·파생상품 관련 기록 ${derivatives}건은 과세 여부 검토가 필요해 미분류로 두었습니다.`);
  return { entries, unknownTypes: [...unknown], warnings };
}
