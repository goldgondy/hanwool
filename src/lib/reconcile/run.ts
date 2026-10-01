import Decimal from "@/lib/decimal";
import type { Category } from "@/lib/classify/types";
import { db, getSetting, isExchangeKind, setSetting, type LedgerEntry, type ReconciliationRecord } from "@/lib/db";
import { fetchBtcBalances } from "@/lib/ledger/btc-sync";
import { applyCsvCoverage } from "@/lib/ledger/dedup";
import { reconcile } from "@/lib/ledger/reconcile";
import { fetchBinanceBalances } from "@/lib/sources/binance";
import { fetchEvmBalances } from "@/lib/sources/evm";
import { fetchXapiBalances } from "@/lib/sources/exchanges";
import { fetchOkxBalances } from "@/lib/sources/okx";
import type { RawBalance } from "@/lib/sources/types";
import { isUnlocked } from "@/lib/vault";
import { buildAccounts, type LiveSource } from "./accounts";

type Row = ReconciliationRecord["rows"][number];

async function liveBalances(s: LiveSource): Promise<RawBalance[]> {
  switch (s.kind) {
    case "binance":
      return fetchBinanceBalances(s, () => {});
    case "okx":
      return fetchOkxBalances(s);
    case "xapi":
      return fetchXapiBalances(s);
    case "btc":
      return fetchBtcBalances(s);
    case "evm":
      return fetchEvmBalances(s);
  }
}

// 모든 계정을 대사해 결과를 저장한다. 거래 내역이 없는 계정은 대사하지 않는다 (잔고 전체가 차이로 나와 의미가 없다).
export async function runReconciliation(onProgress: (msg: string) => void = () => {}): Promise<ReconciliationRecord[]> {
  const [sources, all] = await Promise.all([db.sources.toArray(), db.ledger.toArray()]);
  const { entries } = applyCsvCoverage(all, sources);
  const { accounts } = buildAccounts(sources);

  const records: ReconciliationRecord[] = [];
  for (const [i, acc] of accounts.entries()) {
    onProgress(`잔고 대사 중 (${i + 1}/${accounts.length}) ${acc.label}`);
    const members = new Set(acc.memberIds);
    const mine = entries.filter((e) => members.has(e.sourceId));
    const base = { key: acc.key, label: acc.label, memberIds: acc.memberIds, at: Date.now(), rows: [] as Row[] };
    if (mine.length === 0) {
      records.push({ ...base, status: "no_history" });
      continue;
    }
    if (isExchangeKind(acc.primary.kind) && !isUnlocked()) {
      records.push({ ...base, status: "error", error: "거래소 키 잠금을 해제해야 잔고를 조회할 수 있습니다" });
      continue;
    }
    try {
      const rows = reconcile(mine, await liveBalances(acc.primary));
      records.push({
        ...base,
        status: "ok",
        rows: rows.map((r) => ({
          assetKey: r.assetKey,
          asset: r.asset,
          location: r.location,
          ledger: r.ledger.toString(),
          actual: r.actual.toString(),
          diff: r.diff.toString(),
        })),
      });
    } catch (e) {
      records.push({ ...base, status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  await db.transaction("rw", db.reconciliations, async () => {
    await db.reconciliations.clear(); // 삭제된 계정의 오래된 결과를 남기지 않는다
    await db.reconciliations.bulkPut(records);
  });
  return records;
}

// 차이를 원장 조정 항목으로 반영하고 분류 결정을 함께 저장한다. 다시 대사하면 일치한다.
// 조정 시점은 대사 시각이다 (언제 생긴 차이인지 알 수 없으므로).
export async function applyAdjustment(record: ReconciliationRecord, row: Row, category: Category, note: string, costKrw?: string) {
  const at = Date.now();
  const groupId = `adjust:${record.key}:${row.assetKey}:${at}`;
  const entry: LedgerEntry = {
    id: `${record.key}:${groupId}`,
    sourceId: record.key,
    location: row.location,
    time: at,
    asset: row.asset,
    assetKey: row.assetKey,
    amount: new Decimal(row.diff).toString(),
    kind: "transfer",
    groupId,
    origin: "manual",
    rawType: "잔고 대사 조정",
  };
  await db.transaction("rw", db.ledger, db.decisions, async () => {
    await db.ledger.put(entry);
    await db.decisions.put({ key: groupId, category, costKrw, note, decidedAt: at });
  });
}

// 무시: 같은 크기의 차이는 다시 표시하지 않는다 (차이가 바뀌면 다시 나타남)
const ignoreKey = (record: ReconciliationRecord, row: Row) => `reconcile-ignore:${record.key}:${row.assetKey}`;

export async function ignoreDiff(record: ReconciliationRecord, row: Row) {
  await setSetting(ignoreKey(record, row), row.diff);
}

export async function ignoredDiffs(records: ReconciliationRecord[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of records) {
    for (const row of r.rows) {
      if ((await getSetting(ignoreKey(r, row))) === row.diff) out.add(`${r.key}:${row.assetKey}`);
    }
  }
  return out;
}
