import Decimal from "@/lib/decimal";
import { db, getSetting, type EvmChain, type EvmSource } from "@/lib/db";
import type { RawBalance } from "@/lib/sources/types";
import { OFFICIAL_STABLES } from "@/lib/classify/classifier";

// EVM 데이터는 Blockscout 공개 API로 조회한다.
// - API 키·가입이 필요 없고 CORS를 허용하므로 브라우저에서 직접 호출한다 (서버를 거치지 않음).
// - 공개 인스턴스는 요청 속도 제한이 있어 429 응답 시 재시도한다.
// - 잔고·nonce용 JSON-RPC(rpc): Base·Optimism의 Blockscout RPC는 결과를 주지 않거나 30초 넘게 걸려(2026-10-01 확인)
//   각 체인의 공식 공개 RPC를 쓴다.
// - Blockscout가 없는 체인(아발란체·플라스마)은 Routescan의 Etherscan 형식 공개 API(키 없음, CORS 허용)를 쓴다 (routescan = 체인 ID).
export const EVM_CHAINS: Record<
  EvmChain,
  { name: string; native: string; blockscout: string; rpc: string; explorer: string; routescan?: number; nodereal?: boolean }
> = {
  eth: { name: "Ethereum", native: "ETH", blockscout: "https://eth.blockscout.com", rpc: "https://eth.blockscout.com/api/eth-rpc", explorer: "https://etherscan.io" },
  arb: { name: "Arbitrum", native: "ETH", blockscout: "https://arbitrum.blockscout.com", rpc: "https://arbitrum.blockscout.com/api/eth-rpc", explorer: "https://arbiscan.io" },
  base: { name: "Base", native: "ETH", blockscout: "https://base.blockscout.com", rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
  opt: { name: "Optimism", native: "ETH", blockscout: "https://optimism.blockscout.com", rpc: "https://mainnet.optimism.io", explorer: "https://optimistic.etherscan.io" },
  polygon: { name: "Polygon", native: "POL", blockscout: "https://polygon.blockscout.com", rpc: "https://polygon.blockscout.com/api/eth-rpc", explorer: "https://polygonscan.com" },
  avax: { name: "Avalanche", native: "AVAX", blockscout: "", rpc: "https://api.avax.network/ext/bc/C/rpc", explorer: "https://snowtrace.io", routescan: 43114 },
  plasma: { name: "Plasma", native: "XPL", blockscout: "", rpc: "https://rpc.plasma.to", explorer: "https://plasmascan.to", routescan: 9745 },
  bsc: { name: "BSC", native: "BNB", blockscout: "", rpc: "", explorer: "https://bscscan.com", nodereal: true },
};

export function evmAssetKey(chain: EvmChain, contract: string | null) {
  return `${chain}:${contract ? contract.toLowerCase() : "native"}`;
}

// 공식 스테이블코인인데 이름이 다른 토큰은 같은 이름으로 맞춘다 (가격·짝짓기·사칭 판별이 이름으로 이뤄지므로).
// 예: 플라스마의 USDT0 = 테더가 발행한 USDT. 거래소는 "USDT (Plasma 네트워크)"로 출금한다.
const CANONICAL_SYMBOL: Record<string, string> = {
  "plasma:0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb": "USDT",
};
export function canonicalSymbol(chain: EvmChain, contract: string, symbol: string | null) {
  return CANONICAL_SYMBOL[evmAssetKey(chain, contract)] ?? (symbol ?? "UNKNOWN").toUpperCase();
}

// ── Routescan (Etherscan 형식) ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── NodeReal (BSC) ──
// BSC는 무료 공개 조회 서버가 없다 (Etherscan V2는 BSC가 유료, 2026-10-06 확인). BNB 체인 공식 협력사 NodeReal(MegaNode)의
// 무료 키를 사용자가 넣으면, 주소별 전송 기록(nr_getAssetTransfers: 가스비·성공 여부·토큰 소수점 포함)과 노드 조회를 쓴다. 브라우저 직접 호출 가능.
let noderealKey: string | undefined;
export function setNodeRealKey(key: string | undefined) {
  noderealKey = key?.trim() || undefined;
}
async function nodeRealUrl(): Promise<string> {
  if (!noderealKey && typeof window !== "undefined") noderealKey = (await getSetting("noderealKey")) || undefined;
  if (!noderealKey) throw new Error("BSC를 조회하려면 NodeReal 무료 API 키가 필요합니다 (연결 계정 → 이더리움 계열 지갑에서 입력)");
  return `https://bsc-mainnet.nodereal.io/v1/${encodeURIComponent(noderealKey)}`;
}
export async function hasNodeRealKey() {
  return !!noderealKey || (typeof window !== "undefined" && !!(await getSetting("noderealKey")));
}

export interface NrTransfer {
  id: number;
  category: "external" | "internal" | "20";
  blockNum: string;
  from: string;
  to: string;
  value: string; // 16진수
  asset: string;
  hash: string;
  contractAddress?: string;
  decimal?: string;
  blockTimeStamp: number;
  gasPrice?: number | string;
  gasUsed?: number | string;
  receiptsStatus?: number;
  logIndex?: number;
  traceIndex?: number;
}

export async function nodeRealTransfers(address: string, category: NrTransfer["category"], direction: "fromAddress" | "toAddress", fromBlock: number): Promise<NrTransfer[]> {
  const url = await nodeRealUrl();
  const out: NrTransfer[] = [];
  let pageKey: string | undefined;
  for (let attempt = 0; ; ) {
    const params = { category: [category], [direction]: address, ...(fromBlock > 0 ? { fromBlock: `0x${fromBlock.toString(16)}` } : {}), maxCount: "0x3e8", order: "asc", ...(pageKey ? { pageKey } : {}) };
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nr_getAssetTransfers", params: [params] }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status === 429 && attempt < 5) {
      await sleep(1000 * 2 ** attempt++);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error("NodeReal API 키가 올바르지 않습니다");
    const body = (await res.json()) as { result?: { transfers: NrTransfer[]; pageKey?: string }; error?: { message: string } };
    if (body.error) throw new Error(`BSC 조회 실패 (${body.error.message})`);
    out.push(...(body.result?.transfers ?? []));
    pageKey = body.result?.pageKey || undefined;
    if (!pageKey || (body.result?.transfers.length ?? 0) === 0) break;
    await sleep(200);
  }
  return out;
}

export async function routescanGet<T>(chain: EvmChain, params: Record<string, string>): Promise<T[]> {
  const id = EVM_CHAINS[chain].routescan!;
  const url = `https://api.routescan.io/v2/network/mainnet/evm/${id}/etherscan/api?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      throw new Error(`${EVM_CHAINS[chain].name} 조회 ${timedOut ? "시간 초과" : "실패"} (공개 서버가 응답하지 않습니다)`);
    }
    if (res.status === 429 && attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`${EVM_CHAINS[chain].name} 조회 실패 (HTTP ${res.status})`);
    const body = (await res.json()) as { status: string; message: string; result: T[] | string | null };
    if (Array.isArray(body.result)) return body.result;
    const text = `${body.message} ${body.result ?? ""}`;
    if (/no (transactions|records) found/i.test(text)) return [];
    if (/rate limit/i.test(text) && attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${EVM_CHAINS[chain].name} 조회 실패 (${text.trim()})`);
  }
}

