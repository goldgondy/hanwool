import { db } from "@/lib/db";
import { applyCsvCoverage } from "@/lib/ledger/dedup";
import { classifyAll, type GroupView } from "./classifier";

// 사용자의 모든 계정 주소 (EVM은 소문자, BTC는 동기화 때 찾은 주소)
export async function collectOwnAddresses(): Promise<Set<string>> {
  const out = new Set<string>();
  const sources = await db.sources.toArray();
  for (const s of sources) {
    if (s.kind === "evm") out.add(s.address.toLowerCase());
    if (s.kind === "tron" || s.kind === "solana" || s.kind === "xrp") out.add(s.address); // Base58은 대소문자를 구분한다
    if (s.kind === "btc") {
      const saved = await db.syncState.get(`${s.id}:addresses`);
      for (const a of saved ? (JSON.parse(saved.cursor) as string[]) : []) out.add(a);
    }
  }
  return out;
}

export async function loadClassifiedGroups(): Promise<GroupView[]> {
  const [all, sources, decisions, ownAddresses] = await Promise.all([
    db.ledger.toArray(),
    db.sources.toArray(),
    db.decisions.toArray(),
    collectOwnAddresses(),
  ]);
  // 같은 거래소 계정을 CSV와 API로 함께 연결한 경우 겹치는 기간의 API 항목을 뺀다 (lib/ledger/dedup.ts)
  const { entries } = applyCsvCoverage(all, sources);
  return classifyAll({ entries, ownAddresses, decisions: new Map(decisions.map((d) => [d.key, d])) });
}
