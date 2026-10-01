import Decimal from "@/lib/decimal";
import { fiatAssetKey, isFiat } from "@/lib/assets";
import type { LedgerEntry } from "@/lib/db";

// 바이낸스 API 내역 → 원장. ⚠ 실제 키로 검증 전.
// 바이낸스는 계정 전체 장부 API가 없어 아래 기록을 합친다 (응답 형식은 공식 문서·CCXT 구현 기준, 2026-10-01):
// 현물 체결(myTrades, 거래쌍별), 입출금, Convert, 소액 BNB 전환(dribblet), 에어드랍·배당(assetDividend),
// Simple Earn 이자, 선물 손익(income), Binance Pay, P2P.
// 현물·펀딩·Earn·선물 사이 이동은 어느 기록에도 나오지 않으며, 잔고 대조에서 이 계정들을 합쳐 비교한다.

const keyOf = (coin: string) => (isFiat(coin) ? fiatAssetKey(coin) : coin.toUpperCase());

type Base = Pick<LedgerEntry, "sourceId" | "origin">;
const entry = (b: Base, p: Omit<LedgerEntry, "sourceId" | "origin" | "assetKey"> & { assetKey?: string }): LedgerEntry => ({
  ...b,
  ...p,
  asset: p.asset.toUpperCase(),
  assetKey: p.assetKey ?? keyOf(p.asset),
});

// "2024-01-15 10:23:45" (UTC) 또는 밀리초
export const binanceTime = (v: string | number) => (typeof v === "number" || /^\d+$/.test(v) ? Number(v) : Date.parse(`${v.replace(" ", "T")}Z`));

// 블록체인 거래 해시만 남긴다 (바이낸스 내부 이체는 "Internal transfer 123" 같은 문구)
const chainHash = (tx?: string | null) => (tx && !/\s/.test(tx) ? tx : undefined);

// ── 현물 체결 ──
export interface BinanceTrade {
  symbol: string;
  id: number;
  orderId: number;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
}

export function buildBinanceTrades(sourceId: string, trades: { base: string; quote: string; trade: BinanceTrade }[]): LedgerEntry[] {
  const b: Base = { sourceId, origin: "exchange" };
  const out: LedgerEntry[] = [];
  for (const { base, quote, trade: t } of trades) {
    const sign = t.isBuyer ? 1 : -1;
    const common = { location: "Binance 현물", time: t.time, groupId: `bn:ord:${t.symbol}:${t.orderId}`, rawType: `${t.isBuyer ? "BUY" : "SELL"} ${t.symbol}` };
    const id = `${sourceId}:bn:t:${t.symbol}:${t.id}`;
    out.push(
      entry(b, { ...common, id: `${id}:base`, asset: base, amount: new Decimal(t.qty).mul(sign).toString(), kind: "trade" }),
      entry(b, { ...common, id: `${id}:quote`, asset: quote, amount: new Decimal(t.quoteQty).mul(-sign).toString(), kind: "trade" }),
    );
    const fee = new Decimal(t.commission || 0);
    if (!fee.isZero()) out.push(entry(b, { ...common, id: `${id}:fee`, asset: t.commissionAsset, amount: fee.abs().neg().toString(), kind: "fee" }));
  }
  return out;
}

// ── 입출금 ──
export interface BinanceDeposit {
  id: string;
  amount: string;
  coin: string;
  status: number; // 1 완료, 6 입금됐으나 출금 잠금
  txId?: string;
  insertTime: number;
}

export interface BinanceWithdrawal {
  id: string;
  amount: string;
  transactionFee: string;
  coin: string;
  status: number; // 6 완료
  txId?: string;
  applyTime: string;
  completeTime?: string;
}