// 조회 서버가 얼마나 뒤처졌는지 (시간). 그 체인의 공식 USDT(거래가 가장 많은 토큰)의 가장 최근 전송 시각으로 잰다.
// 2026-10-05 플라스마는 약 4일 뒤처져 최근 거래가 빠졌다. 잴 수 없으면 null.
const BUSY_TOKEN: Partial<Record<EvmChain, string>> = {
  avax: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
  plasma: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb",
};
export async function routescanLagHours(chain: EvmChain): Promise<number | null> {
  const token = BUSY_TOKEN[chain];
  if (!token) return null;
  try {
    const [last] = await routescanGet<{ timeStamp: string }>(chain, { module: "account", action: "tokentx", contractaddress: token, page: "1", offset: "1", sort: "desc" });
    return last ? (Date.now() / 1000 - Number(last.timeStamp)) / 3600 : null;
  } catch {
    return null;
  }
}

// 블록 순서(오래된 것부터)로 모든 기록을 읽는다. 한 번에 1000건, 다 차면 마지막 블록부터 다시 읽고 중복은 key로 뺀다.
export async function routescanAll<T extends { blockNumber: string }>(chain: EvmChain, action: string, address: string, fromBlock: number, key: (x: T) => string): Promise<T[]> {
  const out = new Map<string, T>();
  let start = fromBlock;
  for (;;) {
    const rows = await routescanGet<T>(chain, { module: "account", action, address, startblock: String(start), endblock: "999999999", page: "1", offset: "1000", sort: "asc" });
    for (const r of rows) out.set(key(r), r);
    await sleep(250); // 공개 API 호출 간격
    if (rows.length < 1000) break;
    const last = Number(rows[rows.length - 1].blockNumber);
    if (last === start) break; // 한 블록에 1000건 넘게 있는 극단적인 경우
    start = last;
  }
  return [...out.values()];
}

