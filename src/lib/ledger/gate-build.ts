import Decimal from "@/lib/decimal";
import type { LedgerEntry, LedgerKind } from "@/lib/db";

// 게이트 현물 계정 장부(/api/v4/spot/account_book) → 원장. ⚠ 실제 키로 검증 전.
// 공식 SDK 모델 기준 (2026-10-01): id, time(ms), currency, change(부호 있는 잔고 변동), balance, type, code, text
// 장부 유형 전체 목록은 확인하지 못해 이름으로 분류하고, 모르는 유형은 '기타'로 두어 검토에 올린다.
// 입출금 기록(/api/v4/wallet/deposits, withdrawals)에서 같은 코인·금액·시각의 블록체인 거래 해시를 붙인다.

export interface GateBook {
  id: string;
  time: string | number; // ms
  currency: string;
  change: string;
  type?: string;
  code?: string;
  text?: string;
}

export interface GateTransfer {
  id: string;
  txid?: string;
  timestamp: string; // 초
  amount: string;
  fee?: string;
  currency: string;
  status: string;
}

const MATCH_WINDOW_MS = 6 * 3600_000;

// 게이트 전체(현물 + USDT 무기한 선물 + 심플 언)를 한 계좌로 본다. 그 사이 이동은 건너뛴다.
// 현물 장부 유형 이름은 CCXT 대응표 기준: futures_in/out(선물), lend/redeem(심플 언 예치·환매), profit(심플 언 이자 지급)
const SPOT_INTERNAL = new Set(["futures_in", "futures_out", "lend", "redeem"]);

function classify(type: string, amount: Decimal): { kind: LedgerKind; tag?: LedgerEntry["tag"]; family: string } | null {
  const t = type.toLowerCase();
  if (t === "profit") return { kind: "income", tag: "reward", family: "reward" };
  if (t === "interest") return amount.gt(0) ? { kind: "income", tag: "reward", family: "reward" } : { kind: "fee", family: "fee" }; // 마진 대출 이자는 비용
  if (/fee/.test(t) && /order|trade|fill|point/.test(t)) return { kind: "fee", family: "fee" };
  if (/order|trade|fill|convert|swap|dust/.test(t)) return { kind: "trade", family: "trade" };
  if (/deposit/.test(t)) return { kind: "transfer", family: "deposit" };
  if (/withdraw/.test(t)) return { kind: "transfer", family: "withdraw" };
  if (/airdrop|candy|startup|launch/.test(t)) return { kind: "income", tag: "airdrop", family: "airdrop" };
  if (/reward|bonus|rebate|referral|interest|earn|staking|dividend|commission/.test(t)) return { kind: "income", tag: "reward", family: "reward" };
  if (/transfer|margin|futures|delivery|options/.test(t)) return { kind: "other", family: "transfer" };
  return null;
}

export function buildGateEntries(input: { sourceId: string; book: GateBook[]; deposits: GateTransfer[]; withdrawals: GateTransfer[] }) {
  const { sourceId } = input;
  const entries: LedgerEntry[] = [];
  const unknown = new Set<string>();
  const used = new Set<string>();
  const base = { sourceId, origin: "exchange" as const, location: "Gate 현물" };

  // 같은 코인·금액(수수료 포함/제외)·가까운 시각의 완료된 입출금 기록에서 거래 해시를 찾는다
  const findTx = (list: GateTransfer[], coin: string, amount: Decimal, time: number) =>
    list.find((t) => {
      if (used.has(t.id) || !t.txid || t.currency.toUpperCase() !== coin || !/DONE|FINAL|CREDITED/i.test(t.status)) return false;
      if (Math.abs(Number(t.timestamp) * 1000 - time) > MATCH_WINDOW_MS) return false;
      const a = new Decimal(t.amount);
      return amount.eq(a) || amount.eq(a.plus(t.fee || 0));
    });

  // 같은 시각의 체결 행은 한 주문으로 묶는다 (장부에 주문 번호 필드가 없다)
  for (const r of input.book) {
    const amount = new Decimal(r.change || 0);
    if (amount.isZero()) continue;
    const coin = r.currency.toUpperCase();
    const type = r.type || r.code || "unknown";
    if (SPOT_INTERNAL.has(type.toLowerCase())) continue;
    const time = Number(r.time);
    const c = classify(type, amount);
    if (!c) unknown.add(type);
    let txHash: string | undefined;
    if (c?.family === "deposit" || c?.family === "withdraw") {
      const hit = findTx(c.family === "deposit" ? input.deposits : input.withdrawals, coin, amount.abs(), time);
      if (hit) {
        used.add(hit.id);
        txHash = hit.txid;
      }
    }
    entries.push({
      ...base,
      id: `${sourceId}:gate:${r.id}`,
      time,
      asset: coin,
      assetKey: coin,
      amount: amount.toString(),
      kind: c?.kind ?? "other",
      groupId: c?.kind === "trade" || c?.kind === "fee" ? `gate:t:${time}` : `gate:${r.id}`,
      txHash,
      tag: c?.tag,
      rawType: r.text ? `${type} (${r.text})` : type,
    });
  }
  return { entries, unknownTypes: [...unknown] };
}

