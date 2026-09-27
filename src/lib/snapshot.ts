import Decimal from "decimal.js";
import { db, getSetting, type Holding, type Snapshot } from "@/lib/db";
import { fetchBinanceBalances } from "@/lib/sources/binance";
import { fetchEvmBalances } from "@/lib/sources/evm";
import { fetchOkxBalances } from "@/lib/sources/okx";
import type { RawBalance } from "@/lib/sources/types";
import { isUnlocked } from "@/lib/vault";

type PriceResponse = {
  source: string;
  prices: Record<string, { krw: string; via: string } | null>;
};

async function fetchPrices(symbols: string[]): Promise<PriceResponse> {
  const res = await fetch(
    `/api/prices?symbols=${encodeURIComponent(symbols.join(","))}`,
  );
  if (!res.ok) throw new Error(`시세 조회 실패 (HTTP ${res.status})`);
  return res.json();
}

export async function takeSnapshot(note?: string): Promise<Snapshot> {
  const sources = await db.sources.toArray();
  const alchemyKey = await getSetting("alchemyKey");

  if (sources.some((s) => s.kind !== "evm") && !isUnlocked()) {
    throw new Error("거래소 키를 쓰려면 먼저 잠금을 해제하세요");
  }

  const errors: Snapshot["errors"] = [];
  const collected: (RawBalance & { sourceId: string; sourceLabel: string })[] = [];

  await Promise.all(
    sources.map(async (s) => {
      try {
        let balances: RawBalance[];
        if (s.kind === "binance") {
          balances = await fetchBinanceBalances(s, (message) =>
            errors.push({ sourceLabel: s.label, message }),
          );
        } else if (s.kind === "okx") {
          balances = await fetchOkxBalances(s);
        } else {
          if (!alchemyKey) throw new Error("Alchemy API 키가 설정되지 않았습니다");
          balances = await fetchEvmBalances(s, alchemyKey);
        }
        collected.push(
          ...balances.map((b) => ({ ...b, sourceId: s.id, sourceLabel: s.label })),
        );
      } catch (e) {
        errors.push({
          sourceLabel: s.label,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );

  const symbols = [...new Set(collected.map((c) => c.asset))];
  const { source: priceSource, prices } =
    symbols.length > 0 ? await fetchPrices(symbols) : { source: "-", prices: {} };

  let total = new Decimal(0);
  const holdings: Holding[] = collected.map((c) => {
    const p = prices[c.asset];
    const value = p ? c.amount.mul(p.krw) : null;
    if (value) total = total.plus(value);
    return {
      sourceId: c.sourceId,
      sourceLabel: c.sourceLabel,
      location: c.location,
      asset: c.asset,
      rawAsset: c.rawAsset,
      amount: c.amount.toString(),
      priceKrw: p?.krw ?? null,
      priceVia: p?.via ?? null,
      valueKrw: value ? value.toFixed(0) : null,
    };
  });

  holdings.sort((a, b) =>
    new Decimal(b.valueKrw ?? 0).cmp(new Decimal(a.valueKrw ?? 0)),
  );

  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    takenAt: Date.now(),
    priceSource,
    holdings,
    totalKrw: total.toFixed(0),
    errors,
    note,
  };
  await db.snapshots.add(snapshot);
  return snapshot;
}
