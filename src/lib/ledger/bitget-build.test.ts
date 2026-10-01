import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import { buildBitgetEntries, inferConvention, type BitgetBill } from "./bitget-build";

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