// ── USDT 무기한 선물 장부 (/api/v4/futures/usdt/account_book) ──
// CCXT 응답 예시 기준: time(초, 소수), change, balance, text(계약:주문), type
// dnw: 현물과의 이동, pnl: 실현 손익, fee: 수수료, fund: 펀딩비, refr: 추천 리베이트, point_*: 포인트 카드(USDT 잔고와 별개)

export interface GateFuturesBook {
  time: number | string;
  change: string;
  balance?: string;
  text?: string;
  type: string;
  id?: string;
}

export function buildGateFuturesEntries(sourceId: string, settle: string, rows: GateFuturesBook[]) {
  const entries: LedgerEntry[] = [];
  const unknown = new Set<string>();
  let derivatives = 0;
  const coin = settle.toUpperCase();
  for (const r of rows) {
    const t = r.type.toLowerCase();
    if (t === "dnw" || t.startsWith("point_") || t.startsWith("bonus")) continue;
    const amount = new Decimal(r.change || 0);
    if (amount.isZero()) continue;
    const timeMs = Math.round(Number(r.time) * 1000);
    // 장부 행에 ID가 없을 수 있어 시각·유형·내용·금액으로 결정적 ID를 만든다
    const key = r.id ?? `${r.time}:${t}:${r.text ?? ""}:${r.change}`;
    const reward = t === "refr";
    if (!reward && !["pnl", "fee", "fund", "settle", "settle_fee"].includes(t)) unknown.add(`선물 ${r.type}`);
    if (!reward) derivatives++;
    entries.push({
      sourceId,
      origin: "exchange",
      location: `Gate 선물 (${coin})`,
      id: `${sourceId}:gate:fut:${key}`,
      time: timeMs,
      asset: coin,
      assetKey: coin,
      amount: amount.toString(),
      kind: reward ? "income" : "other",
      groupId: `gate:fut:${key}`,
      tag: reward ? "reward" : undefined,
      rawType: `futures ${r.type}${r.text ? ` (${r.text})` : ""}`,
    });
  }
  return { entries, unknownTypes: [...unknown], derivatives };
}

// ── 심플 언 이자 (/api/v4/earn/uni/interest_records) ──
// interest_dividend: 현물로 지급 → 현물 장부 'profit'에 이미 있으므로 건너뛴다. interest_reinvest: 예치금에 재투자 → 여기서 기록.

export interface GateInterestRecord {
  status: number;
  currency: string;
  interest: string;
  interest_status?: string;
  create_time: number;
}

export function buildGateEarnEntries(sourceId: string, records: GateInterestRecord[]) {
  const entries: LedgerEntry[] = [];
  for (const r of records) {
    if (r.status !== 1 || r.interest_status !== "interest_reinvest") continue;
    const amount = new Decimal(r.interest || 0);
    if (amount.isZero()) continue;
    const coin = r.currency.toUpperCase();
    const time = r.create_time > 1e12 ? r.create_time : r.create_time * 1000;
    const key = `${coin}:${r.create_time}`;
    entries.push({
      sourceId,
      origin: "exchange",
      location: "Gate 심플 언",
      id: `${sourceId}:gate:earn:${key}`,
      time,
      asset: coin,
      assetKey: coin,
      amount: amount.toString(),
      kind: "income",
      groupId: `gate:earn:${key}`,
      tag: "reward",
      rawType: "Simple Earn interest (reinvested)",
    });
  }
  return entries;
}
