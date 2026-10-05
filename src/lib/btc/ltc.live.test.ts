// 실데이터: 최근 블록에서 거래가 적당한(3~40건) 라이트코인 주소를 골라 전체 내역 → 원장 → 실제 잔고 대사
import { it } from "vitest";
import Decimal from "@/lib/decimal";
import { buildBtcEntries } from "@/lib/ledger/btc-build";
import { Esplora } from "./esplora";
import { UTXO_COINS } from "./coins";

const base = UTXO_COINS.ltc.esplora;
const get = async <T>(path: string): Promise<T> => (await fetch(`${base}${path}`)).json() as Promise<T>;

it("litecoin live reconcile", { timeout: 300_000 }, async () => {
  const tip = await (await fetch(`${base}/blocks/tip/hash`)).text();
  const txs = await get<{ vout: { scriptpubkey_address?: string }[] }[]>(`/block/${tip}/txs`);
  const candidates = [...new Set(txs.flatMap((t) => t.vout.map((o) => o.scriptpubkey_address).filter((a): a is string => !!a)))].slice(0, 40);
  for (const address of candidates) {
    const s = await get<{ chain_stats: { tx_count: number; funded_txo_sum: number; spent_txo_sum: number } }>(`/address/${address}`);
    if (s.chain_stats.tx_count < 3 || s.chain_stats.tx_count > 40) continue;
    const history = await new Esplora(base).addressTxs(address);
    const { entries } = buildBtcEntries({ sourceId: "live", coin: "ltc", addresses: new Set([address]), txs: history });
    const ledger = entries.reduce((sum, e) => sum.plus(e.amount), new Decimal(0));
    const actual = new Decimal(s.chain_stats.funded_txo_sum - s.chain_stats.spent_txo_sum).div(1e8);
    console.info(`\n${address}: txs ${s.chain_stats.tx_count}, entries ${entries.length}`);
    console.info(`${actual.minus(ledger).isZero() ? "OK  " : "DIFF"} LTC ledger=${ledger.toFixed()} actual=${actual.toFixed()}`);
    return;
  }
  console.info("적당한 주소를 찾지 못함");
});
