import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import { buildBitgetEarnEntries, buildBitgetEntries, buildBitgetFuturesEntries, inferConvention, type BitgetBill } from "./bitget-build";

const b = (p: Partial<BitgetBill> & Pick<BitgetBill, "billId" | "cTime" | "coin" | "size">): BitgetBill => ({ groupType: "transaction", businessType: "BUY", ...p });

describe("bitget", () => {
  it("잔고 변화로 size의 수수료 포함 방식을 알아낸다", () => {
    // size는 수수료 전, fees는 음수, 잔고 변화 = size + fees
    const plus = [b({ billId: "1", cTime: "1", coin: "BTC", size: "1", fees: "0", balance: "1" }), b({ billId: "2", cTime: "2", coin: "BTC", size: "0.5", fees: "-0.001", balance: "1.499" })];
    expect(inferConvention(plus)).toBe("plusFee");
    // size가 이미 수수료 차감 후
    const net = [b({ billId: "1", cTime: "1", coin: "BTC", size: "1", fees: "0", balance: "1" }), b({ billId: "2", cTime: "2", coin: "BTC", size: "0.499", fees: "-0.001", balance: "1.499" })];
    expect(inferConvention(net)).toBe("net");
  });

  it("체결은 주문 번호로 묶고 수수료를 분리하며, 합계는 잔고 변화와 같다", () => {
    const bills = [
      b({ billId: "1", cTime: "1", coin: "USDT", size: "1000", fees: "0", balance: "1000", groupType: "deposit", businessType: "DEPOSIT", bizOrderId: "d1" }),
      b({ billId: "2", cTime: "2", coin: "USDT", size: "-1000", fees: "0", balance: "0", bizOrderId: "o1" }),
      b({ billId: "3", cTime: "2", coin: "BTC", size: "0.01", fees: "-0.00001", balance: "0.00999", bizOrderId: "o1" }),
    ];
    const r = buildBitgetEntries({ sourceId: "s", bills, deposits: [{ orderId: "d1", tradeId: "0xhash", coin: "USDT", size: "1000", status: "success", cTime: "1" }], withdrawals: [] });
    expect(r.convention).toBe("plusFee");
    expect(r.entries.map((e) => [e.kind, e.asset, e.amount, e.groupId])).toEqual([
      ["transfer", "USDT", "1000", "bitget:bill:1"],
      ["trade", "USDT", "-1000", "bitget:ord:o1"],
      ["trade", "BTC", "0.01", "bitget:ord:o1"],
      ["fee", "BTC", "-0.00001", "bitget:ord:o1"],
    ]);
    expect(r.entries[0].txHash).toBe("0xhash");
    const btc = r.entries.filter((e) => e.asset === "BTC").reduce((s, e) => s.plus(e.amount), new Decimal(0));
    expect(btc.toString()).toBe("0.00999");
  });

  it("현물 ↔ 선물·Earn 이동은 건너뛴다", () => {
    const r = buildBitgetEntries({
      sourceId: "s",
      bills: [
        b({ billId: "1", cTime: "1", coin: "USDT", size: "-100", groupType: "transfer", businessType: "transfer_out" }),
        b({ billId: "2", cTime: "1", coin: "USDT", size: "-50", groupType: "other", businessType: "SAVINGS_SUBSCRIBE" }),
      ],
      deposits: [],
      withdrawals: [],
    });
    expect(r.entries).toEqual([]);
  });

  it("선물: 이동·증거금 조정은 건너뛰고, 손익은 수수료를 더해 파생상품으로 기록", () => {
    const r = buildBitgetFuturesEntries("s", [
      { billId: "1", amount: "100", fee: "0", businessType: "trans_from_exchange", coin: "USDT", cTime: "1" },
      { billId: "2", amount: "0", fee: "-0.5", businessType: "open_long", coin: "USDT", cTime: "2", symbol: "BTCUSDT" },
      { billId: "3", amount: "30", fee: "-0.5", businessType: "close_long", coin: "USDT", cTime: "3", symbol: "BTCUSDT" },
      { billId: "4", amount: "-0.1", fee: "0", businessType: "contract_settle_fee", coin: "USDT", cTime: "4" },
      { billId: "5", amount: "5", fee: "0", businessType: "append_margin", coin: "USDT", cTime: "5" },
    ]);
    expect(r.entries.map((e) => [e.kind, e.amount, e.location])).toEqual([
      ["other", "-0.5", "Bitget 선물"],
      ["other", "29.5", "Bitget 선물"],
      ["other", "-0.1", "Bitget 선물"],
    ]);
    expect(r.derivatives).toBe(3);
  });

  it("Earn 이자: 현물 장부에 같은 보상이 있으면 중복으로 보고 건너뛴다", () => {
    const spot = buildBitgetEntries({
      sourceId: "s",
      bills: [b({ billId: "9", cTime: "1000", coin: "USDT", size: "0.01", groupType: "other", businessType: "EARN_PROFIT" })],
      deposits: [],
      withdrawals: [],
    }).entries;
    const earn = buildBitgetEarnEntries(
      "s",
      [
        { orderId: "e1", coinName: "USDT", amount: "0.01", ts: "2000", orderType: "pay_interest" },
        { orderId: "e2", coinName: "USDT", amount: "0.02", ts: "90000000", orderType: "pay_interest" },
        { orderId: "e3", coinName: "USDT", amount: "100", ts: "3000", orderType: "subscribe" },
      ],
      spot,
    );
    expect(earn.map((e) => [e.amount, e.tag])).toEqual([["0.02", "reward"]]);
  });

  it("보상·에어드랍 유형은 보상으로, 모르는 유형은 알린다", () => {
    const r = buildBitgetEntries({
      sourceId: "s",
      bills: [
        b({ billId: "1", cTime: "1", coin: "ABC", size: "5", groupType: "other", businessType: "AIRDROP_REWARD" }),
        b({ billId: "2", cTime: "1", coin: "USDT", size: "0.1", groupType: "other", businessType: "REBATE" }),
        b({ billId: "3", cTime: "1", coin: "USDT", size: "1", groupType: "other", businessType: "MYSTERY" }),
      ],
      deposits: [],
      withdrawals: [],
    });
    expect(r.entries.map((e) => e.tag)).toEqual(["airdrop", "reward", undefined]);
    expect(r.unknownTypes).toEqual(["other/MYSTERY"]);
  });
});
