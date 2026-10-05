import Decimal from "@/lib/decimal";
import { loadClassifiedGroups } from "@/lib/classify/load";
import { buildTaxEvents, DEEMED_PRICE_TIME, poolOf, priceKey, priceQueries, type BuildEventsResult } from "@/lib/tax/build-events";
import { DEFAULT_POLICY, runEngine, type EngineResult } from "@/lib/tax/engine";

// 원장 + 분류 → 시세 조회 → 세금 계산. 세금 계산 화면과 절세 도구가 함께 쓴다.

export type Mode = "actual" | "simulate";

export interface Report {
  mode: Mode;
  engine: EngineResult;
  built: BuildEventsResult;
  priceCount: number;
  // 업비트·바이낸스에 없어 보조 출처(OKX·MEXC·게이트·CoinGecko) 시세를 쓴 코인과 그 출처
  fallbackPriced: { symbol: string; via: string }[];
}

// vias: 넘기면 조회 키별 시세 출처를 채운다
export async function fetchPrices(queries: { symbol: string; time: number }[], onProgress: (m: string) => void, vias?: Map<string, string>) {
  const out = new Map<string, Decimal | null>();
  for (let i = 0; i < queries.length; i += 500) {
    const chunk = queries.slice(i, i + 500);
    onProgress(`원화 시세 조회 중 (${Math.min(i + 500, queries.length)}/${queries.length})`);
    const res = await fetch("/api/prices/at", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: chunk }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `시세 조회 실패 (HTTP ${res.status})`);
    (body.results as { krw: string | null; via: string | null }[]).forEach((r, j) => {
      const key = priceKey(chunk[j].symbol, chunk[j].time);
      out.set(key, r.krw ? new Decimal(r.krw) : null);
      if (vias && r.via) vias.set(key, r.via);
    });
  }
  return out;
}

export async function calculate(mode: Mode, onProgress: (m: string) => void = () => {}): Promise<Report> {
  onProgress("분류 불러오는 중");
  const groups = await loadClassifiedGroups();

  const queries = priceQueries(groups);
  if (mode === "actual") {
    // 의제취득가용 2026년 말 시세
    const pools = new Set(groups.flatMap((g) => (g.classification.category === "spam" ? [] : g.entries.map((e) => poolOf(e.asset)))));
    for (const p of pools) queries.push({ symbol: p, time: DEEMED_PRICE_TIME });
  }
  const vias = new Map<string, string>();
  const prices = await fetchPrices(queries, onProgress, vias);
  const fallback = new Map<string, string>();
  for (const q of queries) {
    const via = vias.get(priceKey(q.symbol, q.time));
    if (via?.includes("보조 출처") && !fallback.has(q.symbol)) fallback.set(q.symbol, via.split(" ")[0]);
  }

  onProgress("계산 중");
  const built = buildTaxEvents(groups, prices);
  const prices2026: Record<string, Decimal | undefined> = {};
  for (const p of built.pools) prices2026[p] = prices.get(priceKey(p, DEEMED_PRICE_TIME)) ?? undefined;

  const engine = runEngine(built.events, prices2026, DEFAULT_POLICY, mode === "simulate" ? { taxStart: 0, applyDeemed: false } : {});
  return { mode, engine, built, priceCount: queries.length, fallbackPriced: [...fallback].map(([symbol, via]) => ({ symbol, via })) };
}

// 현재 원화 시세 (업비트 현재가, 없으면 바이낸스 × 환율)
export async function currentPrices(symbols: string[]): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  if (!symbols.length) return out;
  const res = await fetch(`/api/prices?symbols=${encodeURIComponent(symbols.join(","))}`);
  if (!res.ok) throw new Error(`현재 시세 조회 실패 (HTTP ${res.status})`);
  const body: { prices: Record<string, { krw: string } | null> } = await res.json();
  for (const [s, p] of Object.entries(body.prices)) if (p) out.set(s, new Decimal(p.krw));
  return out;
}
