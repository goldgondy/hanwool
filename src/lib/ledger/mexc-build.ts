import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";

// MEXC API 내역 → 원장. 공식 문서 확인: 2026-10-01. ⚠ 실제 키로 검증 전.
// MEXC는 계정 전체 장부 API가 없어 체결(myTrades, 거래쌍별, 최근 1개월)과 입출금(최근 90일)을 합친다.
// 거래쌍 목록을 주는 API도 없어, 보유·입출금·원장에 나온 코인으로 USDT·USDC 거래쌍을 추정해 조회한다.

export interface MexcTrade {
  symbol: string;
  id: string;
  orderId: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
}

export interface MexcDeposit {
  amount: string;
  coin: string;
  status: number; // 5 SUCCESS, 12 COMPLETED
  txId?: string | null;
  insertTime: number;
}

export interface MexcWithdrawal {
  id: string;
  amount: string;
  coin: string;
  status: number; // 7 SUCCESS
  transactionFee?: string;
  txId?: string | null;
  transHash?: string | null;
  applyTime: number;
  updateTime?: number;
}

export const MEXC_QUOTES = ["USDT", "USDC"];

export function buildMexcEntries(input: { sourceId: string; trades: { base: string; quote: string; trade: MexcTrade }[]; deposits: MexcDeposit[]; withdrawals: MexcWithdrawal[] }) {
  const { sourceId } = input;
  const entries: LedgerEntry[] = [];
  const base = { sourceId, origin: "exchange" as const, location: "MEXC 현물" };

  for (const { base: coin, quote, trade: t } of input.trades) {
    const qty = new Decimal(t.qty);
    const quoteQty = new Decimal(t.quoteQty);
    const sign = t.isBuyer ? 1 : -1;
    const common = { ...base, time: t.time, groupId: `mexc:ord:${t.orderId}`, rawType: `${t.isBuyer ? "BUY" : "SELL"} ${t.symbol}` };
    entries.push(
      { ...common, id: `${sourceId}:mexc:t:${t.id}:base`, asset: coin, assetKey: coin, amount: qty.mul(sign).toString(), kind: "trade" },
      { ...common, id: `${sourceId}:mexc:t:${t.id}:quote`, asset: quote, assetKey: quote, amount: quoteQty.mul(-sign).toString(), kind: "trade" },
    );
    const fee = new Decimal(t.commission || 0);
    if (!fee.isZero()) {
      const feeCoin = t.commissionAsset.toUpperCase();
      entries.push({ ...common, id: `${sourceId}:mexc:t:${t.id}:fee`, asset: feeCoin, assetKey: feeCoin, amount: fee.abs().neg().toString(), kind: "fee" });
    }
  }

  for (const d of input.deposits) {
    if (d.status !== 5 && d.status !== 12) continue;
    const coin = d.coin.toUpperCase();
    const key = d.txId || `${coin}:${d.insertTime}:${d.amount}`;
    entries.push({
      ...base,
      id: `${sourceId}:mexc:dep:${key}`,
      time: d.insertTime,
      asset: coin,
      assetKey: coin,
      amount: new Decimal(d.amount).toString(),
      kind: "transfer",
      groupId: `mexc:dep:${key}`,
      txHash: d.txId || undefined,
      rawType: "Deposit",
    });
  }

  for (const w of input.withdrawals) {
    if (w.status !== 7) continue;
    const coin = w.coin.toUpperCase();
    const common = { ...base, time: w.updateTime || w.applyTime, asset: coin, assetKey: coin, groupId: `mexc:wd:${w.id}`, txHash: w.transHash || w.txId || undefined };
    entries.push({ ...common, id: `${sourceId}:mexc:wd:${w.id}`, amount: new Decimal(w.amount).neg().toString(), kind: "transfer", rawType: "Withdraw" });
    const fee = new Decimal(w.transactionFee || 0);
    if (!fee.isZero()) entries.push({ ...common, id: `${sourceId}:mexc:wd:${w.id}:fee`, amount: fee.abs().neg().toString(), kind: "fee", rawType: "Withdraw fee" });
  }
  return { entries };
}
