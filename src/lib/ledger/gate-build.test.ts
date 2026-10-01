import { describe, expect, it } from "vitest";
import { buildGateEarnEntries, buildGateEntries, buildGateFuturesEntries } from "./gate-build";

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

  it("현물: 선물·심플 언 이동은 건너뛰고, 심플 언 이자 지급(profit)은 보상, 마진 이자 지불은 비용", () => {
    const r = buildGateEntries({
      sourceId: "s",
      book: [
        { id: "1", time: 1, currency: "USDT", change: "-100", type: "futures_out" },
        { id: "2", time: 1, currency: "USDT", change: "-50", type: "lend" },
        { id: "3", time: 1, currency: "USDT", change: "0.01", type: "profit" },
        { id: "4", time: 1, currency: "USDT", change: "-0.2", type: "interest" },
      ],
      deposits: [],
      withdrawals: [],
    });
    expect(r.entries.map((e) => [e.kind, e.amount, e.tag])).toEqual([
      ["income", "0.01", "reward"],
      ["fee", "-0.2", undefined],
    ]);
  });

  it("선물: 현물과의 이동·포인트는 건너뛰고 손익·수수료·펀딩비는 파생상품, 추천 리베이트는 보상", () => {
    const r = buildGateFuturesEntries("s", "usdt", [
      { time: 1700000000.5, change: "100", type: "dnw" },
      { time: 1700000001, change: "12.5", type: "pnl", text: "BTC_USDT:1" },
      { time: 1700000001, change: "-0.3", type: "fee", text: "BTC_USDT:1" },
      { time: 1700000002, change: "-0.05", type: "fund" },
      { time: 1700000003, change: "0.01", type: "refr" },
      { time: 1700000004, change: "1", type: "point_dnw" },
    ]);
    expect(r.entries.map((e) => [e.kind, e.asset, e.amount, e.tag])).toEqual([
      ["other", "USDT", "12.5", undefined],
      ["other", "USDT", "-0.3", undefined],
      ["other", "USDT", "-0.05", undefined],
      ["income", "USDT", "0.01", "reward"],
    ]);
    expect(r.entries[0].time).toBe(1700000001000);
  });

  it("심플 언 이자: 재투자분만 기록 (현물로 지급된 이자는 현물 장부에 있음)", () => {
    const e = buildGateEarnEntries("s", [
      { status: 1, currency: "usdt", interest: "0.5", interest_status: "interest_reinvest", create_time: 1700000000 },
      { status: 1, currency: "USDT", interest: "0.5", interest_status: "interest_dividend", create_time: 1700003600 },
      { status: 0, currency: "USDT", interest: "0.5", interest_status: "interest_reinvest", create_time: 1700007200 },
    ]);
    expect(e.map((x) => [x.asset, x.amount, x.time])).toEqual([["USDT", "0.5", 1700000000000]]);
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