// 체인별 공식 USDT·USDC가 아닌데 이름이 USDT·USDC인 토큰 (주소 오염·사칭 스팸)
export function isFakeStable(chain: EvmChain, contract: string, symbol: string | null) {
  const official = OFFICIAL_STABLES[(symbol ?? "").trim().toUpperCase()];
  return !!official && !official.has(evmAssetKey(chain, contract));
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
      const res = await fetch(EVM_CHAINS[chain].nodereal ? await nodeRealUrl() : EVM_CHAINS[chain].rpc, {
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

// Routescan 체인: 토큰 목록은 원장에서 받은 적 있는 토큰으로, 수량은 노드에 직접 묻는다
async function fetchRoutescanChain(address: string, chain: EvmChain, sourceId: string): Promise<RawBalance[]> {
  const { name, native } = EVM_CHAINS[chain];
  const out: RawBalance[] = [];
  if (EVM_CHAINS[chain].nodereal) await nodeRealUrl(); // 키가 없으면 안내 문구로 실패
  const nativeHex = await evmRpc<string>(chain, "eth_getBalance", [address, "latest"]);
  if (nativeHex === null) throw new Error(`${name} 잔고 조회 실패 (노드가 응답하지 않습니다)`);
  const nativeAmount = fromBaseUnits(nativeHex, 18);
  if (!nativeAmount.isZero()) out.push({ location: name, asset: native, rawAsset: native, assetKey: evmAssetKey(chain, null), amount: nativeAmount });
  const tokens = new Map<string, string>();
  for (const e of await db.ledger.where("sourceId").equals(sourceId).toArray()) {
    const [c, contract] = e.assetKey.split(":");
    if (c === chain && contract !== "native") tokens.set(contract, e.asset);
  }
  const balanceOf = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  for (const [contract, symbol] of tokens) {
    const [raw, dec] = await Promise.all([
      evmRpc<string>(chain, "eth_call", [{ to: contract, data: balanceOf }, "latest"]),
      evmRpc<string>(chain, "eth_call", [{ to: contract, data: "0x313ce567" }, "latest"]),
    ]);
    if (!raw || raw === "0x" || !dec || dec === "0x") continue;
    const amount = fromBaseUnits(raw, parseInt(dec, 16));
    if (!amount.isZero()) out.push({ location: name, asset: symbol, rawAsset: contract, assetKey: evmAssetKey(chain, contract), amount });
  }
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
    // 영문·숫자가 아닌 글자로 진짜 토큰 이름을 흉내 낸 사칭 토큰(예: 키릴 문자 ՍSDС)은 잔고 값도 엉터리라 뺀다
    if (t.token.symbol && !/^[\x20-\x7E]+$/.test(t.token.symbol)) continue;
    // 이름만 USDT·USDC인 가짜 토큰도 뺀다 (원장에서도 같은 기준으로 뺀다)
    if (isFakeStable(chain, contract, t.token.symbol)) continue;
    const live = await evmRpc<string>(chain, "eth_call", [{ to: contract, data: balanceOf }, "latest"]);
    const raw = live && live !== "0x" ? live : t.value;
    const amount = fromBaseUnits(raw, Number(t.token.decimals));
    if (amount.isZero()) continue;
    out.push({
      location: name,
      asset: canonicalSymbol(chain, contract, t.token.symbol),
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
        if (EVM_CHAINS[chain].nodereal) {
          // 키가 없으면 확인하지 않고 '안 씀'으로 둔다 (키 없이 체크되면 동기화가 실패하므로)
          if (!(await hasNodeRealKey())) return { chain, status: "inactive" as const };
          const [nonce, bal] = await Promise.all([evmRpc<string>(chain, "eth_getTransactionCount", [address, "latest"]), evmRpc<string>(chain, "eth_getBalance", [address, "latest"])]);
          if (nonce === null && bal === null) return { chain, status: "unknown" as const };
          const active = (nonce !== null && parseInt(nonce, 16) > 0) || (bal !== null && BigInt(bal) > BigInt(0));
          return { chain, status: active ? ("active" as const) : ("inactive" as const) };
        }
        if (EVM_CHAINS[chain].routescan) {
          const [nonce, bal, tokens] = await Promise.all([
            evmRpc<string>(chain, "eth_getTransactionCount", [address, "latest"]),
            evmRpc<string>(chain, "eth_getBalance", [address, "latest"]),
            routescanGet(chain, { module: "account", action: "tokentx", address, page: "1", offset: "1", sort: "desc" }),
          ]);
          if (nonce === null && bal === null) return { chain, status: "unknown" as const };
          const active = (nonce !== null && parseInt(nonce, 16) > 0) || (bal !== null && BigInt(bal) > BigInt(0)) || tokens.length > 0;
          return { chain, status: active ? ("active" as const) : ("inactive" as const) };
        }
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
  const results = await Promise.all(source.chains.map((c) => (EVM_CHAINS[c].routescan || EVM_CHAINS[c].nodereal ? fetchRoutescanChain(source.address, c, source.id) : fetchChain(source.address, c))));
  return results.flat();
}
