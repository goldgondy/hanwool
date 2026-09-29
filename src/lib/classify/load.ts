import { db } from "@/lib/db";
import { classifyAll, type GroupView } from "./classifier";

// 사용자의 모든 계정 주소 (EVM은 소문자, BTC는 동기화 때 찾은 주소)
export async function collectOwnAddresses(): Promise<Set<string>> {
  const out = new Set<string>();
  const sources = await db.sources.toArray();
  for (const s of sources) {
    if (s.kind === "evm") out.add(s.address.toLowerCase());
    if (s.kind === "btc") {
      const saved = await db.syncState.get(`${s.id}:addresses`);
      for (const a of saved ? (JSON.parse(saved.cursor) as string[]) : []) out.add(a);
    }
  }
  return out;
}

export async function loadClassifiedGroups(): Promise<GroupView[]> {
  const [entries, decisions, ownAddresses] = await Promise.all([
    db.ledger.toArray(),
    db.decisions.toArray(),
    collectOwnAddresses(),
  ]);
  return classifyAll({ entries, ownAddresses, decisions: new Map(decisions.map((d) => [d.key, d])) });
}
