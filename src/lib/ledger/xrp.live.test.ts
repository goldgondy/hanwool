// 실데이터: 최근 원장에서 거래가 적당한(5~60건) XRP 계정을 골라 전체 내역 → 원장 → 실제 잔고 대사.
// 송금 계정 하나, DEX 교환(OfferCreate) 계정 하나. 원장 합계와 실제 잔고가 정확히 같아야 한다.
import { expect, it } from "vitest";
import { collectXrp, xrpBalances } from "./xrp-sync";
import { reconcile } from "./reconcile";
import { XrplRpc } from "@/lib/xrp/rpc";

const rpc = new XrplRpc();

async function historySize(account: string) {
  const r = await rpc.call<{ transactions: unknown[]; marker?: unknown }>("account_tx", { account, ledger_index_min: -1, ledger_index_max: -1, limit: 60 });
  return r.marker ? Infinity : r.transactions.length;
}

async function pick(type: string): Promise<string | undefined> {
  const tried = new Set<string>();
  const { ledger } = await rpc.call<{ ledger: { ledger_index: string } }>("ledger", { ledger_index: "validated" });
  for (let back = 0; back < 3; back++) {
    const r = await rpc.call<{ ledger: { transactions: { TransactionType: string; Account: string; Destination?: string }[] } }>("ledger", {
      ledger_index: Number(ledger.ledger_index) - back,
      transactions: true,
      expand: true,
    });
    for (const t of r.ledger.transactions) {
      if (t.TransactionType !== type) continue;
      for (const a of [t.Account, t.Destination]) {
        if (!a || tried.has(a)) continue;
        tried.add(a);
        const n = await historySize(a);
        if (n >= 5 && n <= 60) return a;
      }
    }
  }
}

async function check(type: string) {
  const address = await pick(type);
  if (!address) return console.log(`${type}: 적당한 계정을 찾지 못함`);
  const { entries, warnings } = await collectXrp(rpc, "live", address, -1);
  const rows = reconcile(entries, await xrpBalances(rpc, address));
  console.log(`\n${type} ${address}: entries ${entries.length} ${warnings.join(" ")}`);
  for (const r of rows) console.info(`${r.diff.isZero() ? "OK  " : "DIFF"} ${r.asset.padEnd(10)} ledger=${r.ledger.toFixed()} actual=${r.actual.toFixed()} diff=${r.diff.toFixed()}`);
  if (!warnings.length) expect(rows.every((r) => r.diff.isZero())).toBe(true);
}

it("xrp live reconcile: payment account", { timeout: 600_000 }, () => check("Payment"));
it("xrp live reconcile: DEX account", { timeout: 600_000 }, () => check("OfferCreate"));
