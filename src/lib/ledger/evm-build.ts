import Decimal from "@/lib/decimal";
import type { EvmChain, LedgerEntry } from "@/lib/db";
import { EVM_CHAINS, evmAssetKey, fromBaseUnits } from "@/lib/sources/evm";

// Alchemy alchemy_getAssetTransfers 응답 항목
export interface AlchemyTransfer {
  uniqueId: string;
  hash: string;
  blockNum: string; // hex
  from: string;
  to: string | null;
  value: number | null;
  asset: string | null;
  category: string;
  rawContract: { value: string | null; address: string | null; decimal: string | null };
  metadata: { blockTimestamp: string };
}

export interface TxReceipt {
  transactionHash: string;
  from: string;
  gasUsed: string; // hex
  effectiveGasPrice: string; // hex
  l1Fee?: string; // hex, OP 스택 L2 (Base, Optimism)
}

export interface TokenMeta {
  symbol: string | null;
  decimals: number | null;
}

export interface BuildInput {
  sourceId: string;
  chain: EvmChain;
  address: string;
  incoming: AlchemyTransfer[];
  outgoing: AlchemyTransfer[];
  receipts: TxReceipt[];
  // rawContract.decimal이 비어 있는 토큰의 메타데이터 (소문자 컨트랙트 주소 → 메타)
  tokenMeta: Record<string, TokenMeta>;
}

export interface BuildResult {
  entries: LedgerEntry[];
  skipped: { uniqueId: string; reason: string }[];
}

export function buildEvmEntries(input: BuildInput): BuildResult {
  const { sourceId, chain, tokenMeta } = input;
  const address = input.address.toLowerCase();
  const { name: location, native } = EVM_CHAINS[chain];

  const entries: LedgerEntry[] = [];
  const skipped: BuildResult["skipped"] = [];
  const txTime = new Map<string, number>();

  const legs: [AlchemyTransfer, "in" | "out"][] = [
    ...input.incoming.map((t) => [t, "in"] as [AlchemyTransfer, "in"]),
    ...input.outgoing.map((t) => [t, "out"] as [AlchemyTransfer, "out"]),
  ];

  for (const [t, dir] of legs) {
    const time = Date.parse(t.metadata.blockTimestamp);
    txTime.set(t.hash, time);

    const contract = t.rawContract.address?.toLowerCase() ?? null;
    let decimals: number | null;
    let symbol: string;
    if (!contract) {
      decimals = 18;
      symbol = native;
    } else {
      const meta = tokenMeta[contract];
      decimals = t.rawContract.decimal != null ? parseInt(t.rawContract.decimal, 16) : (meta?.decimals ?? null);
      symbol = (t.asset ?? meta?.symbol ?? "UNKNOWN").toUpperCase();
    }

    let amount: Decimal;
    if (t.rawContract.value != null && decimals != null) {
      amount = fromBaseUnits(t.rawContract.value, decimals);
    } else if (t.value != null) {
      amount = new Decimal(t.value); // 정밀도가 떨어질 수 있는 대체 값
    } else {
      skipped.push({ uniqueId: t.uniqueId, reason: "수량 또는 소수점 자릿수를 알 수 없음" });
      continue;
    }
    if (amount.isZero()) continue;

    entries.push({
      id: `${sourceId}:${chain}:${t.uniqueId}:${dir}`,
      sourceId,
      location,
      time,
      asset: symbol,
      assetKey: evmAssetKey(chain, contract),
      amount: (dir === "in" ? amount : amount.neg()).toString(),
      kind: "transfer",
      groupId: `${chain}:${t.hash}`,
      txHash: t.hash,
      counterparty: (dir === "in" ? t.from : t.to) ?? undefined,
    });
  }

  // 내가 보낸 트랜잭션의 가스비
  for (const r of input.receipts) {
    if (r.from.toLowerCase() !== address) continue;
    const wei =
      BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice) + (r.l1Fee ? BigInt(r.l1Fee) : BigInt(0));
    if (wei === BigInt(0)) continue;
    entries.push({
      id: `${sourceId}:${chain}:${r.transactionHash}:gas`,
      sourceId,
      location,
      time: txTime.get(r.transactionHash) ?? 0,
      asset: native,
      assetKey: evmAssetKey(chain, null),
      amount: fromBaseUnits(`0x${wei.toString(16)}`, 18).neg().toString(),
      kind: "fee",
      groupId: `${chain}:${r.transactionHash}`,
      txHash: r.transactionHash,
    });
  }

  classifyGroups(entries);
  return { entries, skipped };
}

// 같은 트랜잭션 안에서 서로 다른 자산이 들어오고 나가면 스왑(trade)으로 본다.
// 자기 자신에게 보낸 경우(같은 자산이 들어오고 나감)는 이체로 남긴다.
function classifyGroups(entries: LedgerEntry[]) {
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    if (e.kind === "fee") continue;
    groups.set(e.groupId, [...(groups.get(e.groupId) ?? []), e]);
  }
  for (const legs of groups.values()) {
    const inKeys = new Set(legs.filter((e) => !e.amount.startsWith("-")).map((e) => e.assetKey));
    const outKeys = new Set(legs.filter((e) => e.amount.startsWith("-")).map((e) => e.assetKey));
    const isSwap =
      inKeys.size > 0 && outKeys.size > 0 && new Set([...inKeys, ...outKeys]).size > 1;
    if (isSwap) legs.forEach((e) => (e.kind = "trade"));
  }
}
