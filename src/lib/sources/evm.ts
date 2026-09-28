import Decimal from "@/lib/decimal";
import type { EvmChain, EvmSource } from "@/lib/db";
import type { RawBalance } from "@/lib/sources/types";

export const EVM_CHAINS: Record<
  EvmChain,
  { name: string; network: string; native: string; explorer: string }
> = {
  eth: { name: "Ethereum", network: "eth-mainnet", native: "ETH", explorer: "https://etherscan.io" },
  arb: { name: "Arbitrum", network: "arb-mainnet", native: "ETH", explorer: "https://arbiscan.io" },
  base: { name: "Base", network: "base-mainnet", native: "ETH", explorer: "https://basescan.org" },
  opt: { name: "Optimism", network: "opt-mainnet", native: "ETH", explorer: "https://optimistic.etherscan.io" },
  polygon: { name: "Polygon", network: "polygon-mainnet", native: "POL", explorer: "https://polygonscan.com" },
};

export function evmAssetKey(chain: EvmChain, contract: string | null) {
  return `${chain}:${contract ? contract.toLowerCase() : "native"}`;
}

type RpcCall = { method: string; params: unknown[] };

// Alchemy는 CORS를 허용하므로 사용자의 키로 브라우저에서 직접 호출한다.
export async function rpcBatch<T>(
  alchemyKey: string,
  network: string,
  calls: RpcCall[],
): Promise<T[]> {
  if (calls.length === 0) return [];
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, ...c })));

  // 무료 요금제는 초당 사용량(CU) 한도가 있어 429가 나면 잠시 기다렸다가 재시도한다.
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`https://${network}.g.alchemy.com/v2/${alchemyKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.status !== 429 || attempt >= 5) break;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  if (!res.ok) throw new Error(`Alchemy HTTP ${res.status}`);
  const data: { id: number; result?: T; error?: { message: string } }[] =
    await res.json();
  data.sort((a, b) => a.id - b.id);
  return data.map((d) => {
    if (d.error) throw new Error(d.error.message);
    return d.result as T;
  });
}

export function fromBaseUnits(hex: string, decimals: number) {
  return new Decimal(BigInt(hex).toString()).div(new Decimal(10).pow(decimals));
}

async function fetchChain(
  alchemyKey: string,
  address: string,
  chain: EvmChain,
): Promise<RawBalance[]> {
  const { name, network, native } = EVM_CHAINS[chain];
  const out: RawBalance[] = [];

  const [nativeHex] = await rpcBatch<string>(alchemyKey, network, [
    { method: "eth_getBalance", params: [address, "latest"] },
  ]);
  const nativeAmount = fromBaseUnits(nativeHex, 18);
  if (!nativeAmount.isZero()) {
    out.push({
      location: name,
      asset: native,
      rawAsset: native,
      assetKey: evmAssetKey(chain, null),
      amount: nativeAmount,
    });
  }

  const tokens: { contractAddress: string; tokenBalance: string }[] = [];
  let pageKey: string | undefined;
  do {
    const [page] = await rpcBatch<{
      tokenBalances: { contractAddress: string; tokenBalance: string }[];
      pageKey?: string;
    }>(alchemyKey, network, [
      {
        method: "alchemy_getTokenBalances",
        params: pageKey ? [address, "erc20", { pageKey }] : [address, "erc20"],
      },
    ]);
    tokens.push(...page.tokenBalances.filter((t) => BigInt(t.tokenBalance) > BigInt(0)));
    pageKey = page.pageKey;
  } while (pageKey);

  const metas = await rpcBatch<{ symbol: string | null; decimals: number | null }>(
    alchemyKey,
    network,
    tokens.map((t) => ({
      method: "alchemy_getTokenMetadata",
      params: [t.contractAddress],
    })),
  );

  tokens.forEach((t, i) => {
    const meta = metas[i];
    if (meta?.decimals == null) return;
    out.push({
      location: name,
      asset: (meta.symbol ?? "UNKNOWN").toUpperCase(),
      rawAsset: t.contractAddress,
      assetKey: evmAssetKey(chain, t.contractAddress),
      amount: fromBaseUnits(t.tokenBalance, meta.decimals),
    });
  });

  return out;
}

export async function fetchEvmBalances(
  source: EvmSource,
  alchemyKey: string,
): Promise<RawBalance[]> {
  const results = await Promise.all(
    source.chains.map((c) => fetchChain(alchemyKey, source.address, c)),
  );
  return results.flat();
}
