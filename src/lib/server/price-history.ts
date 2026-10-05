import { neon } from "@neondatabase/serverless";
import Decimal from "@/lib/decimal";
import { PRICE_ALIASES, STABLECOINS } from "@/lib/assets";

// 과거 원화 시세. 서버에서만 사용한다.
// 시각 t의 가격 = t 직전에 마감된 캔들의 종가 (거래 이후의 가격을 쓰지 않는다).
// 조회 순서: 업비트 KRW 1분 → 업비트 KRW 1시간 → 바이낸스 USDT 1분·1시간 (× 원/달러)
//   → 업비트·바이낸스에 없는 코인: OKX(1분·1시간) → MEXC(1분·1시간) → 게이트(1시간, 약 1년 이내) → CoinGecko(1시간, 심볼이 같은 코인 중 시가총액 1위)
//   같은 심볼의 다른 토큰일 수 있어 보조 출처의 가격은 출처를 함께 돌려준다.
// 원/달러: 업비트 KRW-USDT(상장 이후) → ECB 기준 환율(frankfurter, 일 단위)
// 한 번 받은 캔들은 Neon에 캐시한다. 거래가 없던 구간은 직전 종가로 채워 저장한다.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const WINDOW = 200; // 한 번에 받는 캔들 수 (업비트·바이낸스 최대치)
const LEAD = 30; // 창 시작을 앞당겨 첫 캔들에 거래가 없어도 직전 종가로 채울 수 있게 한다

type Src = "upbit_krw" | "binance_usdt" | "okx_usdt" | "mexc_usdt" | "gate_usdt" | "coingecko_usd";

// 출처별 한 번에 받는 캔들 수와 쓸 수 있는 단위
const WIN: Record<Src, number> = { upbit_krw: WINDOW, binance_usdt: WINDOW, okx_usdt: 100, mexc_usdt: WINDOW, gate_usdt: WINDOW, coingecko_usd: 24 * 80 };
const UNITS: Record<Src, Unit[]> = {
  upbit_krw: [MINUTE, HOUR],
  binance_usdt: [MINUTE, HOUR],
  okx_usdt: [MINUTE, HOUR],
  mexc_usdt: [MINUTE, HOUR],
  gate_usdt: [HOUR], // 게이트 1분 캔들은 최근 1만 개(약 1주)만 준다
  coingecko_usd: [HOUR], // 80일 범위로 받으면 1시간 간격
};
// 바이낸스 다음에 차례로 찾아볼 보조 출처 (USDT·달러 가격)
const FALLBACKS: Src[] = ["okx_usdt", "mexc_usdt", "gate_usdt", "coingecko_usd"];
const SRC_LABEL: Record<Src, string> = {
  upbit_krw: "업비트",
  binance_usdt: "바이낸스",
  okx_usdt: "OKX",
  mexc_usdt: "MEXC",
  gate_usdt: "게이트",
  coingecko_usd: "CoinGecko",
};

