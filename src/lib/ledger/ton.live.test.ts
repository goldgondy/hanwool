// 실데이터: 최근 USDT(TON)를 주고받은 지갑 중 거래가 적당한 주소의 전체 내역 → 원장 → 실제 잔고 대사
import { it } from "vitest";
import Decimal from "@/lib/decimal";
import { collectTon, tonBalances } from "./ton-sync";
import { toncenter } from "@/lib/ton/api";

const USDT_MASTER = "0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE";

it("ton live reconcile", { timeout: 900_000 }, async () => {
  const recent = await toncenter<{ jetton_transfers: { source: string; destination: string }[] }>("/jetton/transfers", { jetton_master: USDT_MASTER, limit: "100", sort: "desc" });
  for (const owner of [...new Set(recent.jetton_transfers.flatMap((t) => [t.destination, t.source]))].slice(0, 60)) {
    const txs = await toncenter<{ transactions: unknown[] }>("/transactions", { account: owner, limit: "120", sort: "desc" });
    if (txs.transactions.length < 5 || txs.transactions.length >= 120) continue;
    const { entries } = await collectTon("live", owner, { txLt: "0", jettonLt: "0" });
    const sums = new Map<string, { asset: string; v: Decimal }>();
    for (const e of entries) sums.set(e.assetKey, { asset: e.asset, v: (sums.get(e.assetKey)?.v ?? new Decimal(0)).plus(e.amount) });
    const actual = new Map((await tonBalances(owner)).map((b) => [b.assetKey, b.amount]));
    console.info(`\n${owner}: txs ${txs.transactions.length}, entries ${entries.length}`);
    for (const key of new Set([...sums.keys(), ...actual.keys()])) {
      const l = sums.get(key)?.v ?? new Decimal(0);
      const a = actual.get(key) ?? new Decimal(0);
      console.info(`${a.minus(l).isZero() ? "OK  " : "DIFF"} ${(sums.get(key)?.asset ?? key).padEnd(8)} ledger=${l.toFixed()} actual=${a.toFixed()} diff=${a.minus(l).toFixed()}`);
    }
    return;
  }
  console.info("적당한 주소를 찾지 못함");
});
