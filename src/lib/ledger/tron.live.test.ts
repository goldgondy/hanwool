// 실데이터: 최근 USDT 수신자 중 거래가 적당한 개인 지갑을 골라 전체 내역 → 원장 → 실제 잔고 대사
import { it } from "vitest";
import { buildTronEntries } from "./tron-build";
import { tronBalances } from "./tron-sync";
import { reconcile } from "./reconcile";
import { toBase58 } from "@/lib/tron/address";
import { TronGrid, type Trc20Transfer, type TronTx } from "@/lib/tron/trongrid";

it("tron live reconcile", { timeout: 600_000 }, async () => {
  const g = new TronGrid();
  const ev = await g.get<{ data: { result: { to: string } }[] }>(
    "/v1/contracts/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t/events?event_name=Transfer&limit=50",
  );
  const candidates = [...new Set(ev.data.map((e) => toBase58(e.result.to)))];
  // 방금 받은 USDT가 확정(약 1분)되기 전이면 원장(확정분만)과 실제 잔고가 잠시 어긋난다
  await new Promise((r) => setTimeout(r, 90_000));

  for (const address of candidates.slice(0, 15)) {
    const first = await g.get<{ data: TronTx[]; meta?: { links?: { next?: string } } }>(`/v1/accounts/${address}/transactions?limit=200&only_confirmed=true`);
    if (first.meta?.links?.next || first.data.length < 3) continue; // 200건 넘는 주소(거래소 등)·너무 적은 주소는 건너뜀
    const txs = first.data;
    const trc20 = await g.pages<Trc20Transfer>(`/v1/accounts/${address}/transactions/trc20?limit=200&only_confirmed=true`);
    if (trc20.length > 600) continue;

    const built = buildTronEntries({ sourceId: "live", address, txs, trc20 });
    const symbols = new Map(built.entries.map((e) => [e.assetKey, e.asset]));
    const balances = await tronBalances(g, address, symbols);
    const rows = reconcile(built.entries, balances);
    console.log(`\n${address}: txs ${txs.length}, trc20 ${trc20.length}, entries ${built.entries.length}, skipped ${built.skipped}, unknown ${JSON.stringify(built.unknownTypes)}`);
    for (const r of rows) console.log(`${r.diff.isZero() ? "OK  " : "DIFF"} ${r.asset.padEnd(8)} ledger=${r.ledger.toFixed()} actual=${r.actual.toFixed()} diff=${r.diff.toFixed()}`);
    return;
  }
  console.log("적당한 주소를 찾지 못함");
});
