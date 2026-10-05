import { db, type EvmChain, type EvmSource } from "@/lib/db";
import { EVM_CHAINS, blockscoutPages, evmRpc, evmAssetKey, routescanAll, routescanLagHours } from "@/lib/sources/evm";
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
  const hex = await evmRpc<string>(chain, "eth_getTransactionCount", [address, "latest"]);
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
  if (EVM_CHAINS[chain].routescan) return fetchRoutescanHistory(address, chain, fromBlock, onProgress);
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

// Routescan(Etherscan 형식) 응답
interface RsTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  gasUsed: string;
  gasPrice: string;
  isError: string;
  txreceipt_status?: string;
}
interface RsInternal {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  isError: string;
  traceId?: string;
}
interface RsToken {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  contractAddress: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

// 아발란체·플라스마: Routescan에서 오래된 순으로 읽는다. 토큰 전송에 로그 번호가 없어 같은 트랜잭션 안의 순서로 번호를 붙인다.
async function fetchRoutescanHistory(address: string, chain: EvmChain, fromBlock: number, onProgress: (msg: string) => void) {
  const { name } = EVM_CHAINS[chain];
  onProgress(`${name}: 트랜잭션 조회 중`);
  const txs = await routescanAll<RsTx>(chain, "txlist", address, fromBlock, (t) => t.hash);
  onProgress(`${name}: 내부 트랜잭션 조회 중`);
  const internal = await routescanAll<RsInternal>(chain, "txlistinternal", address, fromBlock, (t) => `${t.hash}:${t.traceId ?? ""}:${t.from}:${t.to}:${t.value}`);
  onProgress(`${name}: 토큰 전송 조회 중`);
  const tokens = await routescanAll<RsToken>(chain, "tokentx", address, fromBlock, (t) => `${t.hash}:${t.contractAddress}:${t.from}:${t.to}:${t.value}`);

  const seq = new Map<string, number>();
  const nth = (hash: string) => {
    const n = seq.get(hash) ?? 0;
    seq.set(hash, n + 1);
    return n;
  };
  return {
    maxBlock: [...txs, ...internal, ...tokens].reduce((m, x) => Math.max(m, Number(x.blockNumber)), fromBlock),
    txs: txs.map(
      (t): NativeTx => ({
        hash: t.hash,
        from: t.from,
        to: t.to || null,
        value: t.value || "0",
        fee: (BigInt(t.gasUsed || "0") * BigInt(t.gasPrice || "0")).toString(),
        success: t.isError === "0" && t.txreceipt_status !== "0",
        time: Number(t.timeStamp) * 1000,
      }),
    ),
    internal: internal.map(
      (t): InternalTx => ({
        hash: t.hash,
        index: nth(`int:${t.hash}`),
        from: t.from,
        to: t.to || null,
        value: t.value || "0",
        success: t.isError === "0",
        time: Number(t.timeStamp) * 1000,
      }),
    ),
    tokens: tokens.map(
      (t): TokenTransfer => ({
        hash: t.hash,
        logIndex: nth(`log:${t.hash}`),
        from: t.from,
        to: t.to,
        value: t.value || "0",
        decimals: t.tokenDecimal !== "" && t.tokenDecimal != null ? Number(t.tokenDecimal) : null,
        token: t.contractAddress,
        symbol: t.tokenSymbol || null,
        time: Number(t.timeStamp) * 1000,
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
  if (EVM_CHAINS[chain].routescan) {
    const lag = await routescanLagHours(chain);
    if (lag !== null && lag >= 0.5) warnings.push(`${name}: 조회 서버(Routescan)가 최근 약 ${lag < 48 ? `${Math.round(lag)}시간` : `${Math.round(lag / 24)}일`} 기록을 아직 반영하지 않았습니다. 그 사이의 거래가 빠져 잔고 대조에서 차이가 날 수 있으니 나중에 다시 동기화하세요.`);
  }
  // 이미 받은 적 있는 토큰 (가짜 전송 판별용)
  const knownTokens = new Set<string>();
  for (const e of await db.ledger.where("sourceId").equals(source.id).toArray()) {
    if (e.assetKey.startsWith(`${chain}:`) && !e.amount.startsWith("-")) knownTokens.add(e.assetKey);
  }
  const { entries, skipped } = buildEvmEntries({ sourceId: source.id, chain, address, txs, internal, tokens, knownTokens });
  const spoofed = skipped.filter((s) => s.spoof).length;
  if (spoofed > 0) warnings.push(`${name}: 받은 적 없는 토큰을 보냈다는 가짜 기록 ${spoofed}건을 제외했습니다 (주소 오염 사기). 비슷한 주소로 송금하지 않도록 주의하세요.`);
  if (skipped.length > spoofed) {
    warnings.push(`${name}: ${skipped.length - spoofed}건은 수량을 해석하지 못해 제외했습니다`);
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
