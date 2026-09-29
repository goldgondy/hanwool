import Decimal from "@/lib/decimal";
import { db, type BtcSource } from "@/lib/db";
import { parseWalletInput } from "@/lib/btc/descriptor";
import { Esplora, mapLimit, type EsploraTx } from "@/lib/btc/esplora";
import { confirmedBalanceSats, scanWallet, type UsedAddress } from "@/lib/btc/scan";
import { BTC_ASSET_KEY, buildBtcEntries } from "@/lib/ledger/btc-build";
import type { RawBalance } from "@/lib/sources/types";

export interface BtcSyncResult {
  added: number;
  addressCount: number;
  warnings: string[];
}

// 동기화 직후 잔고 대조에서 주소 탐색을 반복하지 않도록 잠시 보관한다.
const scanCache = new Map<string, { at: number; used: UsedAddress[] }>();

async function scan(source: BtcSource, onProgress: (msg: string) => void) {
  const cached = scanCache.get(source.id);
  if (cached && Date.now() - cached.at < 60_000) return cached.used;
  const wallet = parseWalletInput(source.input, source.scriptType);
  const used = await scanWallet(wallet, new Esplora(source.esploraUrl), source.gapLimit, onProgress);
  scanCache.set(source.id, { at: Date.now(), used });
  return used;
}

export async function syncBtcHistory(
  source: BtcSource,
  onProgress: (msg: string) => void = () => {},
): Promise<BtcSyncResult> {
  scanCache.delete(source.id);
  const used = await scan(source, onProgress);
  const esplora = new Esplora(source.esploraUrl);

  let done = 0;
  const perAddress = await mapLimit(used, 2, async (u) => {
    const txs = await esplora.addressTxs(u.address);
    onProgress(`트랜잭션 조회 중 (${++done}/${used.length} 주소)`);
    return txs;
  });
  // 여러 내 주소가 관련된 트랜잭션은 한 번만 처리한다.
  const byId = new Map<string, EsploraTx>();
  for (const t of perAddress.flat()) byId.set(t.txid, t);

  const { entries, warnings } = buildBtcEntries({
    sourceId: source.id,
    addresses: new Set(used.map((u) => u.address)),
    txs: [...byId.values()],
  });

  // 주소 탐색 결과가 바뀌면 과거 트랜잭션 해석도 바뀔 수 있어 계정 원장을 통째로 다시 쓴다.
  await db.transaction("rw", db.ledger, async () => {
    await db.ledger.where("sourceId").equals(source.id).delete();
    await db.ledger.bulkPut(entries);
  });

  return { added: entries.length, addressCount: used.length, warnings };
}

export async function fetchBtcBalances(
  source: BtcSource,
  onProgress: (msg: string) => void = () => {},
): Promise<RawBalance[]> {
  const sats = confirmedBalanceSats(await scan(source, onProgress));
  if (sats === BigInt(0)) return [];
  return [
    {
      location: "Bitcoin",
      asset: "BTC",
      rawAsset: "BTC",
      assetKey: BTC_ASSET_KEY,
      amount: new Decimal(sats.toString()).div(1e8),
    },
  ];
}
