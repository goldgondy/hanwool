import type { NextRequest } from "next/server";

// 업비트 KRW 마켓 현재가. 공용 시세 데이터라 서버에서 조회해도 사용자 정보가 노출되지 않는다.
// TODO: 의제취득가 기준 시가(국세청 고시 사업자 공시가)가 확정되면 해당 기준으로 교체.

const UPBIT = "https://api.upbit.com/v1";

// 업비트에 없는 심볼을 가격이 사실상 같은 자산으로 대체한다. 평가용 근사치다.
const PRICE_ALIASES: Record<string, string> = {
  WETH: "ETH",
  WBTC: "BTC",
  CBBTC: "BTC",
  WPOL: "POL",
  MATIC: "POL",
  USDC: "USDT",
  FDUSD: "USDT",
  DAI: "USDT",
  USDE: "USDT",
};

let marketCache: { at: number; symbols: Set<string> } | null = null;

async function krwMarkets(): Promise<Set<string>> {
  if (marketCache && Date.now() - marketCache.at < 60 * 60 * 1000) {
    return marketCache.symbols;
  }
  const res = await fetch(`${UPBIT}/market/all`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Upbit market/all HTTP ${res.status}`);
  const markets: { market: string }[] = await res.json();
  const symbols = new Set(
    markets
      .filter((m) => m.market.startsWith("KRW-"))
      .map((m) => m.market.slice(4)),
  );
  marketCache = { at: Date.now(), symbols };
  return symbols;
}

export async function GET(request: NextRequest) {
  const requested = (request.nextUrl.searchParams.get("symbols") ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 500);

  const listed = await krwMarkets();

  // 요청 심볼 → 실제 조회할 업비트 심볼
  const lookup = new Map<string, string>();
  for (const sym of requested) {
    if (listed.has(sym)) lookup.set(sym, sym);
    else if (PRICE_ALIASES[sym] && listed.has(PRICE_ALIASES[sym])) {
      lookup.set(sym, PRICE_ALIASES[sym]);
    }
  }

  const markets = [...new Set(lookup.values())];
  const tickerPrice = new Map<string, string>();
  for (let i = 0; i < markets.length; i += 100) {
    const chunk = markets.slice(i, i + 100).map((s) => `KRW-${s}`);
    const res = await fetch(`${UPBIT}/ticker?markets=${chunk.join(",")}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Upbit ticker HTTP ${res.status}`);
    const tickers: { market: string; trade_price: number }[] = await res.json();
    for (const t of tickers) {
      tickerPrice.set(t.market.slice(4), String(t.trade_price));
    }
  }

  const prices: Record<string, { krw: string; via: string } | null> = {};
  for (const sym of requested) {
    const target = lookup.get(sym);
    const krw = target ? tickerPrice.get(target) : undefined;
    prices[sym] = krw ? { krw, via: target === sym ? "Upbit" : `Upbit(${target})` } : null;
  }

  return Response.json(
    { source: "Upbit KRW 현재가", fetchedAt: Date.now(), prices },
    { headers: { "Cache-Control": "no-store" } },
  );
}