export function buildBinanceTransfers(sourceId: string, deposits: BinanceDeposit[], withdrawals: BinanceWithdrawal[]): LedgerEntry[] {
  const b: Base = { sourceId, origin: "exchange" };
  const out: LedgerEntry[] = [];
  for (const d of deposits) {
    if (d.status !== 1 && d.status !== 6) continue;
    out.push(entry(b, { id: `${sourceId}:bn:dep:${d.id}`, location: "Binance 현물", time: d.insertTime, asset: d.coin, amount: new Decimal(d.amount).toString(), kind: "transfer", groupId: `bn:dep:${d.id}`, txHash: chainHash(d.txId), rawType: "Deposit" }));
  }
  for (const w of withdrawals) {
    if (w.status !== 6) continue;
    const common = { location: "Binance 현물", time: binanceTime(w.completeTime || w.applyTime), asset: w.coin, groupId: `bn:wd:${w.id}`, txHash: chainHash(w.txId) };
    out.push(entry(b, { ...common, id: `${sourceId}:bn:wd:${w.id}`, amount: new Decimal(w.amount).neg().toString(), kind: "transfer", rawType: "Withdraw" }));
    const fee = new Decimal(w.transactionFee || 0);
    if (!fee.isZero()) out.push(entry(b, { ...common, id: `${sourceId}:bn:wd:${w.id}:fee`, amount: fee.abs().neg().toString(), kind: "fee", rawType: "Withdraw fee" }));
  }
  return out;
}

// ── Convert ──
export interface BinanceConvert {
  orderId: number | string;
  orderStatus: string;
  fromAsset: string;
  fromAmount: string;
  toAsset: string;
  toAmount: string;
  createTime: number;
}

export function buildBinanceConverts(sourceId: string, rows: BinanceConvert[]): LedgerEntry[] {
  const b: Base = { sourceId, origin: "exchange" };
  return rows
    .filter((r) => r.orderStatus === "SUCCESS")
    .flatMap((r) => {
      const common = { location: "Binance 현물", time: r.createTime, groupId: `bn:conv:${r.orderId}`, kind: "trade" as const, rawType: "Convert" };
      return [
        entry(b, { ...common, id: `${sourceId}:bn:conv:${r.orderId}:from`, asset: r.fromAsset, amount: new Decimal(r.fromAmount).neg().toString() }),
        entry(b, { ...common, id: `${sourceId}:bn:conv:${r.orderId}:to`, asset: r.toAsset, amount: new Decimal(r.toAmount).toString() }),
      ];
    });
}

// ── 소액 BNB 전환 ── transferedAmount에서 serviceChargeAmount(2%)를 뗀 만큼 BNB가 들어온다
export interface BinanceDust {
  transId: string | number;
  operateTime: string | number;
  userAssetDribbletDetails: { fromAsset: string; amount: string; transferedAmount: string; serviceChargeAmount: string; operateTime: string | number }[];
}

export function buildBinanceDust(sourceId: string, logs: BinanceDust[]): LedgerEntry[] {
  const b: Base = { sourceId, origin: "exchange" };
  const out: LedgerEntry[] = [];
  for (const log of logs) {
    const groupId = `bn:dust:${log.transId}`;
    for (const d of log.userAssetDribbletDetails ?? []) {
      const common = { location: "Binance 현물", time: binanceTime(d.operateTime ?? log.operateTime), groupId, rawType: "Small assets exchange BNB" };
      const id = `${sourceId}:bn:dust:${log.transId}:${d.fromAsset}`;
      out.push(
        entry(b, { ...common, id: `${id}:from`, asset: d.fromAsset, amount: new Decimal(d.amount).neg().toString(), kind: "trade" }),
        entry(b, { ...common, id: `${id}:to`, asset: "BNB", amount: new Decimal(d.transferedAmount).toString(), kind: "trade" }),
      );
      const fee = new Decimal(d.serviceChargeAmount || 0);
      if (!fee.isZero()) out.push(entry(b, { ...common, id: `${id}:fee`, asset: "BNB", amount: fee.abs().neg().toString(), kind: "fee" }));
    }
  }
  return out;
}

// ── 에어드랍·배당·보상 (assetDividend) ──
export interface BinanceDividend {
  id: string | number;
  tranId?: string | number;
  amount: string;
  asset: string;
  divTime: number;
  enInfo?: string;
}

