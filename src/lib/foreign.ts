import Decimal from "@/lib/decimal";
import type { LedgerEntry, ReconciliationRecord, Source } from "@/lib/db";
import { exchangeIdOf } from "@/lib/db";
import { buildAccounts } from "@/lib/reconcile/accounts";

// 해외금융계좌 신고 도우미 (국제조세조정법): 해외 금융회사·해외 가상자산사업자 계좌의 잔액 합계가
// 그해 매월 말일 중 하루라도 5억원을 넘으면 다음 해 6월에 신고한다.
// 해외 거래소 계정만 대상이다 (개인 지갑은 금융계좌가 아니며, 업비트·빗썸은 국내).
// 월말 잔고는 가장 최근 잔고 대사의 실제 잔고에서 그 뒤의 원장 기록을 거꾸로 빼서 구한다 (그 이후 기록만 완전하면 된다).

export const REPORT_THRESHOLD_KRW = new Decimal(500_000_000);
const DOMESTIC = new Set(["upbit", "bithumb"]);

// 그해 각 달의 말일 23:59:59 (한국 시각)
export function monthEnds(year: number): number[] {
  return Array.from({ length: 12 }, (_, m) => Date.UTC(year, m + 1, 1, -9) - 1000);
}

export interface ForeignAccount {
  key: string;
  label: string;
  memberIds: string[];
  anchor: ReconciliationRecord | null; // 기준이 되는 최근 잔고 대사
}

export function foreignAccounts(sources: Source[], records: ReconciliationRecord[]): ForeignAccount[] {
  const byKey = new Map(records.map((r) => [r.key, r]));
  return buildAccounts(sources)
    .accounts.filter((a) => {
      const ex = exchangeIdOf(a.primary);
      return ex !== null && !DOMESTIC.has(ex);
    })
    .map((a) => {
      const r = byKey.get(a.key);
      return { key: a.key, label: a.label, memberIds: a.memberIds, anchor: r && r.status === "ok" ? r : null };
    });
}

// 계정 하나의 월말 자산별 수량. 기준 시점 이후의 달은 null (아직 오지 않았거나 기준보다 나중)
export function monthEndQuantities(account: ForeignAccount, entries: LedgerEntry[], ends: number[]): (Map<string, { asset: string; qty: Decimal }> | null)[] {
  const anchor = account.anchor;
  if (!anchor) return ends.map(() => null);
  const mine = entries.filter((e) => account.memberIds.includes(e.sourceId));
  return ends.map((end) => {
    if (end > anchor.at) return null;
    const out = new Map<string, { asset: string; qty: Decimal }>();
    for (const r of anchor.rows) out.set(r.assetKey, { asset: r.asset, qty: new Decimal(r.actual) });
    for (const e of mine) {
      if (e.time <= end || e.time > anchor.at) continue;
      const cur = out.get(e.assetKey) ?? { asset: e.asset, qty: new Decimal(0) };
      cur.qty = cur.qty.minus(e.amount); // 월말 이후에 들어온 것은 빼고, 나간 것은 더한다
      out.set(e.assetKey, cur);
    }
    return out;
  });
}

// 가격 조회용 심볼 (법정화폐 fiat:USD → USD)
export const priceSymbol = (assetKey: string, asset: string) => (assetKey.startsWith("fiat:") ? assetKey.slice(5) : asset.toUpperCase());
