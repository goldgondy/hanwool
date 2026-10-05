import Decimal from "@/lib/decimal";
import { db, type AptosSource } from "@/lib/db";
import { aptosActivities, aptosBalances, aptosTxHash, aptosWait } from "@/lib/aptos/api";
import { aptosAsset, buildAptosEntries, isDeposit, isWithdraw } from "@/lib/ledger/aptos-build";
import type { RawBalance } from "@/lib/sources/types";

// 증분 동기화 상태 (syncState `${id}:aptos`): 마지막으로 읽은 거래 버전
export async function collectAptos(sourceId: string, owner: string, after: number, onProgress: (msg: string) => void = () => {}) {
  aptosWait.onWait = (s) => onProgress(`Aptos 서버 호출 한도로 ${s}초 기다리는 중`);
  const activities = await aptosActivities(owner, after, (n) => onProgress(`Aptos 입출금 기록 조회 중 (${n}건)`));
  // 송금이 있는 거래만 해시를 찾는다 (거래소 출금 기록과 짝짓기용)
  const versions = [...new Set(activities.filter((a) => !a.is_gas_fee && (isDeposit(a.type) || isWithdraw(a.type))).map((a) => a.transaction_version))];
  const hashes = new Map<number, string>();
  for (const [i, v] of versions.entries()) {
    onProgress(`Aptos 거래 번호 조회 중 (${i + 1}/${versions.length})`);
    const h = await aptosTxHash(v).catch(() => undefined);
    if (h) hashes.set(v, h);
  }
  const entries = buildAptosEntries({ sourceId, activities, hashes });
  const next = activities.reduce((m, a) => Math.max(m, a.transaction_version), after);
  return { entries, next };
}

export async function syncAptosHistory(source: AptosSource, onProgress: (msg: string) => void = () => {}) {
  const stateKey = `${source.id}:aptos`;
  const after = Number((await db.syncState.get(stateKey))?.cursor ?? -1);
  const { entries, next } = await collectAptos(source.id, source.address, after, onProgress);
  const existing = await db.ledger.bulkGet(entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(entries);
    await db.syncState.put({ key: stateKey, cursor: String(next), syncedAt: Date.now() });
  });
  return { added: existing.filter((x) => !x).length, warnings: [] as string[] };
}

export async function aptosRawBalances(owner: string): Promise<RawBalance[]> {
  const sums = new Map<string, RawBalance>();
  for (const b of await aptosBalances(owner)) {
    const { key, symbol } = aptosAsset(b.asset_type, b.metadata?.symbol);
    const decimals = b.metadata?.decimals ?? 8;
    const amount = new Decimal(String(b.amount)).div(new Decimal(10).pow(decimals));
    if (amount.isZero()) continue;
    const cur = sums.get(key);
    sums.set(key, { location: "Aptos", asset: symbol, rawAsset: b.asset_type, assetKey: key, amount: (cur?.amount ?? new Decimal(0)).plus(amount) });
  }
  return [...sums.values()];
}

export const fetchAptosBalances = (source: AptosSource) => aptosRawBalances(source.address);
