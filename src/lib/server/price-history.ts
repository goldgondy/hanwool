import { neon } from "@neondatabase/serverless";
import Decimal from "@/lib/decimal";

// 과거 원화 시세 (1시간 단위). 서버에서만 사용한다.
// 조회 순서: Neon 캐시 → 업비트 KRW 1시간 캔들 → 바이낸스 USDT 1시간 캔들 × 원/달러
// 원/달러: 업비트 KRW-USDT(상장 이후) → ECB 기준 환율(frankfurter, 일 단위)
// 시각 t의 가격 = t가 속한 1시간 캔들의 종가. 거래가 없던 시간은 직전 종가로 채운다.

const HOUR = 3_600_000;
const WINDOW = 200; // 한 번에 받는 캔들 수 (업비트·바이낸스 최대치)
const LEAD = 23; // 창 시작을 앞당겨 첫 시간에 거래가 없어도 직전 종가로 채울 수 있게 한다

// 같은 가격으로 보는 자산
const ALIASES: Record<string, string> = { WETH: "ETH", WBTC: "BTC", CBBTC: "BTC", WPOL: "POL", MATIC: "POL", WMATIC: "POL" };
// 달러 스테이블코인: 업비트 시세가 없으면 1달러로 본다
const STABLES = new Set(["USDT", "USDC", "DAI", "FDUSD", "USDE", "TUSD", "USDS", "PYUSD"]);

type Src = "upbit_krw" | "binance_usdt";

export interface PriceQuery {
  symbol: string;
  time: number;
}
export interface PriceResult {
  krw: string | null;
  via: string | null;
}

const db = () => neon(process.env.DATABASE_URL!);
const floorHour = (t: number) => Math.floor(t / HOUR) * HOUR;
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let upbitMarkets: { at: number; symbols: Set<string> } | null = null;
async function upbitListed(): Promise<Set<string>> {
  if (upbitMarkets && Date.now() - upbitMarkets.at < HOUR) return upbitMarkets.symbols;
  const res = await fetch("https://api.upbit.com/v1/market/all", { cache: "no-store" });
  const markets: { market: string }[] = await res.json();
  const symbols = new Set(markets.filter((m) => m.market.startsWith("KRW-")).map((m) => m.market.slice(4)));
  upbitMarkets = { at: Date.now(), symbols };
  return symbols;
}

