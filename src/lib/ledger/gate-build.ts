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

function classify(type: string): { kind: LedgerKind; tag?: LedgerEntry["tag"]; family: string } | null {
  const t = type.toLowerCase();
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
    const time = Number(r.time);
    const c = classify(type);
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
