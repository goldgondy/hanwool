import { describe, expect, it } from "vitest";
import { buildGateEntries } from "./gate-build";

describe("buildGateEntries", () => {
  it("체결·수수료는 같은 시각으로 묶고, 입금에는 거래 해시를 붙이며, 모르는 유형은 알린다", () => {
    const r = buildGateEntries({
      sourceId: "s",
      book: [
        { id: "1", time: 1000, currency: "usdt", change: "500", type: "deposit" },
        { id: "2", time: 2000, currency: "USDT", change: "-100", type: "order_fill" },
        { id: "3", time: 2000, currency: "GT", change: "10", type: "order_fill" },
        { id: "4", time: 2000, currency: "GT", change: "-0.02", type: "order_fee" },
        { id: "5", time: 3000, currency: "GT", change: "0.5", type: "referral_fee" },
        { id: "6", time: 4000, currency: "GT", change: "1", type: "mystery" },
        { id: "7", time: 5000, currency: "GT", change: "0", type: "order_fill" },
      ],
      deposits: [{ id: "d1", txid: "0xabc", timestamp: "1", amount: "500", currency: "USDT", status: "DONE" }],
      withdrawals: [],
    });
    expect(r.entries.map((e) => [e.kind, e.asset, e.amount, e.groupId, e.tag])).toEqual([
      ["transfer", "USDT", "500", "gate:1", undefined],
      ["trade", "USDT", "-100", "gate:t:2000", undefined],
      ["trade", "GT", "10", "gate:t:2000", undefined],
      ["fee", "GT", "-0.02", "gate:t:2000", undefined],
      ["income", "GT", "0.5", "gate:5", "reward"],
      ["other", "GT", "1", "gate:6", undefined],
    ]);
    expect(r.entries[0].txHash).toBe("0xabc");
    expect(r.unknownTypes).toEqual(["mystery"]);
  });

  it("출금은 수수료 포함 금액으로도 거래 해시를 찾는다", () => {
    const r = buildGateEntries({
      sourceId: "s",
      book: [{ id: "1", time: 1_000_000, currency: "ETH", change: "-1.001", type: "withdraw" }],
      deposits: [],
      withdrawals: [{ id: "w1", txid: "0xdef", timestamp: "1000", amount: "1", fee: "0.001", currency: "ETH", status: "DONE" }],
    });
    expect(r.entries[0].txHash).toBe("0xdef");
  });
});
