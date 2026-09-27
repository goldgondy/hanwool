import Decimal from "decimal.js";
import type { EvmChain, EvmSource } from "@/lib/db";
import type { RawBalance } from "@/lib/sources/types";

export const EVM_CHAINS: Record<
  EvmChain,
  { name: string; network: string; native: string }
> = {
  eth: { name: "Ethereum", network: "eth-mainnet", native: "ETH" },
  arb: { name: "Arbitrum", network: "arb-mainnet", native: "ETH" },
  base: { name: "Base", network: "base-mainnet", native: "ETH" },
  opt: { name: "Optimism", network: "opt-mainnet", native: "ETH" },
  polygon: { name: "Polygon", network: "polygon-mainnet", native: "POL" },
};

type RpcCall = { method: string; params: unknown[] };

// Alchemy는 CORS를 허용하므로 사용자의 키로 브라우저에서 직접 호출한다.
async function rpcBatch<T>(
  alchemyKey: string,
  network: string,
  calls: RpcCall[],
): Promise<T[]> {
  if (calls.length === 0) return [];
  const res = await fetch(`https://${network}.g.alchemy.com/v2/${alchemyKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      calls.map((c, i) => ({ jsonrpc: "2.0", id: i, ...c })),
    ),
  });
  if (!res.ok) throw new Error(`Alchemy HTTP ${res.status}`);
  const data: { id: number; result?: T; error?: { message: string } }[] =
    await res.json();
  data.sort((a, b) => a.id - b.id);
  return data.map((d) => {
    if (d.error) throw new Error(d.error.message);
    return d.result as T;
  });
}

function fromBaseUnits(hex: string, decimals: number) {
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
    out.push({ location: name, asset: native, rawAsset: native, amount: nativeAmount });
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
