import { describe, expect, it } from "vitest";
import { classifyAll } from "@/lib/classify/classifier";
import type { LedgerEntry } from "@/lib/db";
import { buildBybitEntries } from "./bybit-build";

const T = 1_750_000_000_000;

describe("buildBybitEntries", () => {
  const { entries, unknownTypes, warnings } = buildBybitEntries({
    sourceId: "by",
    logs: [
      // 현물 매수: 같은 tradeId의 두 행 (받은 BTC는 수수료 차감 후)
      { id: "1", transactionTime: String(T), type: "TRADE", category: "spot", currency: "BTC", change: "0.00999", tradeId: "t1" },
      { id: "2", transactionTime: String(T), type: "TRADE", category: "spot", currency: "USDT", change: "-600", tradeId: "t1" },
      { id: "3", transactionTime: String(T + 1), type: "TRANSFER_IN", currency: "USDT", change: "1000" },
      { id: "4", transactionTime: String(T + 2), type: "AIRDROP", currency: "XYZ", change: "5" },
      { id: "5", transactionTime: String(T + 3), type: "TRADE", category: "linear", currency: "USDT", change: "-12.5" },
      { id: "6", transactionTime: String(T + 4), type: "SOMETHING_NEW", currency: "USDT", change: "1" },
      { id: "7", transactionTime: String(T + 5), type: "TRADE", category: "spot", currency: "USDT", change: "0" },
    ],
    deposits: [
      { id: "d1", coin: "USDT", amount: "1000", txID: "0xAAA", status: 3, successAt: String(T - 10) },
      { id: "d2", coin: "USDT", amount: "5", txID: "0xBBB", status: 2, successAt: String(T - 5) }, // 처리 중 → 제외
    ],
    withdrawals: [
      { withdrawId: "w1", coin: "BTC", amount: "0.005", withdrawFee: "0.0002", txID: "abcdef", status: "success", createTime: String(T + 10), updateTime: String(T + 11) },
      { withdrawId: "w2", coin: "BTC", amount: "1", txID: "", status: "CancelByUser", createTime: String(T + 12) },
    ],
  });

  it("거래 로그·입출금을 원장으로 바꾸고, 내부 이동·0·미완료 건은 뺀다", () => {
    expect(entries.map((e) => [e.rawType, e.asset, e.amount, e.kind])).toEqual([
      ["TRADE (spot)", "BTC", "0.00999", "trade"],
      ["TRADE (spot)", "USDT", "-600", "trade"],
      ["AIRDROP", "XYZ", "5", "income"],
      ["TRADE (linear)", "USDT", "-12.5", "other"],
      ["SOMETHING_NEW", "USDT", "1", "other"],
      ["Deposit", "USDT", "1000", "transfer"],
      ["Withdraw", "BTC", "-0.005", "transfer"],
      ["Withdraw fee", "BTC", "-0.0002", "fee"],
    ]);
    expect(unknownTypes).toEqual(["SOMETHING_NEW"]);
    expect(warnings[0]).toMatch(/파생상품/);
  });

  it("분류: 현물 체결은 교환(확정), 에어드랍(확정), 선물은 검토 필요", () => {
    const groups = classifyAll({ entries, ownAddresses: new Set(), decisions: new Map() });
    const of = (raw: string) => groups.find((g) => g.entries.some((e) => e.rawType === raw))!.classification;
    expect(of("TRADE (spot)")).toMatchObject({ category: "trade", status: "confirmed" });
    expect(of("AIRDROP")).toMatchObject({ category: "airdrop", status: "confirmed" });
    expect(of("TRADE (linear)").status).toBe("needs_review");
  });

  it("거래소 출금과 내 지갑 입금은 트랜잭션 해시로 합쳐져 내 계정 간 이체가 된다", () => {
    const wallet: LedgerEntry = {
      id: "btc-in",
      sourceId: "wallet",
      location: "Bitcoin",
      time: T + 20,
      asset: "BTC",
      assetKey: "btc:native",
      amount: "0.005",
      kind: "transfer",
      groupId: "btc:ABCDEF",
      txHash: "ABCDEF",
    };
    // 거래소는 자산을 "BTC", 지갑은 "btc:native"로 적지만 같은 코인으로 비교해야 한다.
    const groups = classifyAll({ entries: [...entries, wallet], ownAddresses: new Set(), decisions: new Map() });
    const merged = groups.find((g) => g.entries.some((e) => e.id === "btc-in"))!;
    expect(merged.key).toBe("btc:ABCDEF"); // 블록체인 쪽 키를 쓴다
    expect(merged.entries.map((e) => e.sourceId).sort()).toEqual(["by", "by", "wallet"]);
    expect(merged.classification).toMatchObject({ category: "internal_transfer", status: "confirmed", rule: "R4" });
  });
});
