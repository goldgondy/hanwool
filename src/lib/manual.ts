import Decimal from "@/lib/decimal";
import { fiatAssetKey } from "@/lib/assets";
import type { LedgerEntry } from "@/lib/db";

// 직접 입력 → 원장. 연결할 수 없는 곳(지원하지 않는 거래소, 오래된 거래, 기록이 없는 지갑)의 거래와
// 2026년 말 보유분(의제취득가 대상)을 사용자가 손으로 넣는다. 입력한 내용은 사실로 보고 분류를 확정한다 (R1–R3).
// 입금·출금은 출처·행선지를 모르므로 '검토 필요'로 남고, 다른 계정의 출금·입금과 수량·시각이 맞으면 R11로 짝지어진다.

export type ManualType = "buy" | "sell" | "swap" | "deposit" | "withdraw" | "reward" | "airdrop" | "holding";

export const MANUAL_TYPES: Record<ManualType, string> = {
  buy: "원화로 매수",
  sell: "원화로 매도",
  swap: "코인끼리 교환",
  deposit: "입금 (받음)",
  withdraw: "출금 (보냄)",
  reward: "보상·이자",
  airdrop: "에어드랍",
  holding: "2026년 말 보유분",
};

// 2026-12-31 23:59:59 한국 시각 (과세 시작 직전)
export const HOLDING_TIME = Date.UTC(2026, 11, 31, 14, 59, 59);

export interface ManualInput {
  type: ManualType;
  time: number;
  place: string; // 거래소·지갑 이름 (표시용)
  coin: string;
  qty: string;
  krw?: string; // 매수·매도 금액, 보유분의 실제 취득가 (모르면 비움)
  coin2?: string; // 교환으로 받은 코인
  qty2?: string;
  fee?: string;
  feeAsset?: string; // "KRW" 또는 코인
  memo?: string;
}

// 입력값 검사. 문제가 없으면 null
export function validateManual(m: ManualInput): string | null {
  const num = (v?: string) => !!v && /^\d+(\.\d+)?$/.test(v.replace(/,/g, "")) && new Decimal(v.replace(/,/g, "")).gt(0);
  if (!m.coin.trim()) return "코인을 입력하세요";
  if (!num(m.qty)) return "수량을 0보다 큰 숫자로 입력하세요";
  if ((m.type === "buy" || m.type === "sell") && !num(m.krw)) return "원화 금액을 입력하세요";
  if (m.type === "swap" && (!m.coin2?.trim() || !num(m.qty2))) return "받은 코인과 수량을 입력하세요";
  if (m.type !== "holding" && !Number.isFinite(m.time)) return "날짜와 시각을 입력하세요";
  if (m.fee && !num(m.fee)) return "수수료는 숫자로 입력하세요";
  return null;
}

const dec = (v: string) => new Decimal(v.replace(/,/g, ""));
const keyOf = (coin: string) => (coin === "KRW" ? fiatAssetKey("KRW") : coin);

export function buildManualEntries(sourceId: string, uid: string, m: ManualInput): LedgerEntry[] {
  const coin = m.coin.trim().toUpperCase();
  const time = m.type === "holding" ? HOLDING_TIME : m.time;
  const groupId = `manual:${uid}`;
  const base = {
    sourceId,
    origin: "manual" as const,
    location: m.place.trim() || "직접 입력",
    time,
    groupId,
    rawType: `직접 입력: ${MANUAL_TYPES[m.type]}${m.memo?.trim() ? ` (${m.memo.trim()})` : ""}`,
  };
  const leg = (suffix: string, asset: string, amount: Decimal, kind: LedgerEntry["kind"], tag?: LedgerEntry["tag"]): LedgerEntry => ({
    ...base,
    id: `${sourceId}:manual:${uid}:${suffix}`,
    asset,
    assetKey: keyOf(asset),
    amount: amount.toString(),
    kind,
    tag,
  });
  const qty = dec(m.qty);
  const out: LedgerEntry[] = [];

  switch (m.type) {
    case "buy":
      out.push(leg("coin", coin, qty, "trade"), leg("krw", "KRW", dec(m.krw!).neg(), "trade"));
      break;
    case "sell":
      out.push(leg("coin", coin, qty.neg(), "trade"), leg("krw", "KRW", dec(m.krw!), "trade"));
      break;
    case "swap":
      out.push(leg("out", coin, qty.neg(), "trade"), leg("in", m.coin2!.trim().toUpperCase(), dec(m.qty2!), "trade"));
      break;
    case "deposit":
      out.push(leg("in", coin, qty, "transfer"));
      break;
    case "withdraw":
      out.push(leg("out", coin, qty.neg(), "transfer"));
      break;
    case "reward":
    case "airdrop":
      out.push(leg("in", coin, qty, "income", m.type));
      break;
    case "holding":
      // 실제 취득가를 알면 원화 매수로, 모르면 코인만 넣는다 (그 시점 시가로 평가되어 의제취득가와 같아진다)
      out.push(leg("coin", coin, qty, "trade"));
      if (m.krw && dec(m.krw).gt(0)) out.push(leg("krw", "KRW", dec(m.krw).neg(), "trade"));
      break;
  }
  if (m.fee && dec(m.fee).gt(0)) {
    const feeAsset = (m.feeAsset || (m.type === "buy" || m.type === "sell" ? "KRW" : coin)).toUpperCase();
    out.push(leg("fee", feeAsset, dec(m.fee).neg(), "fee"));
  }
  return out;
}
