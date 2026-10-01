import { describe, expect, it } from "vitest";
import type { AddressStats, Esplora } from "./esplora";
import { confirmedBalanceSats, scanWallet } from "./scan";

const stats = (txCount: number, funded = 0, spent = 0): AddressStats => ({
  chain_stats: { funded_txo_sum: funded, spent_txo_sum: spent, tx_count: txCount },
  mempool_stats: { tx_count: 0 },
});

// 조회 서버 흉내: 주소별 통계만 돌려준다
const fakeEsplora = (table: Record<string, AddressStats>) =>
  ({ addressStats: async (a: string) => table[a] ?? stats(0) }) as unknown as Esplora;

describe("xpub을 지운 지갑 (저장된 주소 목록)", () => {
  it("저장된 주소만 조회하고, 거래 기록이 있는 주소만 남긴다", async () => {
    const esplora = fakeEsplora({ bc1qa: stats(3, 100_000, 40_000), bc1qb: stats(1, 5_000, 0), bc1qc: stats(0) });
    const used = await scanWallet({ kind: "addresses", addresses: ["bc1qa", "bc1qb", "bc1qc"] }, esplora);
    expect(used.map((u) => u.address)).toEqual(["bc1qa", "bc1qb"]);
    expect(confirmedBalanceSats(used)).toBe(BigInt(65_000));
  });
});
