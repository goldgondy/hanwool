import Decimal from "@/lib/decimal";
import { db, type BtcSource } from "@/lib/db";
import { parseWalletInput, type ParsedWallet } from "@/lib/btc/descriptor";
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
  const wallet: ParsedWallet = source.frozenAddresses?.length
    ? { kind: "addresses", addresses: source.frozenAddresses }
    : parseWalletInput(source.input, source.scriptType);
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

  const mine = new Set(used.map((u) => u.address));
  const { entries, warnings } = buildBtcEntries({ sourceId: source.id, addresses: mine, txs: [...byId.values()] });

  // xpub을 지운 뒤 보낸 거래: 지갑이 새로 만든 거스름돈 주소를 몰라 거스름돈까지 외부 송금으로 잡혔을 수 있다.
  // 잔고 대사도 같은 주소 목록만 보므로 차이로 드러나지 않아 따로 알린다.
  if (source.frozenAt) {
    const sentAfter = [...byId.values()].filter(
      (t) => t.status.confirmed && (t.status.block_time ?? 0) * 1000 > source.frozenAt! && t.vin.some((v) => mine.has(v.prevout?.scriptpubkey_address ?? "")),
    ).length;
    if (sentAfter > 0) {
      warnings.push(
        `xpub을 지운 뒤 이 지갑에서 보낸 거래가 ${sentAfter}건 있습니다. 새 거스름돈 주소를 몰라 거스름돈이 외부 송금으로 잘못 계산됐을 수 있으니, xpub을 다시 넣어 갱신하세요.`,
      );
    }
  }

  // 주소 탐색 결과가 바뀌면 과거 트랜잭션 해석도 바뀔 수 있어 계정 원장을 통째로 다시 쓴다.
  // 찾은 주소 목록은 다른 계정과의 이체를 판단(분류 규칙 R5)하도록 함께 저장한다.
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.where("sourceId").equals(source.id).delete();
    await db.ledger.bulkPut(entries);
    await db.syncState.put({
      key: `${source.id}:addresses`,
      cursor: JSON.stringify(used.map((u) => u.address)),
      syncedAt: Date.now(),
    });
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
