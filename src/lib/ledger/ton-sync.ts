import Decimal from "@/lib/decimal";
import { db, type TonSource } from "@/lib/db";
import { buildTonEntries, jettonInfo, TON_NATIVE_KEY, tonJettonKey } from "@/lib/ledger/ton-build";
import { toncenter, toncenterAll, type TonJettonTransfer, type TonMeta, type TonTx } from "@/lib/ton/api";
import type { RawBalance } from "@/lib/sources/types";

// 증분 동기화 상태 (syncState `${id}:ton`): 마지막으로 읽은 논리 시각(lt)
interface TonState {
  txLt: string;
  jettonLt: string;
}

export interface TonSyncResult {
  added: number;
  warnings: string[];
}

export async function collectTon(sourceId: string, address: string, state: TonState, onProgress: (msg: string) => void = () => {}) {
  const txs = await toncenterAll<TonTx>("/transactions", "transactions", { account: address }, BigInt(state.txLt), (n) => onProgress(`TON 거래 조회 중 (${n}건)`));
  const jIn = await toncenterAll<TonJettonTransfer>("/jetton/transfers", "jetton_transfers", { owner_address: address, direction: "in" }, BigInt(state.jettonLt), (n) => onProgress(`TON 토큰 입금 조회 중 (${n}건)`));
  const jOut = await toncenterAll<TonJettonTransfer>("/jetton/transfers", "jetton_transfers", { owner_address: address, direction: "out" }, BigInt(state.jettonLt), (n) => onProgress(`TON 토큰 출금 조회 중 (${n}건)`));
  const meta: Record<string, TonMeta> = { ...jIn.metadata, ...jOut.metadata };
  const jettons = [...jIn.rows, ...jOut.rows];
  const entries = buildTonEntries({ sourceId, address, txs: txs.rows, jettons, meta });
  const maxLt = (rows: { lt?: string; transaction_lt?: string }[], prev: string) =>
    rows.reduce((m, r) => {
      const v = BigInt(r.lt ?? r.transaction_lt ?? "0");
      return v > m ? v : m;
    }, BigInt(prev)).toString();
  return { entries, state: { txLt: maxLt(txs.rows, state.txLt), jettonLt: maxLt(jettons, state.jettonLt) } satisfies TonState };
}

export async function syncTonHistory(source: TonSource, onProgress: (msg: string) => void = () => {}): Promise<TonSyncResult> {
  const stateKey = `${source.id}:ton`;
  const saved = await db.syncState.get(stateKey);
  const state: TonState = saved ? JSON.parse(saved.cursor) : { txLt: "0", jettonLt: "0" };
  const result = await collectTon(source.id, source.address, state, onProgress);
  const existing = await db.ledger.bulkGet(result.entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(result.entries);
    await db.syncState.put({ key: stateKey, cursor: JSON.stringify(result.state), syncedAt: Date.now() });
  });
  return { added: existing.filter((x) => !x).length, warnings: [] };
}

export async function tonBalances(address: string): Promise<RawBalance[]> {
  const out: RawBalance[] = [];
  const acc = await toncenter<{ balance: string }>("/account", { address }).catch(() => ({ balance: "0" }));
  const ton = new Decimal(acc.balance || 0).div(1_000_000_000);
  if (!ton.isZero()) out.push({ location: "TON", asset: "TON", rawAsset: "TON", assetKey: TON_NATIVE_KEY, amount: ton });
  const r = await toncenter<{ jetton_wallets: { balance: string; jetton: string }[]; metadata?: Record<string, TonMeta> }>("/jetton/wallets", { owner_address: address, limit: "100" });
  for (const w of r.jetton_wallets) {
    const { symbol, decimals } = jettonInfo(r.metadata ?? {}, w.jetton);
    const amount = new Decimal(w.balance).div(new Decimal(10).pow(decimals ?? 9));
    if (amount.isZero()) continue;
    out.push({ location: "TON", asset: symbol, rawAsset: w.jetton, assetKey: tonJettonKey(w.jetton), amount });
  }
  return out;
}

export const fetchTonBalances = (source: TonSource) => tonBalances(source.address);