// CoinGecko 심볼 → 코인 ID (같은 심볼이 여럿이면 시가총액 1위). 없으면 null
const cgIds = new Map<string, string | null>();
async function coingeckoId(symbol: string): Promise<string | null> {
  if (cgIds.has(symbol)) return cgIds.get(symbol)!;
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&symbols=${symbol.toLowerCase()}&per_page=10`, { cache: "no-store" });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const list = (await res.json()) as { id: string; market_cap: number | null }[];
  const best = list.filter((c) => (c.market_cap ?? 0) > 0).sort((a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0))[0];
  cgIds.set(symbol, best?.id ?? null);
  await sleep(2500); // 공개 API 분당 호출 제한
  return best?.id ?? null;
}
type Unit = typeof MINUTE | typeof HOUR;

export interface PriceQuery {
  symbol: string;
  time: number;
}
export interface PriceResult {
  krw: string | null;
  via: string | null;
}

const db = () => neon(process.env.DATABASE_URL!);
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// t 직전에 마감된 캔들의 시작 시각
const lastClosed = (t: number, unit: Unit) => Math.floor(t / unit) * unit - unit;
const unitLabel = (unit: Unit) => (unit === MINUTE ? "1분" : "1시간");

let upbitMarkets: { at: number; symbols: Set<string> } | null = null;
async function upbitListed(): Promise<Set<string>> {
  if (upbitMarkets && Date.now() - upbitMarkets.at < HOUR) return upbitMarkets.symbols;
  const res = await fetch("https://api.upbit.com/v1/market/all", { cache: "no-store" });
  const markets: { market: string }[] = await res.json();
  const symbols = new Set(markets.filter((m) => m.market.startsWith("KRW-")).map((m) => m.market.slice(4)));
  upbitMarkets = { at: Date.now(), symbols };
  return symbols;
}

// 창 하나(start부터 WINDOW개)의 캔들 종가. 마켓이 없으면 null.
async function fetchWindow(src: Src, symbol: string, unit: Unit, start: number): Promise<Map<number, Decimal> | null> {
  const out = new Map<number, Decimal>();
  if (src === "upbit_krw") {
    const path = unit === MINUTE ? "minutes/1" : "minutes/60";
    const url = `https://api.upbit.com/v1/candles/${path}?market=KRW-${symbol}&to=${iso(start + WIN[src] * unit)}&count=${WIN[src]}`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`업비트 시세 조회 실패 (HTTP ${res.status})`);
    for (const c of (await res.json()) as { candle_date_time_utc: string; trade_price: number }[]) {
      out.set(Date.parse(`${c.candle_date_time_utc}Z`), new Decimal(c.trade_price));
    }
    await sleep(120); // 업비트 캔들 API: 초당 10회 제한
  } else if (src === "binance_usdt") {
    const interval = unit === MINUTE ? "1m" : "1h";
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&startTime=${start}&limit=${WIN[src]}`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 400) return null; // 없는 심볼
    if (!res.ok) throw new Error(`바이낸스 시세 조회 실패 (HTTP ${res.status})`);
    for (const k of (await res.json()) as [number, string, string, string, string][]) out.set(k[0], new Decimal(k[4]));
  } else if (src === "okx_usdt") {
    // after = 이 시각보다 이전 캔들 (최신순)
    const bar = unit === MINUTE ? "1m" : "1H";
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${symbol}-USDT&bar=${bar}&after=${start + WIN[src] * unit}&limit=${WIN[src]}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`OKX 시세 조회 실패 (HTTP ${res.status})`);
    const body = (await res.json()) as { code: string; data: string[][] };
    if (body.code === "51001") return null; // 없는 거래쌍
    if (body.code !== "0") throw new Error(`OKX 시세 조회 실패 (${body.code})`);
    for (const k of body.data) out.set(Number(k[0]), new Decimal(k[4]));
    await sleep(110); // 초당 10회 제한
  } else if (src === "mexc_usdt") {
    const interval = unit === MINUTE ? "1m" : "60m";
    const end = start + WIN[src] * unit - 1;
    const url = `https://api.mexc.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&startTime=${start}&endTime=${end}&limit=${WIN[src]}`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 400) return null; // 없는 심볼
    if (!res.ok) throw new Error(`MEXC 시세 조회 실패 (HTTP ${res.status})`);
    // 너무 오래된 1분 캔들은 요청 구간을 무시하고 최근 것을 주므로 구간 밖은 버린다
    for (const k of (await res.json()) as [number, string, string, string, string][]) if (k[0] >= start && k[0] <= end) out.set(k[0], new Decimal(k[4]));
  } else if (src === "gate_usdt") {
    const from = Math.floor(start / 1000);
    const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${symbol}_USDT&interval=1h&from=${from}&to=${from + (WIN[src] - 1) * 3600}`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 400) {
      const body = (await res.json().catch(() => ({}))) as { label?: string };
      if (body.label === "INVALID_CURRENCY_PAIR") return null;
      return out; // 너무 오래된 구간 (약 1년 넘음): 이 창은 비워 둔다
    }
    if (!res.ok) throw new Error(`게이트 시세 조회 실패 (HTTP ${res.status})`);
    // [시각(초), 거래대금, 종가, 고가, 저가, 시가, 거래량, 마감 여부]
    for (const k of (await res.json()) as string[][]) out.set(Number(k[0]) * 1000, new Decimal(k[2]));
  } else {
    const id = await coingeckoId(symbol);
    if (!id) return null;
    const from = Math.floor(start / 1000);
    const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart/range?vs_currency=usd&from=${from}&to=${from + WIN[src] * 3600}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`CoinGecko 시세 조회 실패 (HTTP ${res.status})`);
    // 시점 가격을 그 시각 직전에 마감된 1시간 캔들의 종가로 본다
    for (const [t, p] of ((await res.json()) as { prices: [number, number][] }).prices) out.set(Math.floor(t / HOUR) * HOUR - HOUR, new Decimal(p));
    await sleep(2500);
  }
  return out;
}

async function loadCached(src: Src, symbol: string, unit: Unit, keys: number[]) {
  const sql = db();
  const stamps = keys.map(iso);
  const rows = (
    unit === MINUTE
      ? await sql`select minute as t, price from prices_minute where src = ${src} and symbol = ${symbol} and minute = any(${stamps}::timestamptz[])`
      : await sql`select hour as t, price from prices_hourly where src = ${src} and symbol = ${symbol} and hour = any(${stamps}::timestamptz[])`
  ) as { t: string | Date; price: string }[];
  return new Map(rows.map((r) => [new Date(r.t).getTime(), new Decimal(r.price)]));
}

async function saveCached(src: Src, symbol: string, unit: Unit, rows: [number, Decimal][]) {
  if (rows.length === 0) return;
  const sql = db();
  const stamps = rows.map(([t]) => iso(t));
  const prices = rows.map(([, p]) => p.toString());
  if (unit === MINUTE) {
    await sql`
      insert into prices_minute (src, symbol, minute, price)
      select ${src}, ${symbol}, t, p from unnest(${stamps}::timestamptz[], ${prices}::numeric[]) as x(t, p)
      on conflict do nothing`;
  } else {
    await sql`
      insert into prices_hourly (src, symbol, hour, price)
      select ${src}, ${symbol}, t, p from unnest(${stamps}::timestamptz[], ${prices}::numeric[]) as x(t, p)
      on conflict do nothing`;
  }
}

// 여러 캔들 시작 시각의 종가. 캐시에 없으면 창 단위로 받아 빈 캔들을 채운 뒤 저장한다.
async function resolveCandles(src: Src, symbol: string, unit: Unit, keys: number[]): Promise<Map<number, Decimal>> {
  const unique = [...new Set(keys)].sort((a, b) => a - b);
  if (unique.length === 0) return new Map();
  const result = await loadCached(src, symbol, unit, unique);

  const lastDone = lastClosed(Date.now(), unit);
  let missing = unique.filter((k) => !result.has(k) && k <= lastDone);
  while (missing.length > 0) {
    const start = missing[0] - LEAD * unit;
    const end = start + (WIN[src] - 1) * unit;
    const candles = await fetchWindow(src, symbol, unit, start);
    if (!candles) break; // 마켓 없음

    // 창 안의 모든 캔들을 직전 종가로 채운다 (첫 캔들 이전은 비워 둔다)
    const filled: [number, Decimal][] = [];
    let last: Decimal | null = null;
    for (let k = start; k <= Math.min(end, lastDone); k += unit) {
      last = candles.get(k) ?? last;
      if (last) filled.push([k, last]);
    }
    await saveCached(src, symbol, unit, filled);
    for (const [k, p] of filled) if (!result.has(k)) result.set(k, p);
    missing = missing.filter((k) => k > end);
  }
  return result;
}

// ECB 원/달러 (UTC 날짜 기준). 주말·휴일은 직전 영업일 값.
async function resolveFx(days: string[]): Promise<Map<string, Decimal>> {
  const sql = db();
  const result = new Map<string, Decimal>();
  const unique = [...new Set(days)].sort();
  if (unique.length === 0) return result;

  const rows = (await sql`select day::text as day, rate from fx_usdkrw_daily where day = any(${unique}::date[])`) as { day: string; rate: string }[];
  for (const r of rows) result.set(r.day, new Decimal(r.rate));

  const today = new Date().toISOString().slice(0, 10);
  let missing = unique.filter((d) => !result.has(d) && d <= today);
  while (missing.length > 0) {
    const from = new Date(Date.parse(missing[0]) - 10 * 86_400_000).toISOString().slice(0, 10);
    const toMs = Math.min(Date.parse(missing[0]) + 180 * 86_400_000, Date.parse(today));
    const to = new Date(toMs).toISOString().slice(0, 10);
    const res = await fetch(`https://api.frankfurter.app/${from}..${to}?from=USD&to=KRW`, { cache: "no-store" });
    if (!res.ok) throw new Error(`환율 조회 실패 (HTTP ${res.status})`);
    const data: { rates: Record<string, { KRW: number }> } = await res.json();

    const filled: [string, Decimal][] = [];
    let last: Decimal | null = null;
    for (let t = Date.parse(from); t <= toMs; t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (data.rates[d]) last = new Decimal(data.rates[d].KRW);
      if (last) filled.push([d, last]);
    }
    if (filled.length > 0) {
      await sql`
        insert into fx_usdkrw_daily (day, rate)
        select d, r from unnest(${filled.map(([d]) => d)}::date[], ${filled.map(([, r]) => r.toString())}::numeric[]) as t(d, r)
        on conflict do nothing`;
    }
    for (const [d, r] of filled) if (!result.has(d)) result.set(d, r);
    missing = missing.filter((d) => d > to);
  }
  return result;
}

