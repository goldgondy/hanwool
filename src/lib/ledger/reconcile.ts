import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import type { RawBalance } from "@/lib/sources/types";

export interface ReconcileRow {
  assetKey: string;
  asset: string;
  location: string;
  ledger: Decimal; // 원장 합계
  actual: Decimal; // 실제 잔고
  diff: Decimal; // 실제 - 원장 (양수면 원장에 입금 누락, 음수면 출금 누락)
  entryCount: number;
}

// 계정 하나의 원장 합계와 실제 잔고를 자산별로 대조한다.
// 둘 다 0인 자산은 제외한다.
export function reconcile(entries: LedgerEntry[], balances: RawBalance[]): ReconcileRow[] {
  const rows = new Map<string, ReconcileRow>();
  const row = (assetKey: string, asset: string, location: string) => {
    let r = rows.get(assetKey);
    if (!r) {
      r = { assetKey, asset, location, ledger: new Decimal(0), actual: new Decimal(0), diff: new Decimal(0), entryCount: 0 };
      rows.set(assetKey, r);
    }
    return r;
  };

  for (const e of entries) {
    const r = row(e.assetKey, e.asset, e.location);
    r.ledger = r.ledger.plus(e.amount);
    r.entryCount++;
  }
  for (const b of balances) {
    const r = row(b.assetKey, b.asset, b.location);
    r.actual = r.actual.plus(b.amount);
  }

  return [...rows.values()]
    .map((r) => ({ ...r, diff: r.actual.minus(r.ledger) }))
    .filter((r) => !(r.ledger.isZero() && r.actual.isZero()))
    .sort((a, b) => Number(a.diff.isZero()) - Number(b.diff.isZero()) || a.location.localeCompare(b.location) || a.asset.localeCompare(b.asset));
}
