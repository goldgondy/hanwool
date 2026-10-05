// 실데이터: 아발란체·플라스마 (Routescan) — 최근 USDT를 받은 주소 중 거래가 적당한 주소의 전체 내역 → 원장 → 노드 잔고와 대사
import { it } from "vitest";
import Decimal from "@/lib/decimal";
import type { EvmChain } from "@/lib/db";
import { buildEvmEntries } from "./evm-build";
import { fetchChainHistory } from "./evm-sync";
import { evmAssetKey, evmRpc, fromBaseUnits, routescanGet } from "@/lib/sources/evm";

const USDT: Record<string, string> = { avax: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", plasma: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb" };

async function pick(chain: EvmChain): Promise<string | undefined> {
  const recent = await routescanGet<{ to: string }>(chain, { module: "account", action: "tokentx", contractaddress: USDT[chain], page: "1", offset: "40", sort: "desc" });
  for (const a of [...new Set(recent.map((r) => r.to))]) {
    const txs = await routescanGet(chain, { module: "account", action: "txlist", address: a, page: "1", offset: "200", sort: "asc" });
    const toks = await routescanGet(chain, { module: "account", action: "tokentx", address: a, page: "1", offset: "200", sort: "asc" });
    if (txs.length >= 3 && txs.length < 150 && toks.length < 150) return a;
  }
}

async function check(chain: EvmChain) {
  const address = await pick(chain);
  if (!address) return console.info(`${chain}: 적당한 주소를 찾지 못함`);
  const h = await fetchChainHistory(address, chain, 0);
  const { entries, skipped } = buildEvmEntries({ sourceId: "live", chain, address, ...h });
  const sums = new Map<string, Decimal>();
  for (const e of entries) sums.set(e.assetKey, (sums.get(e.assetKey) ?? new Decimal(0)).plus(e.amount));
  console.info(`\n${chain} ${address}: txs ${h.txs.length}, internal ${h.internal.length}, tokens ${h.tokens.length}, entries ${entries.length}, skipped ${skipped.length}`);
  const balanceOf = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  for (const [key, ledger] of sums) {
    const contract = key.split(":")[1];
    let actual: Decimal;
    if (contract === "native") actual = fromBaseUnits((await evmRpc<string>(chain, "eth_getBalance", [address, "latest"])) ?? "0x0", 18);
    else {
      const raw = await evmRpc<string>(chain, "eth_call", [{ to: contract, data: balanceOf }, "latest"]);
      const dec = await evmRpc<string>(chain, "eth_call", [{ to: contract, data: "0x313ce567" }, "latest"]);
      if (!raw || raw === "0x" || !dec || dec === "0x") continue;
      actual = fromBaseUnits(raw, parseInt(dec, 16));
    }
    const sym = entries.find((e) => e.assetKey === key)?.asset ?? key;
    const diff = actual.minus(ledger);
    console.info(`${diff.isZero() ? "OK  " : "DIFF"} ${sym.padEnd(8)} ledger=${ledger.toFixed()} actual=${actual.toFixed()} diff=${diff.toFixed()}`);
  }
  void evmAssetKey;
}

it("avalanche live reconcile", { timeout: 300_000 }, () => check("avax"));
it("plasma live reconcile", { timeout: 300_000 }, () => check("plasma"));
