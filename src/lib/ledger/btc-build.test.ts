import Decimal from "@/lib/decimal";
import { describe, expect, it } from "vitest";
import type { EsploraTx } from "@/lib/btc/esplora";
import { buildBtcEntries } from "./btc-build";

const A1 = "bc1qmine1";
const A2 = "bc1qmine2"; // 거스름돈 주소
const EXT = "bc1qexternal";
const OTHER = "bc1qother";
const addresses = new Set([A1, A2]);

let n = 0;
const tx = (vin: [string, number][], vout: [string, number][], fee: number, confirmed = true): EsploraTx => ({
  txid: `tx${n++}`.padEnd(64, "0"),
  fee,
  status: { confirmed, block_height: 800000, block_time: 1_800_000_000 },
  vin: vin.map(([a, v]) => ({ is_coinbase: false, prevout: { scriptpubkey_address: a, value: v } })),
  vout: vout.map(([a, v]) => ({ scriptpubkey_address: a, value: v })),
});

const build = (txs: EsploraTx[]) => buildBtcEntries({ sourceId: "s1", addresses, txs });
const summary = (r: ReturnType<typeof build>) => r.entries.map((e) => [e.kind, e.amount]);

describe("buildBtcEntries", () => {
  it("외부에서 받으면 받은 금액만 기록한다", () => {
    const r = build([tx([[EXT, 1_000_000]], [[A1, 500_000], [EXT, 490_000]], 10_000)]);
    expect(summary(r)).toEqual([["transfer", "0.005"]]);
    expect(r.entries[0].counterparty).toBe(EXT);
    expect(r.entries[0].time).toBe(1_800_000_000_000);
  });

  it("보내면 거스름돈을 상쇄하고 외부 송금액과 수수료를 기록한다", () => {
    // 1 BTC 입력 → 0.3 외부, 0.6999 거스름돈, 수수료 0.0001
    const r = build([tx([[A1, 100_000_000]], [[EXT, 30_000_000], [A2, 69_990_000]], 10_000)]);
    expect(summary(r)).toEqual([
      ["transfer", "-0.3"],
      ["fee", "-0.0001"],
    ]);
    expect(r.entries[0].counterparty).toBe(EXT);
  });

  it("내 주소끼리 옮기면(UTXO 통합) 수수료만 남는다", () => {
    const r = build([tx([[A1, 50_000], [A2, 50_000]], [[A1, 99_000]], 1_000)]);
    expect(summary(r)).toEqual([["fee", "-0.00001"]]);
  });

  it("다른 지갑과 입력을 합친 트랜잭션은 순변동만 기록하고 경고한다", () => {
    const r = build([tx([[A1, 100_000], [OTHER, 100_000]], [[A1, 99_000], [OTHER, 99_000]], 2_000)]);
    expect(summary(r)).toEqual([["other", "-0.00001"]]);
    expect(r.warnings).toHaveLength(1);
  });

  it("미확정 트랜잭션은 제외한다", () => {
    expect(build([tx([[EXT, 1000]], [[A1, 900]], 100, false)]).entries).toHaveLength(0);
  });

  it("여러 트랜잭션의 합계가 실제 잔고 변화와 일치한다", () => {
    const r = build([
      tx([[EXT, 2_000_000]], [[A1, 1_000_000], [EXT, 990_000]], 10_000), // +0.01
      tx([[A1, 1_000_000]], [[EXT, 300_000], [A2, 695_000]], 5_000), // -0.003 -0.00005
      tx([[A2, 695_000]], [[A1, 694_000]], 1_000), // -0.00001
    ]);
    const sum = r.entries.reduce((s, e) => s.plus(e.amount), new Decimal(0));
    expect(sum.toString()).toBe("0.00694");
    expect(new Set(r.entries.map((e) => e.id)).size).toBe(r.entries.length);
  });
});