const AIRDROP_INFO = /airdrop|distribution|launchpool|launchpad|megadrop|hodler|fork/i;

export function buildBinanceDividends(sourceId: string, rows: BinanceDividend[]): LedgerEntry[] {
  const b: Base = { sourceId, origin: "exchange" };
  return rows
    .filter((r) => !new Decimal(r.amount || 0).isZero())
    .map((r) => {
      const airdrop = AIRDROP_INFO.test(r.enInfo ?? "");
      return entry(b, {
        id: `${sourceId}:bn:div:${r.id}`,
        location: "Binance 현물",
        time: r.divTime,
        asset: r.asset,
        amount: new Decimal(r.amount).toString(),
        kind: "income",
        groupId: `bn:div:${r.id}`,
        tag: airdrop ? "airdrop" : "reward",
        rawType: r.enInfo || "Asset dividend",
      });
    });
}

// ── Simple Earn 이자 ── 같은 이자가 배당 기록에도 있으면(같은 코인·금액·가까운 시각) 중복으로 보고 건너뛴다
export interface BinanceEarnReward {
  asset: string;
  amount: string;
  time: number;
  key: string; // 유형·상품·시각으로 만든 고유 키
  kind: "flexible" | "locked";
}

const NEAR_MS = 3 * 3600_000;

export function buildBinanceEarn(sourceId: string, rows: BinanceEarnReward[], dividends: LedgerEntry[]): LedgerEntry[] {
  const b: Base = { sourceId, origin: "exchange" };
  const used = new Set<string>();
  const out: LedgerEntry[] = [];
  for (const r of rows) {
    const amount = new Decimal(r.amount || 0);
    if (amount.isZero()) continue;
    const coin = r.asset.toUpperCase();
    const dup = dividends.find((d) => !used.has(d.id) && d.asset === coin && amount.eq(d.amount) && Math.abs(d.time - r.time) < NEAR_MS);
    if (dup) {
      used.add(dup.id);
      continue;
    }
    out.push(
      entry(b, {
        id: `${sourceId}:bn:earn:${r.key}`,
        location: r.kind === "flexible" ? "Binance Earn(유연)" : "Binance Earn(고정)",
        time: r.time,
        asset: coin,
        amount: amount.toString(),
        kind: "income",
        groupId: `bn:earn:${r.key}`,
        tag: "reward",
        rawType: `Simple Earn ${r.kind} rewards`,
      }),
    );
  }
  return out;
}

// ── 선물 손익 (USDⓈ-M /fapi/v1/income, COIN-M /dapi/v1/income) ──
export interface BinanceIncome {
  symbol?: string;
  incomeType: string;
  income: string;
  asset: string;
  time: number;
  tranId: string | number;
  info?: string;
}

const INCOME_SKIP = new Set(["TRANSFER", "INTERNAL_TRANSFER", "CROSS_COLLATERAL_TRANSFER", "STRATEGY_UMFUTURES_TRANSFER"]);
const INCOME_REWARD = new Set(["WELCOME_BONUS", "CONTEST_REWARD", "BFUSD_REWARD", "COMMISSION_REBATE", "API_REBATE", "FEE_RETURN", "REFERRAL_KICKBACK"]);
const INCOME_CONVERT = new Set(["AUTO_EXCHANGE", "COIN_SWAP_DEPOSIT", "COIN_SWAP_WITHDRAW"]);

