import Decimal from "@/lib/decimal";
import type { EvmChain, EvmSource } from "@/lib/db";
import type { RawBalance } from "@/lib/sources/types";

// EVM 데이터는 Blockscout 공개 API로 조회한다.
// - API 키·가입이 필요 없고 CORS를 허용하므로 브라우저에서 직접 호출한다 (서버를 거치지 않음).
// - 공개 인스턴스는 요청 속도 제한이 있어 429 응답 시 재시도한다.
// - 잔고·nonce용 JSON-RPC(rpc): Base·Optimism의 Blockscout RPC는 결과를 주지 않거나 30초 넘게 걸려(2026-10-01 확인)
//   각 체인의 공식 공개 RPC를 쓴다.
export const EVM_CHAINS: Record<
  EvmChain,
  { name: string; native: string; blockscout: string; rpc: string; explorer: string }
> = {
  eth: { name: "Ethereum", native: "ETH", blockscout: "https://eth.blockscout.com", rpc: "https://eth.blockscout.com/api/eth-rpc", explorer: "https://etherscan.io" },
  arb: { name: "Arbitrum", native: "ETH", blockscout: "https://arbitrum.blockscout.com", rpc: "https://arbitrum.blockscout.com/api/eth-rpc", explorer: "https://arbiscan.io" },
  base: { name: "Base", native: "ETH", blockscout: "https://base.blockscout.com", rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
  opt: { name: "Optimism", native: "ETH", blockscout: "https://optimism.blockscout.com", rpc: "https://mainnet.optimism.io", explorer: "https://optimistic.etherscan.io" },
  polygon: { name: "Polygon", native: "POL", blockscout: "https://polygon.blockscout.com", rpc: "https://polygon.blockscout.com/api/eth-rpc", explorer: "https://polygonscan.com" },
};

export function evmAssetKey(chain: EvmChain, contract: string | null) {
  return `${chain}:${contract ? contract.toLowerCase() : "native"}`;
}

// 최소 단위 정수 문자열(10진수 또는 0x 16진수)을 소수로 변환한다.
export function fromBaseUnits(raw: string, decimals: number) {
  return new Decimal(BigInt(raw).toString()).div(new Decimal(10).pow(decimals));
}

// 공개 서버가 응답하지 않을 때 무한정 기다리지 않도록 요청마다 제한 시간을 둔다.
const REQUEST_TIMEOUT_MS = 20_000;

export async function blockscoutGet<T>(
  chain: EvmChain,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${EVM_CHAINS[chain].blockscout}${path}${qs ? `?${qs}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      throw new Error(`${EVM_CHAINS[chain].name} 조회 ${timedOut ? "시간 초과" : "실패"} (공개 서버가 응답하지 않습니다)`);
    }
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status === 404) return null as T; // 한 번도 쓰이지 않은 주소
    if (!res.ok) throw new Error(`${EVM_CHAINS[chain].name} 조회 실패 (HTTP ${res.status})`);
    return res.json();
  }
}

// 노드 JSON-RPC (체인별 rpc 주소). Blockscout REST의 잔고 값은 캐시라 최근 거래가 빠질 수 있어,
// 대사에 쓰는 실제 잔고는 이것으로 노드에서 직접 조회한다. 실패하면 null.
export async function evmRpc<T>(chain: EvmChain, method: string, params: unknown[]): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(EVM_CHAINS[chain].rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      const j = await res.json();
      return (j.result ?? null) as T | null;
    } catch {
      return null;
    }
  }
}

// next_page_params로 모든 페이지를 가져온다. 최신 항목부터 오며, stop이 true를 반환하면 멈춘다.
export async function blockscoutPages<T>(
  chain: EvmChain,
  path: string,
  params: Record<string, string> = {},
  stop: (item: T) => boolean = () => false,
): Promise<T[]> {
  const out: T[] = [];
  let next: Record<string, unknown> | null = null;
  do {
    const pageParams: Record<string, string> = { ...params };
    for (const [k, v] of Object.entries(next ?? {})) pageParams[k] = String(v);
    const page: { items: T[]; next_page_params: Record<string, unknown> | null } | null =
      await blockscoutGet(chain, path, pageParams);
    if (!page) return out;
    for (const item of page.items) {
      if (stop(item)) return out;
      out.push(item);
    }
    next = page.next_page_params;
  } while (next);
  return out;
}

async function fetchChain(address: string, chain: EvmChain): Promise<RawBalance[]> {
  const { name, native } = EVM_CHAINS[chain];
  const out: RawBalance[] = [];

  const [info, tokens] = await Promise.all([
    blockscoutGet<{ coin_balance: string | null } | null>(chain, `/api/v2/addresses/${address}`),
    blockscoutGet<
      { value: string; token: { address?: string; address_hash?: string; symbol: string | null; decimals: string | null; type: string } }[] | null
    >(chain, `/api/v2/addresses/${address}/token-balances`),
  ]);

  // 네이티브 잔고는 노드에서 직접 조회하고, 실패하면 REST의 캐시 값을 쓴다.
  const liveNative = await evmRpc<string>(chain, "eth_getBalance", [address, "latest"]);
  const nativeAmount = fromBaseUnits(liveNative ?? info?.coin_balance ?? "0", 18);
  if (!nativeAmount.isZero()) {
    out.push({ location: name, asset: native, rawAsset: native, assetKey: evmAssetKey(chain, null), amount: nativeAmount });
  }

  // 토큰 목록은 REST로 찾고, 수량은 balanceOf로 컨트랙트에 직접 묻는다.
  const balanceOf = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  for (const t of tokens ?? []) {
    const contract = t.token.address ?? t.token.address_hash;
    if (t.token.type !== "ERC-20" || !contract || t.token.decimals == null) continue;
    const live = await evmRpc<string>(chain, "eth_call", [{ to: contract, data: balanceOf }, "latest"]);
    const raw = live && live !== "0x" ? live : t.value;
    const amount = fromBaseUnits(raw, Number(t.token.decimals));
    if (amount.isZero()) continue;
    out.push({
      location: name,
      asset: (t.token.symbol ?? "UNKNOWN").toUpperCase(),
      rawAsset: contract,
      assetKey: evmAssetKey(chain, contract),
      amount,
    });
  }
  return out;
}

export type ChainActivity = "active" | "inactive" | "unknown";

// 주소가 실제로 쓰인 체인을 찾는다: 보낸 트랜잭션이 있거나, 잔고·토큰·토큰 전송 기록이 있으면 사용한 것으로 본다.
// Blockscout는 한 번도 쓰이지 않은 주소에 404를 준다. 서버가 응답하지 않으면 "unknown"으로 알려 사용자가 판단하게 한다
// (서버 문제로 실제 쓴 체인을 빠뜨리면 안 된다).
export async function detectActiveChains(address: string): Promise<{ chain: EvmChain; status: ChainActivity }[]> {
  return Promise.all(
    (Object.keys(EVM_CHAINS) as EvmChain[]).map(async (chain) => {
      try {
        const [info, nonce] = await Promise.all([
          blockscoutGet<{ coin_balance: string | null; has_tokens?: boolean; has_token_transfers?: boolean } | null>(
            chain,
            `/api/v2/addresses/${address}`,
          ),
          evmRpc<string>(chain, "eth_getTransactionCount", [address, "latest"]),
        ]);
        const active =
          (nonce !== null && parseInt(nonce, 16) > 0) ||
          (!!info && (BigInt(info.coin_balance ?? "0") > BigInt(0) || !!info.has_tokens || !!info.has_token_transfers));
        return { chain, status: active ? "active" : "inactive" };
      } catch {
        return { chain, status: "unknown" as const };
      }
    }),
  );
}

export async function fetchEvmBalances(source: EvmSource): Promise<RawBalance[]> {
  const results = await Promise.all(source.chains.map((c) => fetchChain(source.address, c)));
  return results.flat();
}
