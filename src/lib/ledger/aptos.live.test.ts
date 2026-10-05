// 실데이터: 최근 Aptos USDT를 받은 주소 중 기록이 적당한 주소의 전체 내역 → 원장 → 실제 잔고 대사
import { it } from "vitest";
import Decimal from "@/lib/decimal";
import { aptosQuery } from "@/lib/aptos/api";
import { APTOS_USDT } from "./aptos-build";
import { aptosRawBalances, collectAptos } from "./aptos-sync";

it("aptos live reconcile", { timeout: 900_000 }, async () => {
  const r = await aptosQuery<{ fungible_asset_activities: { owner_address: string }[] }>(
    `query($t: String!) { fungible_asset_activities(where: { asset_type: { _eq: $t } }, order_by: { transaction_version: desc }, limit: 100) { owner_address } }`,
    { t: APTOS_USDT },
  );
  for (const owner of [...new Set(r.fungible_asset_activities.map((a) => a.owner_address))].slice(0, 15)) {
    const c = await aptosQuery<{ fungible_asset_activities: unknown[] }>(
      `query($o: String!) { fungible_asset_activities(where: { owner_address: { _eq: $o } }, limit: 201) { transaction_version } }`,
      { o: owner },
    ).catch(() => null);
    if (!c) continue;
    const n = c.fungible_asset_activities.length;
    if (n < 6 || n > 200) continue;
    const { entries } = await collectAptos("live", owner, -1);
    const sums = new Map<string, { asset: string; v: Decimal }>();
    for (const e of entries) sums.set(e.assetKey, { asset: e.asset, v: (sums.get(e.assetKey)?.v ?? new Decimal(0)).plus(e.amount) });
    const actual = new Map((await aptosRawBalances(owner)).map((b) => [b.assetKey, b.amount]));
    console.info(`\n${owner}: activities ${n}, entries ${entries.length}, hashes ${entries.filter((e) => e.txHash).length}`);
    for (const key of new Set([...sums.keys(), ...actual.keys()])) {
      const l = sums.get(key)?.v ?? new Decimal(0);
      const a = actual.get(key) ?? new Decimal(0);
      console.info(`${a.minus(l).isZero() ? "OK  " : "DIFF"} ${(sums.get(key)?.asset ?? key).padEnd(8)} ledger=${l.toFixed()} actual=${a.toFixed()} diff=${a.minus(l).toFixed()}`);
    }
    return;
  }
  console.info("적당한 주소를 찾지 못함");
});