// 한 출처에서 시각별 가격을 찾는다. 1분 캔들 → 없으면 1시간 캔들.
async function priceFrom(src: Src, symbol: string, times: number[]): Promise<Map<number, { price: Decimal; unit: Unit }>> {
  const out = new Map<number, { price: Decimal; unit: Unit }>();
  for (const unit of UNITS[src]) {
    const pending = times.filter((t) => !out.has(t));
    if (pending.length === 0) break;
    const candles = await resolveCandles(src, symbol, unit, pending.map((t) => lastClosed(t, unit)));
    for (const t of pending) {
      const p = candles.get(lastClosed(t, unit));
      if (p) out.set(t, { price: p, unit });
    }
  }
  return out;
}

// 시각별 원/달러: 업비트 KRW-USDT가 있으면 그것을, 없으면 ECB 환율을 쓴다.
async function usdKrw(times: number[]): Promise<Map<number, { rate: Decimal; via: string }>> {
  const out = new Map<number, { rate: Decimal; via: string }>();
  const upbit = (await upbitListed()).has("USDT") ? await priceFrom("upbit_krw", "USDT", times) : new Map();
  const fx = await resolveFx(times.filter((t) => !upbit.has(t)).map((t) => iso(t).slice(0, 10)));
  for (const t of times) {
    const u = upbit.get(t);
    if (u) out.set(t, { rate: u.price, via: `업비트 USDT ${unitLabel(u.unit)}` });
    else {
      const f = fx.get(iso(t).slice(0, 10));
      if (f) out.set(t, { rate: f, via: "ECB 환율" });
    }
  }
  return out;
}

