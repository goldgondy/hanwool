import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import { looksLikeChainHash } from "@/lib/classify/classifier";
import { koreaAssetKey } from "@/lib/sources/korea";

// 코인원·고팍스 내역 → 원장 (lib/sources/korea-more.ts). ⚠ 실제 키로 검증 전.
// 체결은 결제 통화(원화) 대금과 코인을 한 거래로 묶고, 수수료는 낸 통화로 따로 적는다.
// 코인 입출금은 블록체인 거래 번호를 남겨 내 지갑·다른 거래소 기록과 짝지어지게 한다.

const hash = (h?: string | null) => (h && looksLikeChainHash(h) ? h : undefined);

// ── 코인원 ──

export interface CoinoneTrade {
  trade_id: string;
  order_id: string;
  quote_currency: string;
  target_currency: string;
  is_ask: boolean;
  price: string;
  qty: string;
  timestamp: number;
  fee: string;
  fee_currency: string;
}

export interface CoinoneTransfer {
  id: string;
  currency?: string; // 원화 내역에는 없음
  txid?: string;
  type: "DEPOSIT" | "WITHDRAWAL";
  amount: string;
  fee: string;
  status: string;
  created_at: number;
  to_address?: string;
  from_address?: string;
}

export function buildCoinoneTrades(sourceId: string, trades: CoinoneTrade[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const t of trades) {
    const base = t.target_currency.toUpperCase();
    const quote = t.quote_currency.toUpperCase();
    const qty = new Decimal(t.qty);
    const funds = qty.mul(t.price);
    const sell = t.is_ask;
    const id = `${sourceId}:coinone:t:${t.trade_id}`;
    const common = { sourceId, origin: "exchange" as const, location: "코인원", time: t.timestamp, groupId: `coinone:o:${t.order_id}`, rawType: `${sell ? "매도" : "매수"} ${base}/${quote}` };
    out.push(
      { ...common, id: `${id}:base`, asset: base, assetKey: koreaAssetKey(base), amount: (sell ? qty.neg() : qty).toString(), kind: "trade" },
      { ...common, id: `${id}:quote`, asset: quote, assetKey: koreaAssetKey(quote), amount: (sell ? funds : funds.neg()).toString(), kind: "trade" },
    );
    const fee = new Decimal(t.fee || 0).abs();
    const feeCoin = (t.fee_currency || quote).toUpperCase();
    if (!fee.isZero()) out.push({ ...common, id: `${id}:fee`, asset: feeCoin, assetKey: koreaAssetKey(feeCoin), amount: fee.neg().toString(), kind: "fee" });
  }
  return out;
}

const COINONE_DONE = /^(DEPOSIT_SUCCESS|WITHDRAWAL_SUCCESS|DEPOSIT_COMPLETE|WITHDRAWAL_COMPLETE)$/;

// 출금: amount = 보낸 수량, fee = 출금 수수료로 본다 (실제 키로 확인 필요. 수수료가 포함된 값이어도 거래 번호 짝짓기에서 차이를 수수료로 처리한다)
export function buildCoinoneTransfers(sourceId: string, rows: CoinoneTransfer[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const r of rows) {
    if (!COINONE_DONE.test(r.status)) continue;
    const coin = (r.currency || "KRW").toUpperCase();
    const out_ = r.type === "WITHDRAWAL";
    const krw = coin === "KRW";
    const common = {
      sourceId,
      origin: "exchange" as const,
      location: "코인원",
      time: r.created_at,
      asset: coin,
      assetKey: koreaAssetKey(coin),
      groupId: `coinone:${out_ ? "wd" : "dep"}:${r.id}`,
      txHash: krw ? undefined : hash(r.txid),
      counterparty: out_ ? r.to_address || undefined : undefined,
    };
    const amount = new Decimal(r.amount).abs();
    out.push({ ...common, id: `${sourceId}:coinone:${r.id}`, amount: (out_ ? amount.neg() : amount).toString(), kind: "transfer", rawType: `${krw ? "원화 " : ""}${out_ ? "출금" : "입금"}` });
    const fee = new Decimal(r.fee || 0).abs();
    if (!fee.isZero()) out.push({ ...common, id: `${sourceId}:coinone:${r.id}:fee`, amount: fee.neg().toString(), kind: "fee", rawType: `${out_ ? "출금" : "입금"} 수수료` });
  }
  return out;
}

