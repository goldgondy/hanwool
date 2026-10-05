import Decimal from "@/lib/decimal";
import { db, isExchangeKind, type Holding, type Snapshot } from "@/lib/db";
import { fetchBtcBalances } from "@/lib/ledger/btc-sync";
import { csvSourcesShadowedByApi } from "@/lib/ledger/dedup";
import { fetchSolanaBalances } from "@/lib/ledger/solana-sync";
import { fetchXrpBalances } from "@/lib/ledger/xrp-sync";
import { fetchTronBalances } from "@/lib/ledger/tron-sync";
import { fetchBinanceBalances } from "@/lib/sources/binance";
import { fetchEvmBalances } from "@/lib/sources/evm";
import { fetchXapiBalances } from "@/lib/sources/exchanges";
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

// CSV로 가져온 계정은 거래소에 잔고를 물을 수 없으므로 원장 합계를 잔고로 본다.
// 전체 기간의 명세서를 가져왔다면 실제 잔고와 같다. 법정화폐는 제외한다.
async function ledgerBalances(sourceId: string, label: string): Promise<RawBalance[]> {
  const sums = new Map<string, { asset: string; amount: Decimal }>();
  for (const e of await db.ledger.where("sourceId").equals(sourceId).toArray()) {
    if (e.assetKey.startsWith("fiat:")) continue;
    const cur = sums.get(e.assetKey) ?? { asset: e.asset, amount: new Decimal(0) };
    cur.amount = cur.amount.plus(e.amount);
    sums.set(e.assetKey, cur);
  }
  return [...sums.entries()]
    .filter(([, v]) => v.amount.gt(0))
    .map(([assetKey, v]) => ({ location: `${label} (CSV 원장 합계)`, asset: v.asset, rawAsset: v.asset, assetKey, amount: v.amount }));
}

export async function takeSnapshot(note?: string): Promise<Snapshot> {
  const sources = await db.sources.toArray();

  if (sources.some((s) => isExchangeKind(s.kind)) && !isUnlocked()) {
    throw new Error("거래소 키를 쓰려면 먼저 잠금을 해제하세요");
  }

  const errors: Snapshot["errors"] = [];
  const collected: (RawBalance & { sourceId: string; sourceLabel: string })[] = [];
  // API 계정과 연결된 CSV 계정은 같은 계정이므로 잔고를 두 번 더하지 않는다 (API 실시간 잔고만 사용)
  const shadowed = csvSourcesShadowedByApi(sources);

  await Promise.all(
    sources.filter((s) => !shadowed.has(s.id)).map(async (s) => {
      try {
        let balances: RawBalance[];
        if (s.kind === "binance") {
          balances = await fetchBinanceBalances(s, (message) =>
            errors.push({ sourceLabel: s.label, message }),
          );
        } else if (s.kind === "okx") {
          balances = await fetchOkxBalances(s);
        } else if (s.kind === "xapi") {
          balances = await fetchXapiBalances(s, (message) => errors.push({ sourceLabel: s.label, message }));
        } else if (s.kind === "btc") {
          balances = await fetchBtcBalances(s);
        } else if (s.kind === "csv" || s.kind === "manual") {
          balances = await ledgerBalances(s.id, s.label);
        } else if (s.kind === "tron") {
          balances = await fetchTronBalances(s);
        } else if (s.kind === "solana") {
          balances = await fetchSolanaBalances(s);
        } else if (s.kind === "xrp") {
          balances = await fetchXrpBalances(s);
        } else {
          balances = await fetchEvmBalances(s);
        }
        // 원화·달러 등 법정화폐 잔고는 가상자산 보유 현황에서 뺀다
        collected.push(
          ...balances.filter((b) => !b.assetKey.startsWith("fiat:")).map((b) => ({ ...b, sourceId: s.id, sourceLabel: s.label })),
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
