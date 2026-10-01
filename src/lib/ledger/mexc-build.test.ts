import { describe, expect, it } from "vitest";
import { buildMexcEntries } from "./mexc-build";

describe("buildMexcEntries", () => {
  it("매수·매도 체결을 기준·결제 통화 두 줄과 수수료로 기록한다", () => {
    const r = buildMexcEntries({
      sourceId: "s",
      trades: [
        { base: "MX", quote: "USDT", trade: { symbol: "MXUSDT", id: "t1", orderId: "o1", qty: "10", quoteQty: "30", commission: "0.01", commissionAsset: "MX", time: 1, isBuyer: true } },
        { base: "MX", quote: "USDT", trade: { symbol: "MXUSDT", id: "t2", orderId: "o2", qty: "5", quoteQty: "16", commission: "0.016", commissionAsset: "USDT", time: 2, isBuyer: false } },
      ],
      deposits: [],
      withdrawals: [],
    });
    expect(r.entries.map((e) => [e.kind, e.asset, e.amount, e.groupId])).toEqual([
      ["trade", "MX", "10", "mexc:ord:o1"],
      ["trade", "USDT", "-30", "mexc:ord:o1"],
      ["fee", "MX", "-0.01", "mexc:ord:o1"],
      ["trade", "MX", "-5", "mexc:ord:o2"],
      ["trade", "USDT", "16", "mexc:ord:o2"],
      ["fee", "USDT", "-0.016", "mexc:ord:o2"],
    ]);
  });

  it("완료된 입출금만, 출금 해시는 transHash에서", () => {
    const r = buildMexcEntries({
      sourceId: "s",
      trades: [],
      deposits: [
        { amount: "100", coin: "usdt", status: 5, txId: "0xa", insertTime: 1 },
        { amount: "100", coin: "USDT", status: 4, txId: "0xb", insertTime: 1 },
      ],
      withdrawals: [{ id: "w1", amount: "50", coin: "USDT", status: 7, transactionFee: "1", txId: null, transHash: "0xc", applyTime: 2 }],
    });
    expect(r.entries.map((e) => [e.kind, e.amount, e.txHash])).toEqual([
      ["transfer", "100", "0xa"],
      ["transfer", "-50", "0xc"],
      ["fee", "-1", "0xc"],
    ]);
  });
});