// ── 고팍스 ──

export interface GopaxTrade {
  id: number;
  orderId: number;
  baseAmount: number | string;
  quoteAmount: number | string;
  fee: number | string;
  feeAsset: string;
  timestamp: string; // ISO
  side: "buy" | "sell";
  tradingPairName: string; // "BTC-KRW" = 코인-결제 통화
}

export interface GopaxTransfer {
  id: number;
  asset: string;
  type: "fiat_withdrawal" | "fiat_deposit" | "crypto_withdrawal" | "crypto_deposit";
  netAmount: number | string;
  feeAmount: number | string;
  status: string;
  reviewStartedAt: number; // 초
  completedAt: number | null; // 초
  txId?: string | null;
  destinationAddress?: string | null;
}

// 숫자로 오는 값은 소수점 오차를 피하려 문자열로 바꿔 Decimal로 읽는다
const D = (v: number | string | null | undefined) => new Decimal(String(v ?? 0));

export function buildGopaxTrades(sourceId: string, trades: GopaxTrade[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const t of trades) {
    const [base, quote] = t.tradingPairName.toUpperCase().split("-");
    const buy = t.side === "buy";
    const qty = D(t.baseAmount);
    const funds = D(t.quoteAmount);
    const id = `${sourceId}:gopax:t:${t.id}`;
    const common = { sourceId, origin: "exchange" as const, location: "고팍스", time: Date.parse(t.timestamp), groupId: `gopax:o:${t.orderId}`, rawType: `${buy ? "매수" : "매도"} ${t.tradingPairName}` };
    out.push(
      { ...common, id: `${id}:base`, asset: base, assetKey: koreaAssetKey(base), amount: (buy ? qty : qty.neg()).toString(), kind: "trade" },
      { ...common, id: `${id}:quote`, asset: quote, assetKey: koreaAssetKey(quote), amount: (buy ? funds.neg() : funds).toString(), kind: "trade" },
    );
    const fee = D(t.fee).abs();
    const feeCoin = (t.feeAsset || quote).toUpperCase();
    if (!fee.isZero()) out.push({ ...common, id: `${id}:fee`, asset: feeCoin, assetKey: koreaAssetKey(feeCoin), amount: fee.neg().toString(), kind: "fee" });
  }
  return out;
}

// netAmount = 실제로 받은(입금) 또는 보낸(출금) 수량, feeAmount = 수수료 (출금 시 잔고에서 net + fee가 빠진다)
export function buildGopaxTransfers(sourceId: string, rows: GopaxTransfer[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const r of rows) {
    if (r.status !== "completed") continue;
    const coin = r.asset.toUpperCase();
    const isOut = r.type.endsWith("withdrawal");
    const fiat = r.type.startsWith("fiat");
    const common = {
      sourceId,
      origin: "exchange" as const,
      location: "고팍스",
      time: (r.completedAt ?? r.reviewStartedAt) * 1000,
      asset: coin,
      assetKey: koreaAssetKey(coin),
      groupId: `gopax:${isOut ? "wd" : "dep"}:${r.id}`,
      txHash: fiat ? undefined : hash(r.txId),
      counterparty: isOut ? r.destinationAddress || undefined : undefined,
    };
    const net = D(r.netAmount).abs();
    out.push({ ...common, id: `${sourceId}:gopax:${r.id}`, amount: (isOut ? net.neg() : net).toString(), kind: "transfer", rawType: `${fiat ? "원화 " : ""}${isOut ? "출금" : "입금"}` });
    // 입금은 netAmount가 이미 수수료를 뺀 받은 금액이므로 출금 수수료만 따로 적는다
    const fee = D(r.feeAmount).abs();
    if (isOut && !fee.isZero()) out.push({ ...common, id: `${sourceId}:gopax:${r.id}:fee`, amount: fee.neg().toString(), kind: "fee", rawType: "출금 수수료" });
  }
  return out;
}