// 창 하나(start부터 WINDOW시간)의 캔들 종가. 마켓이 없으면 null.
async function fetchWindow(src: Src, symbol: string, start: number): Promise<Map<number, Decimal> | null> {
  const out = new Map<number, Decimal>();
  if (src === "upbit_krw") {
    const url = `https://api.upbit.com/v1/candles/minutes/60?market=KRW-${symbol}&to=${iso(start + WINDOW * HOUR)}&count=${WINDOW}`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`업비트 시세 조회 실패 (HTTP ${res.status})`);
    for (const c of (await res.json()) as { candle_date_time_utc: string; trade_price: number }[]) {
      out.set(Date.parse(`${c.candle_date_time_utc}Z`), new Decimal(c.trade_price));
    }
    await sleep(120); // 업비트 캔들 API: 초당 10회 제한
  } else {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&startTime=${start}&limit=${WINDOW}`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 400) return null; // 없는 심볼
    if (!res.ok) throw new Error(`바이낸스 시세 조회 실패 (HTTP ${res.status})`);
    for (const k of (await res.json()) as [number, string, string, string, string][]) out.set(k[0], new Decimal(k[4]));
  }
  return out;
}

// src·symbol의 여러 시각 가격. 캐시에 없으면 창 단위로 받아 빈 시간을 채운 뒤 저장한다.
async function resolveHours(src: Src, symbol: string, hours: number[]): Promise<Map<number, Decimal>> {
  const sql = db();
  const result = new Map<number, Decimal>();
  const unique = [...new Set(hours)].sort((a, b) => a - b);
  if (unique.length === 0) return result;

  const rows = (await sql`
    select hour, price from prices_hourly
    where src = ${src} and symbol = ${symbol} and hour = any(${unique.map(iso)}::timestamptz[])`) as { hour: string | Date; price: string }[];
  for (const r of rows) result.set(new Date(r.hour).getTime(), new Decimal(r.price));

  const nowHour = floorHour(Date.now());
  let missing = unique.filter((h) => !result.has(h) && h <= nowHour);
  while (missing.length > 0) {
    const start = missing[0] - LEAD * HOUR;
    const end = start + (WINDOW - 1) * HOUR;
    const candles = await fetchWindow(src, symbol, start);
    if (!candles) break; // 마켓 없음

    // 창 안의 모든 시간을 직전 종가로 채운다 (첫 캔들 이전 시간은 비워 둔다)
    const filled: [number, Decimal][] = [];
    let last: Decimal | null = null;
    for (let h = start; h <= Math.min(end, nowHour); h += HOUR) {
      last = candles.get(h) ?? last;
      if (last) filled.push([h, last]);
    }
    if (filled.length > 0) {
      await sql`
        insert into prices_hourly (src, symbol, hour, price)
        select ${src}, ${symbol}, h, p
        from unnest(${filled.map(([h]) => iso(h))}::timestamptz[], ${filled.map(([, p]) => p.toString())}::numeric[]) as t(h, p)
        on conflict do nothing`;
    }
    for (const [h, p] of filled) if (!result.has(h)) result.set(h, p);
    missing = missing.filter((h) => h > end);
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

// 시각별 원/달러: 업비트 KRW-USDT가 있으면 그것을, 없으면 ECB 환율을 쓴다.
async function usdKrw(hours: number[]): Promise<Map<number, { rate: Decimal; via: string }>> {
  const out = new Map<number, { rate: Decimal; via: string }>();
  const upbit = (await upbitListed()).has("USDT") ? await resolveHours("upbit_krw", "USDT", hours) : new Map();
  const needFx = hours.filter((h) => !upbit.has(h));
  const fx = await resolveFx(needFx.map((h) => iso(h).slice(0, 10)));
  for (const h of hours) {
    const u = upbit.get(h);
    if (u) out.set(h, { rate: u, via: "업비트 USDT" });
    else {
      const f = fx.get(iso(h).slice(0, 10));
      if (f) out.set(h, { rate: f, via: "ECB 환율" });
    }
  }
  return out;
}

export async function pricesAt(queries: PriceQuery[]): Promise<PriceResult[]> {
  const nowHour = floorHour(Date.now());
  const norm = queries.map((q) => {
    const s = q.symbol.toUpperCase();
    return { symbol: ALIASES[s] ?? s, hour: floorHour(q.time) };
  });
  const results: PriceResult[] = queries.map(() => ({ krw: null, via: null }));
  const pending = (i: number) => results[i].krw === null && norm[i].hour <= nowHour;

  const bySymbol = (idx: number[]) => {
    const m = new Map<string, number[]>();
    for (const i of idx) m.set(norm[i].symbol, [...(m.get(norm[i].symbol) ?? []), i]);
    return m;
  };

  // 1) 업비트 원화 캔들
  const listed = await upbitListed();
  for (const [symbol, idx] of bySymbol(norm.map((_, i) => i).filter((i) => pending(i) && listed.has(norm[i].symbol)))) {
    const prices = await resolveHours("upbit_krw", symbol, idx.map((i) => norm[i].hour));
    for (const i of idx) {
      const p = prices.get(norm[i].hour);
      if (p) results[i] = { krw: p.toString(), via: `업비트 KRW-${symbol}` };
    }
  }

  // 2) 바이낸스 USDT 캔들 × 원/달러, 스테이블코인은 1달러 × 원/달러
  const rest = norm.map((_, i) => i).filter(pending);
  const usd = new Map<number, { price: Decimal; via: string }>();
  for (const [symbol, idx] of bySymbol(rest)) {
    if (STABLES.has(symbol)) {
      for (const i of idx) usd.set(i, { price: new Decimal(1), via: `${symbol}=1달러` });
      continue;
    }
    const prices = await resolveHours("binance_usdt", symbol, idx.map((i) => norm[i].hour));
    for (const i of idx) {
      const p = prices.get(norm[i].hour);
      if (p) usd.set(i, { price: p, via: `바이낸스 ${symbol}USDT` });
    }
  }
  const rates = await usdKrw([...usd.keys()].map((i) => norm[i].hour));
  for (const [i, u] of usd) {
    const r = rates.get(norm[i].hour);
    if (r) results[i] = { krw: u.price.mul(r.rate).toString(), via: `${u.via} × ${r.via}` };
  }

  return results;
}