export function buildBinanceIncome(sourceId: string, market: "um" | "cm", rows: BinanceIncome[]) {
  const b: Base = { sourceId, origin: "exchange" };
  const out: LedgerEntry[] = [];
  let derivatives = 0;
  for (const r of rows) {
    if (INCOME_SKIP.has(r.incomeType)) continue;
    const amount = new Decimal(r.income || 0);
    if (amount.isZero()) continue;
    const reward = INCOME_REWARD.has(r.incomeType);
    const convert = INCOME_CONVERT.has(r.incomeType);
    if (!reward && !convert) derivatives++;
    const id = `${market}:${r.incomeType}:${r.tranId}:${r.asset}`;
    out.push(
      entry(b, {
        id: `${sourceId}:bn:fut:${id}`,
        location: market === "um" ? "Binance USDⓈ-M" : "Binance COIN-M",
        time: r.time,
        asset: r.asset,
        amount: amount.toString(),
        kind: reward ? "income" : convert ? "trade" : "other",
        groupId: convert ? `bn:fut:conv:${r.tranId}` : `bn:fut:${id}`,
        tag: reward ? "reward" : undefined,
        rawType: `futures ${r.incomeType}${r.symbol ? ` (${r.symbol})` : ""}`,
      }),
    );
  }
  return { entries: out, derivatives };
}

// ── Binance Pay (다른 사용자와 주고받기) ──
export interface BinancePay {
  orderType: string;
  transactionId: string;
  transactionTime: number;
  amount: string; // 양수 = 받음, 음수 = 보냄
  currency: string;
}

export function buildBinancePay(sourceId: string, rows: BinancePay[]): LedgerEntry[] {
  const b: Base = { sourceId, origin: "exchange" };
  return rows
    .filter((r) => !new Decimal(r.amount || 0).isZero())
    .map((r) =>
      entry(b, {
        id: `${sourceId}:bn:pay:${r.transactionId}`,
        location: "Binance 펀딩",
        time: r.transactionTime,
        asset: r.currency,
        amount: new Decimal(r.amount).toString(),
        kind: "transfer",
        groupId: `bn:pay:${r.transactionId}`,
        rawType: `Binance Pay ${r.orderType}`,
      }),
    );
}

// ── P2P (원화 등 법정화폐로 코인 매수·매도) ──
// 법정화폐는 바이낸스 밖(은행)에서 오가므로 Coinbase 카드 매수와 같이 '결제' 두 줄(바깥에서 들어와 바로 지급)로 넣어 법정화폐 합계는 0으로 둔다.
export interface BinanceP2P {
  orderNumber: string;
  tradeType: "BUY" | "SELL";
  asset: string;
  fiat: string;
  amount: string;
  totalPrice: string;
  commission?: string;
  orderStatus: string;
  createTime: number;
}

export function buildBinanceP2P(sourceId: string, rows: BinanceP2P[]): LedgerEntry[] {
  const b: Base = { sourceId, origin: "exchange" };
  const out: LedgerEntry[] = [];
  for (const r of rows) {
    if (r.orderStatus !== "COMPLETED") continue;
    const buy = r.tradeType === "BUY";
    const qty = new Decimal(r.amount);
    const price = new Decimal(r.totalPrice);
    const groupId = `bn:p2p:${r.orderNumber}`;
    const id = `${sourceId}:bn:p2p:${r.orderNumber}`;
    const common = { location: "Binance 펀딩", time: r.createTime, groupId, rawType: `P2P ${r.tradeType}` };
    out.push(
      entry(b, { ...common, id: `${id}:coin`, asset: r.asset, amount: (buy ? qty : qty.neg()).toString(), kind: "trade" }),
      entry(b, { ...common, id: `${id}:fiat`, asset: r.fiat, assetKey: fiatAssetKey(r.fiat), amount: (buy ? price.neg() : price).toString(), kind: "trade" }),
      entry(b, {
        ...common,
        id: `${id}:bank`,
        location: "P2P 상대방 계좌",
        asset: r.fiat,
        assetKey: fiatAssetKey(r.fiat),
        amount: (buy ? price : price.neg()).toString(),
        kind: "transfer",
        groupId: `${groupId}:bank`,
      }),
    );
    const fee = new Decimal(r.commission || 0);
    if (!fee.isZero()) out.push(entry(b, { ...common, id: `${id}:fee`, asset: r.asset, amount: fee.abs().neg().toString(), kind: "fee" }));
  }
  return out;
}