export async function pricesAt(queries: PriceQuery[]): Promise<PriceResult[]> {
  const now = Date.now();
  const norm = queries.map((q) => {
    const s = q.symbol.toUpperCase();
    return { symbol: PRICE_ALIASES[s] ?? s, time: q.time };
  });
  const results: PriceResult[] = queries.map(() => ({ krw: null, via: null }));
  const pending = (i: number) => results[i].krw === null && norm[i].time <= now;

  const bySymbol = (idx: number[]) => {
    const m = new Map<string, number[]>();
    for (const i of idx) m.set(norm[i].symbol, [...(m.get(norm[i].symbol) ?? []), i]);
    return m;
  };

  // 1) 업비트 원화
  const listed = await upbitListed();
  for (const [symbol, idx] of bySymbol(norm.map((_, i) => i).filter((i) => pending(i) && listed.has(norm[i].symbol)))) {
    const prices = await priceFrom("upbit_krw", symbol, idx.map((i) => norm[i].time));
    for (const i of idx) {
      const p = prices.get(norm[i].time);
      if (p) results[i] = { krw: p.price.toString(), via: `업비트 KRW-${symbol} ${unitLabel(p.unit)}` };
    }
  }

  // 법정화폐 달러(거래소 달러 거래의 대가): 스테이블코인과 달리 ECB 기준 환율을 그대로 쓴다.
  const usdFiat = norm.map((_, i) => i).filter((i) => pending(i) && norm[i].symbol === "USD");
  if (usdFiat.length > 0) {
    const fx = await resolveFx(usdFiat.map((i) => iso(norm[i].time).slice(0, 10)));
    for (const i of usdFiat) {
      const r = fx.get(iso(norm[i].time).slice(0, 10));
      if (r) results[i] = { krw: r.toString(), via: "ECB 원/달러 환율" };
    }
  }

  // 2) 바이낸스 USDT × 원/달러, 스테이블코인은 1달러 × 원/달러
  const usd = new Map<number, { price: Decimal; via: string }>();
  for (const [symbol, idx] of bySymbol(norm.map((_, i) => i).filter((i) => pending(i) && norm[i].symbol !== "USD"))) {
    if (STABLECOINS.has(symbol)) {
      for (const i of idx) usd.set(i, { price: new Decimal(1), via: `${symbol}=1달러` });
      continue;
    }
    const prices = await priceFrom("binance_usdt", symbol, idx.map((i) => norm[i].time));
    for (const i of idx) {
      const p = prices.get(norm[i].time);
      if (p) usd.set(i, { price: p.price, via: `바이낸스 ${symbol}USDT ${unitLabel(p.unit)}` });
    }
  }

  // 3) 업비트·바이낸스에 없는 코인: 보조 출처를 차례로 찾는다. 한 출처가 실패해도 계산은 계속한다 (그 코인만 시세 없음).
  for (const src of FALLBACKS) {
    const left = norm.map((_, i) => i).filter((i) => pending(i) && !usd.has(i) && norm[i].symbol !== "USD" && !STABLECOINS.has(norm[i].symbol));
    for (const [symbol, idx] of bySymbol(left)) {
      try {
        const prices = await priceFrom(src, symbol, idx.map((i) => norm[i].time));
        for (const i of idx) {
          const p = prices.get(norm[i].time);
          if (p) usd.set(i, { price: p.price, via: `${SRC_LABEL[src]} ${symbol} ${unitLabel(p.unit)} (보조 출처)` });
        }
      } catch {
        // 보조 출처 장애·호출 제한: 다음 출처로 넘어간다
      }
    }
  }
  const rates = await usdKrw([...new Set([...usd.keys()].map((i) => norm[i].time))]);
  for (const [i, u] of usd) {
    const r = rates.get(norm[i].time);
    if (r) results[i] = { krw: u.price.mul(r.rate).toString(), via: `${u.via} × ${r.via}` };
  }

  return results;
}
