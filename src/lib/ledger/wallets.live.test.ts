// 실데이터 일괄 점검: 각 블록체인에서 최근 활동한 실제 지갑을 몇 개씩 골라 전체 내역 → 원장 → 실제 잔고를 대조한다.
// 실행: npm run test:live -- src/lib/ledger/wallets.live.test.ts --silent=false
import { describe, it } from "vitest";
import Decimal from "@/lib/decimal";
import type { EvmChain, LedgerEntry } from "@/lib/db";
import { Esplora, DEFAULT_ESPLORA } from "@/lib/btc/esplora";
import { BTC_ASSET_KEY, buildBtcEntries } from "@/lib/ledger/btc-build";
import { buildEvmEntries } from "@/lib/ledger/evm-build";
import { fetchChainHistory } from "@/lib/ledger/evm-sync";
import { reconcile } from "@/lib/ledger/reconcile";
import { OFFICIAL_STABLES } from "@/lib/classify/classifier";
import { EVM_CHAINS, blockscoutGet, fetchEvmBalances } from "@/lib/sources/evm";
import type { RawBalance } from "@/lib/sources/types";

const PER_CHAIN = 3;
// 2026-10-02 점검에서 차이가 났던 주소 (주소 오염 사기·사칭 토큰 처리 후 다시 확인)
const RECHECK: Partial<Record<EvmChain, string[]>> = {
  eth: ["0x05875bCAa0a421B8700b25D7e6210C95fd3eF2c6", "0xD3327213F777277c23c8e3E2F87b98461E979958"],
};

function report(label: string, entries: LedgerEntry[], balances: RawBalance[]) {
  const rows = reconcile(entries, balances);
  const bad = rows.filter((r) => !r.diff.isZero());
  console.log(`\n[${bad.length ? "DIFF" : "OK  "}] ${label}: 자산 ${rows.length}개, 일치 ${rows.length - bad.length}, 항목 ${entries.length}`);
  for (const r of bad) console.log(`   ${r.asset.padEnd(10)} ledger=${r.ledger.toFixed()} actual=${r.actual.toFixed()} diff=${r.diff.toFixed()} (${r.assetKey})`);
}

describe("wallets live", () => {
  for (const chain of Object.keys(EVM_CHAINS) as EvmChain[]) {
    it(`evm ${chain}`, { timeout: 1_800_000 }, async () => {
      // 후보: 다시 확인할 주소 + 최근 거래를 보낸 주소 + 최근 공식 USDC를 받은 주소
      const recent = await blockscoutGet<{ items: { from: { hash: string; is_contract?: boolean } }[] }>(chain, "/api/v2/transactions", { filter: "validated" });
      const usdc = [...OFFICIAL_STABLES.USDC].find((k) => k.startsWith(`${chain}:`))!.split(":")[1];
      const transfers = await blockscoutGet<{ items: { to: { hash: string; is_contract?: boolean } }[] }>(chain, `/api/v2/tokens/${usdc}/transfers`);
      const candidates = [
        ...(RECHECK[chain] ?? []).map((hash) => ({ hash, is_contract: false })),
        ...recent.items.map((t) => t.from),
        ...(transfers?.items ?? []).map((t) => t.to),
      ];
      const tried = new Set<string>();
      let done = 0;
      for (const cand of candidates) {
        const a = cand.hash;
        if (done >= PER_CHAIN + (RECHECK[chain]?.length ?? 0) || tried.has(a.toLowerCase()) || cand.is_contract) continue;
        tried.add(a.toLowerCase());
        tried.add(a);
        const c = await blockscoutGet<{ transactions_count: string; token_transfers_count: string } | null>(chain, `/api/v2/addresses/${a}/counters`);
        const txs = Number(c?.transactions_count ?? 0);
        const tokens = Number(c?.token_transfers_count ?? 0);
        if (txs < 5 || txs > 150 || tokens > 300) continue; // 봇·거래소처럼 너무 많거나 너무 적은 주소 제외
        try {
          const h = await fetchChainHistory(a, chain);
          const { entries } = buildEvmEntries({ sourceId: "live", chain, address: a, ...h });
          const balances = await fetchEvmBalances({ id: "live", kind: "evm", label: "", address: a, chains: [chain], createdAt: 0 });
          report(`${EVM_CHAINS[chain].name} ${a} (tx ${txs}, 토큰 전송 ${tokens})`, entries, balances);
          done++;
        } catch (e) {
          console.log(`\n[ERR ] ${chain} ${a}: ${e instanceof Error ? e.message : e}`);
        }
      }
    });
  }

  it("bitcoin", { timeout: 1_800_000 }, async () => {
    const api = DEFAULT_ESPLORA;
    const get = async <T,>(p: string) => (await fetch(`${api}${p}`)).json() as Promise<T>;
    const tip = await (await fetch(`${api}/blocks/tip/hash`)).text();
    const txs = await get<{ vout: { scriptpubkey_address?: string }[] }[]>(`/block/${tip}/txs/0`);
    const esplora = new Esplora(api);
    const tried = new Set<string>();
    let done = 0;
    for (const t of txs) {
      for (const o of t.vout) {
        const a = o.scriptpubkey_address;
        if (!a || done >= PER_CHAIN || tried.has(a)) continue;
        tried.add(a);
        await new Promise((r) => setTimeout(r, 500));
        const info = await get<{ chain_stats: { tx_count: number; funded_txo_sum: number; spent_txo_sum: number }; mempool_stats: { tx_count: number } }>(`/address/${a}`);
        if (info.chain_stats.tx_count < 3 || info.chain_stats.tx_count > 60 || info.mempool_stats.tx_count > 0) continue;
        const history = (await esplora.addressTxs(a)).filter((x) => x.status.confirmed);
        const { entries } = buildBtcEntries({ sourceId: "live", addresses: new Set([a]), txs: history });
        const sats = info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum;
        const balances: RawBalance[] = sats ? [{ location: "Bitcoin", asset: "BTC", rawAsset: "BTC", assetKey: BTC_ASSET_KEY, amount: new Decimal(sats).div(1e8) }] : [];
        report(`Bitcoin ${a} (tx ${info.chain_stats.tx_count})`, entries, balances);
        done++;
      }
    }
  });
});
