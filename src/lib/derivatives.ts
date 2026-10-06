import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";

// 선물·무기한 계약 손익 집계. 과세 방식이 정해지지 않아(docs/tax-review-items.md #7) 세금 계산에서는 빼 두었지만,
// 거래소별·연도별 금액을 따로 보여 준다. 거래소마다 원장에 남기는 모양이 달라 저장된 항목(위치·유형 이름)으로 알아본다.
// 이미 동기화한 원장에도 그대로 쓸 수 있다.

export type DerivativePart = "pnl" | "funding" | "fee";

export interface DerivativeInfo {
  exchange: string;
  part: DerivativePart;
}

const OKX_DERIVATIVE_BILL = /^bill (3|5|8|9|10|13|24|34)\b/; // 인도·청산·펀딩비·ADL·클로백·DDH·스프레드·정산
const OKX_DERIVATIVE_INST = /\((?:[A-Z0-9]+-){2}(?:SWAP|\d{6})/; // BTC-USDT-SWAP, BTC-USD-251226(-…옵션)
const FILE_DERIVATIVE = /futures|perpetual|swap|option|delivery|funding fee|liquidation|adl|settlement|expiry/i;
const BYBIT_DERIVATIVE = /\((linear|inverse|option)\)|^(SETTLEMENT|DELIVERY|LIQUIDATION|ADL)\b/;
const COINBASE_DERIVATIVE = /^(derivatives_settlement|fcm_futures|intx_)/;

function exchangeOf(e: LedgerEntry): string | null {
  const loc = e.location;
  const raw = e.rawType ?? "";
  if (/^Binance (USDⓈ-M|COIN-M)/.test(loc)) return "바이낸스";
  if (/^Binance .*futures/i.test(loc)) return "바이낸스";
  if (loc === "OKX 거래 계정" && (OKX_DERIVATIVE_BILL.test(raw) || OKX_DERIVATIVE_INST.test(raw) || FILE_DERIVATIVE.test(raw))) return "OKX";
  if (loc === "Bybit 통합 계정" && BYBIT_DERIVATIVE.test(raw)) return "바이비트";
  if (loc === "Bitget 선물") return "비트겟";
  if (loc.startsWith("Gate 선물")) return "게이트";
  if (loc === "MEXC 선물") return "MEXC";
  if (loc === "Coinbase" && COINBASE_DERIVATIVE.test(raw)) return "코인베이스";
  return null;
}

function partOf(e: LedgerEntry): DerivativePart {
  const raw = (e.rawType ?? "").toLowerCase();
  if (/funding|\bfund\b|^bill 8\b|^settlement \((linear|inverse)\)/.test(raw)) return "funding";
  if (/fee|commission/.test(raw) || e.kind === "fee") return "fee";
  return "pnl";
}

// 선물 항목이면 거래소와 구분(손익·펀딩비·수수료), 아니면 null. 보상·이체로 분류된 항목은 제외한다.
export function derivativeInfo(e: LedgerEntry): DerivativeInfo | null {
  if (e.tag === "reward" || e.tag === "airdrop" || e.kind === "transfer" || e.kind === "income") return null;
  if (e.kind === "trade" && !/futures/i.test(e.location)) return null;
  const exchange = exchangeOf(e);
  return exchange ? { exchange, part: partOf(e) } : null;
}

export interface DerivativeRow {
  exchange: string;
  asset: string; // 정산 코인 (USDT, BTC 등)
  pnl: Decimal;
  funding: Decimal;
  fee: Decimal;
  count: number;
}

// 한국 시각 기준 연도
export const yearKst = (ms: number) => new Date(ms + 9 * 3600_000).getUTCFullYear();

export function summarizeDerivatives(entries: LedgerEntry[], year: number | null): { rows: DerivativeRow[]; years: number[] } {
  const rows = new Map<string, DerivativeRow>();
  const years = new Set<number>();
  for (const e of entries) {
    const info = derivativeInfo(e);
    if (!info) continue;
    const y = yearKst(e.time);
    years.add(y);
    if (year !== null && y !== year) continue;
    const key = `${info.exchange}|${e.asset}`;
    const r = rows.get(key) ?? { exchange: info.exchange, asset: e.asset, pnl: new Decimal(0), funding: new Decimal(0), fee: new Decimal(0), count: 0 };
    r[info.part] = r[info.part].plus(e.amount);
    r.count++;
    rows.set(key, r);
  }
  return {
    rows: [...rows.values()].sort((a, b) => a.exchange.localeCompare(b.exchange) || a.asset.localeCompare(b.asset)),
    years: [...years].sort((a, b) => b - a),
  };
}

// 원화 추정용: (코인, 날짜)별 합계. 하루 단위 종가로 환산한다 (펀딩비가 8시간마다 생겨 기록이 많다).
export function dailyTotals(entries: LedgerEntry[], year: number | null): Map<string, { asset: string; dayEnd: number; exchange: string; part: DerivativePart; amount: Decimal }> {
  const out = new Map<string, { asset: string; dayEnd: number; exchange: string; part: DerivativePart; amount: Decimal }>();
  for (const e of entries) {
    const info = derivativeInfo(e);
    if (!info || (year !== null && yearKst(e.time) !== year)) continue;
    // 그날 한국 시각 23:59:59
    const kstDay = Math.floor((e.time + 9 * 3600_000) / 86_400_000);
    const dayEnd = Math.min((kstDay + 1) * 86_400_000 - 9 * 3600_000 - 1000, Date.now() - 120_000);
    const key = `${info.exchange}|${info.part}|${e.asset}|${dayEnd}`;
    const cur = out.get(key) ?? { asset: e.asset, dayEnd, exchange: info.exchange, part: info.part, amount: new Decimal(0) };
    cur.amount = cur.amount.plus(e.amount);
    out.set(key, cur);
  }
  return out;
}
