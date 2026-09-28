import { db, type EvmChain, type EvmSource } from "@/lib/db";
import { EVM_CHAINS, blockscoutPages, blockscoutRpc, evmAssetKey } from "@/lib/sources/evm";
import {
  buildEvmEntries,
  type InternalTx,
  type NativeTx,
  type TokenTransfer,
} from "@/lib/ledger/evm-build";

export interface ChainSyncResult {
  chain: EvmChain;
  added: number;
  skipped: number;
  warnings: string[];
  // 주소가 보낸 트랜잭션 수(nonce)와 원장에 가스비가 기록된 트랜잭션 수.
  // 차이가 있으면 일부 트랜잭션이 누락된 것이다. nonce를 조회하지 못하면 null.
  sentTxCount: number | null;
  gasRecordedCount: number;
}

// Blockscout 응답 형식 (버전에 따라 필드 이름이 조금 다를 수 있어 둘 다 받는다)
type Addr = { hash: string } | null;
interface BsTx {
  hash: string;
  from: Addr;
  to: Addr;
  value: string;
  fee: { value: string } | null;
  result: string;
  timestamp: string;
  block_number?: number;
  block?: number;
}
interface BsInternal {
  transaction_hash: string;
  index: number;
  from: Addr;
  to: Addr;
  value: string;
  success: boolean;
  timestamp: string;
  block_number?: number;
  block?: number;
}
interface BsTokenTransfer {
  transaction_hash?: string;
  tx_hash?: string;
  log_index: number;
  from: Addr;
  to: Addr;
  total: { value: string; decimals: string | null } | null;
  token: { address?: string; address_hash?: string; symbol: string | null; decimals: string | null; type: string };
  timestamp: string;
  block_number?: number;
  block?: number;
}

const blockOf = (x: { block_number?: number; block?: number }) => x.block_number ?? x.block ?? 0;

async function fetchNonce(chain: EvmChain, address: string): Promise<number | null> {
  const hex = await blockscoutRpc<string>(chain, "eth_getTransactionCount", [address, "latest"]);
  return hex ? parseInt(hex, 16) : null;
}

// fromBlock 이후(포함)의 내역을 Blockscout에서 가져와 정규화한다. DB에는 접근하지 않는다.
export async function fetchChainHistory(
  address: string,
  chain: EvmChain,
  fromBlock = 0,
  onProgress: (msg: string) => void = () => {},
): Promise<{ txs: NativeTx[]; internal: InternalTx[]; tokens: TokenTransfer[]; maxBlock: number }> {
  const { name } = EVM_CHAINS[chain];
  // 최신 항목부터 오므로, 이미 가져온 블록보다 이전 항목이 나오면 멈춘다.
  // 마지막 블록은 다시 가져오며, 항목 ID가 결정적이라 중복되지 않는다.
  const stop = (x: { block_number?: number; block?: number }) => blockOf(x) < fromBlock;
  const base = `/api/v2/addresses/${address}`;

  onProgress(`${name}: 트랜잭션 조회 중`);
  const txs = await blockscoutPages<BsTx>(chain, `${base}/transactions`, {}, stop);
  onProgress(`${name}: 내부 트랜잭션 조회 중`);
  const internal = await blockscoutPages<BsInternal>(chain, `${base}/internal-transactions`, {}, stop);
  onProgress(`${name}: 토큰 전송 조회 중`);
  const tokens = await blockscoutPages<BsTokenTransfer>(chain, `${base}/token-transfers`, { type: "ERC-20" }, stop);

  return {
    maxBlock: [...txs, ...internal, ...tokens].reduce((m, x) => Math.max(m, blockOf(x)), fromBlock),
    txs: txs.map(
      (t): NativeTx => ({
        hash: t.hash,
        from: t.from?.hash ?? "",
        to: t.to?.hash ?? null,
        value: t.value ?? "0",
        fee: t.fee?.value ?? "0",
        success: t.result === "success",
        time: Date.parse(t.timestamp),
      }),
    ),
    internal: internal.map(
      (t): InternalTx => ({
        hash: t.transaction_hash,
        index: t.index,
        from: t.from?.hash ?? "",
        to: t.to?.hash ?? null,
        value: t.value ?? "0",
        success: t.success,
        time: Date.parse(t.timestamp),
      }),
    ),
    tokens: tokens.map(
      (t): TokenTransfer => ({
        hash: t.transaction_hash ?? t.tx_hash ?? "",
        logIndex: t.log_index,
        from: t.from?.hash ?? "",
        to: t.to?.hash ?? "",
        value: t.total?.value ?? "0",
        decimals: t.total?.decimals != null ? Number(t.total.decimals) : t.token.decimals != null ? Number(t.token.decimals) : null,
        token: t.token.address ?? t.token.address_hash ?? "",
        symbol: t.token.symbol,
        time: Date.parse(t.timestamp),
      }),
    ),
  };
}

async function syncChain(
  source: EvmSource,
  chain: EvmChain,
  onProgress: (msg: string) => void,
): Promise<ChainSyncResult> {
  const { name } = EVM_CHAINS[chain];
  const address = source.address;
  const warnings: string[] = [];
  const stateKey = `${source.id}:${chain}`;
  const fromBlock = Number((await db.syncState.get(stateKey))?.cursor ?? 0);

  const { txs, internal, tokens, maxBlock } = await fetchChainHistory(address, chain, fromBlock, onProgress);
  const { entries, skipped } = buildEvmEntries({ sourceId: source.id, chain, address, txs, internal, tokens });
  if (skipped.length > 0) {
    warnings.push(`${name}: ${skipped.length}건은 수량을 해석하지 못해 제외했습니다`);
  }

  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(entries);
    await db.syncState.put({ key: stateKey, cursor: String(maxBlock), syncedAt: Date.now() });
  });

  const gasRecordedCount = await db.ledger
    .where("[sourceId+assetKey]")
    .equals([source.id, evmAssetKey(chain, null)])
    .filter((e) => e.kind === "fee")
    .count();

  return {
    chain,
    added: entries.length,
    skipped: skipped.length,
    warnings,
    sentTxCount: await fetchNonce(chain, address),
    gasRecordedCount,
  };
}

export async function syncEvmHistory(
  source: EvmSource,
  onProgress: (msg: string) => void = () => {},
): Promise<ChainSyncResult[]> {
  // 공개 API 속도 제한을 넘지 않도록 체인별로 순서대로 처리한다.
  const results: ChainSyncResult[] = [];
  for (const chain of source.chains) {
    results.push(await syncChain(source, chain, onProgress));
  }
  return results;
}
