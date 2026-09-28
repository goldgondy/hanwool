import { db, type EvmChain, type EvmSource } from "@/lib/db";
import { EVM_CHAINS, evmAssetKey, rpcBatch } from "@/lib/sources/evm";
import {
  buildEvmEntries,
  type AlchemyTransfer,
  type TokenMeta,
  type TxReceipt,
} from "@/lib/ledger/evm-build";

export interface ChainSyncResult {
  chain: EvmChain;
  added: number;
  skipped: number;
  warnings: string[];
  // 주소가 보낸 트랜잭션 수(nonce)와 원장에 가스비가 기록된 트랜잭션 수.
  // 차이가 있으면 토큰 이동이 없는 트랜잭션(approve, 실패한 트랜잭션 등)의 가스비가 누락된 것이다.
  sentTxCount: number;
  gasRecordedCount: number;
}

const BASE_CATEGORIES = ["external", "erc20"];

async function fetchTransfers(
  alchemyKey: string,
  network: string,
  params: Record<string, unknown>,
): Promise<AlchemyTransfer[]> {
  const out: AlchemyTransfer[] = [];
  let pageKey: string | undefined;
  do {
    const [page] = await rpcBatch<{ transfers: AlchemyTransfer[]; pageKey?: string }>(
      alchemyKey,
      network,
      [
        {
          method: "alchemy_getAssetTransfers",
          params: [
            {
              toBlock: "latest",
              withMetadata: true,
              excludeZeroValue: true,
              maxCount: "0x3e8",
              ...params,
              ...(pageKey ? { pageKey } : {}),
            },
          ],
        },
      ],
    );
    out.push(...page.transfers);
    pageKey = page.pageKey;
  } while (pageKey);
  return out;
}

async function inBatches<T, R>(items: T[], size: number, fn: (chunk: T[]) => Promise<R[]>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await fn(items.slice(i, i + size))));
  return out;
}

async function syncChain(
  source: EvmSource,
  alchemyKey: string,
  chain: EvmChain,
  onProgress: (msg: string) => void,
): Promise<ChainSyncResult> {
  const { name, network } = EVM_CHAINS[chain];
  const address = source.address;
  const warnings: string[] = [];
  const stateKey = `${source.id}:${chain}`;
  const fromBlock = (await db.syncState.get(stateKey))?.cursor ?? "0x0";

  // 내부 트랜잭션(컨트랙트가 보낸 네이티브 코인)은 일부 체인만 지원한다. 미지원이면 제외하고 경고한다.
  let categories = [...BASE_CATEGORIES, "internal"];
  const both = (cats: string[]) =>
    Promise.all([
      fetchTransfers(alchemyKey, network, { fromBlock, toAddress: address, category: cats }),
      fetchTransfers(alchemyKey, network, { fromBlock, fromAddress: address, category: cats }),
    ]);

  onProgress(`${name}: 전송 내역 조회 중`);
  let incoming: AlchemyTransfer[];
  let outgoing: AlchemyTransfer[];
  try {
    [incoming, outgoing] = await both(categories);
  } catch (e) {
    if (!(e instanceof Error) || !/internal/i.test(e.message)) throw e;
    categories = BASE_CATEGORIES;
    warnings.push(
      `${name}: 내부 트랜잭션 조회를 지원하지 않아, 컨트랙트가 보낸 ${EVM_CHAINS[chain].native} 입금이 누락될 수 있습니다`,
    );
    [incoming, outgoing] = await both(categories);
  }

  // 소수점 자릿수가 비어 있는 토큰 메타데이터
  const unknownContracts = [
    ...new Set(
      [...incoming, ...outgoing]
        .filter((t) => t.rawContract.address && t.rawContract.decimal == null)
        .map((t) => t.rawContract.address!.toLowerCase()),
    ),
  ];
  const metas = await inBatches(unknownContracts, 100, (chunk) =>
    rpcBatch<TokenMeta>(alchemyKey, network, chunk.map((c) => ({ method: "alchemy_getTokenMetadata", params: [c] }))),
  );
  const tokenMeta = Object.fromEntries(unknownContracts.map((c, i) => [c, metas[i]]));

  const hashes = [...new Set([...incoming, ...outgoing].map((t) => t.hash))];
  let done = 0;
  // 영수증 조회는 건당 CU 비용이 커서 작은 묶음으로 나눈다.
  const receipts = await inBatches(hashes, 20, async (chunk) => {
    const r = await rpcBatch<TxReceipt>(
      alchemyKey,
      network,
      chunk.map((h) => ({ method: "eth_getTransactionReceipt", params: [h] })),
    );
    done += chunk.length;
    onProgress(`${name}: 가스비 확인 중 (${done}/${hashes.length})`);
    return r;
  });

  const { entries, skipped } = buildEvmEntries({
    sourceId: source.id,
    chain,
    address,
    incoming,
    outgoing,
    receipts: receipts.filter(Boolean),
    tokenMeta,
  });
  if (skipped.length > 0) {
    warnings.push(`${name}: ${skipped.length}건은 수량을 해석하지 못해 제외했습니다`);
  }

  const maxBlock = [...incoming, ...outgoing].reduce(
    (m, t) => (BigInt(t.blockNum) > BigInt(m) ? t.blockNum : m),
    fromBlock,
  );

  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(entries);
    // 마지막 블록부터 다시 조회한다(같은 블록의 누락 방지). 항목 ID가 결정적이라 중복되지 않는다.
    await db.syncState.put({ key: stateKey, cursor: maxBlock, syncedAt: Date.now() });
  });

  const [nonceHex] = await rpcBatch<string>(alchemyKey, network, [
    { method: "eth_getTransactionCount", params: [address, "latest"] },
  ]);
  const nativeKey = evmAssetKey(chain, null);
  const gasRecordedCount = await db.ledger
    .where("[sourceId+assetKey]")
    .equals([source.id, nativeKey])
    .filter((e) => e.kind === "fee")
    .count();

  return {
    chain,
    added: entries.length,
    skipped: skipped.length,
    warnings,
    sentTxCount: parseInt(nonceHex, 16),
    gasRecordedCount,
  };
}

export async function syncEvmHistory(
  source: EvmSource,
  alchemyKey: string,
  onProgress: (msg: string) => void = () => {},
): Promise<ChainSyncResult[]> {
  // 체인별로 순서대로 처리해 Alchemy 요청 한도를 넘지 않게 한다.
  const results: ChainSyncResult[] = [];
  for (const chain of source.chains) {
    results.push(await syncChain(source, alchemyKey, chain, onProgress));
  }
  return results;
}
