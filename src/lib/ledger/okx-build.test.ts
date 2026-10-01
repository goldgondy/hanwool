import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import { buildOkxEntries, type OkxBill } from "./okx-build";

const empty = { sourceId: "s", bills: [], assetBills: [], deposits: [], withdrawals: [], lending: [] };
const bill = (p: Partial<OkxBill> & Pick<OkxBill, "billId" | "type" | "ccy" | "balChg">): OkxBill => ({ ts: "1800000000000", instType: "SPOT", ...p });
const brief = (r: ReturnType<typeof buildOkxEntries>) => r.entries.map((e) => [e.kind, e.asset, e.amount, e.groupId]);

describe("buildOkxEntries", () => {
  it("현물 체결: 두 통화 행을 주문 번호로 묶고 수수료를 분리한다 (합계는 잔고 변동과 같다)", () => {
    const r = buildOkxEntries({
      ...empty,
      bills: [
        bill({ billId: "1", type: "2", subType: "1", ccy: "BTC", balChg: "0.00999", fee: "-0.00001", ordId: "o1", instId: "BTC-USDT" }),
        bill({ billId: "2", type: "2", subType: "1", ccy: "USDT", balChg: "-1000", fee: "0", ordId: "o1", instId: "BTC-USDT" }),
      ],
    });
    expect(brief(r)).toEqual([
      ["trade", "BTC", "0.01", "okx:ord:o1"],
      ["fee", "BTC", "-0.00001", "okx:ord:o1"],
      ["trade", "USDT", "-1000", "okx:ord:o1"],
    ]);
    const btc = r.entries.filter((e) => e.asset === "BTC").reduce((s, e) => s.plus(e.amount), new Decimal(0));
    expect(btc.toString()).toBe("0.00999");
  });

  it("계정 사이 이체는 건너뛰고, 무기한 선물 체결은 파생상품으로 둔다", () => {
    const r = buildOkxEntries({
      ...empty,
      bills: [bill({ billId: "3", type: "1", ccy: "USDT", balChg: "500" }), bill({ billId: "4", type: "2", ccy: "USDT", balChg: "12.5", instType: "SWAP", ordId: "o2" })],
      assetBills: [{ billId: "a1", type: "131", ccy: "USDT", balChg: "-500", ts: "1800000000000" }],
    });
    expect(brief(r)).toEqual([["other", "USDT", "12.5", "okx:bill:4"]]);
    expect(r.warnings[0]).toContain("파생상품");
  });

  it("입금은 거래 해시와 함께, 출금은 수수료를 따로 기록한다. 완료되지 않은 건은 제외", () => {
    const r = buildOkxEntries({
      ...empty,
      deposits: [
        { depId: "d1", ccy: "eth", amt: "1.5", txId: "0xabc", state: "2", ts: "1800000000000" },
        { depId: "d2", ccy: "ETH", amt: "9", state: "0", ts: "1800000000000" },
      ],
      withdrawals: [{ wdId: "w1", ccy: "USDT", amt: "100", fee: "1", txId: "0xdef", state: "2", ts: "1800000000000" }],
    });
    expect(brief(r)).toEqual([
      ["transfer", "ETH", "1.5", "okx:dep:d1"],
      ["transfer", "USDT", "-100", "okx:wd:w1"],
      ["fee", "USDT", "-1", "okx:wd:w1"],
    ]);
    expect(r.entries[0].txHash).toBe("0xabc");
  });

  it("펀딩 계정 보상과 심플 언 이자는 보상으로, 모르는 유형은 알린다", () => {
    const r = buildOkxEntries({
      ...empty,
      assetBills: [
        { billId: "a2", type: "28", ccy: "ABC", balChg: "10", ts: "1800000000000" },
        { billId: "a3", type: "999", ccy: "USDT", balChg: "1", ts: "1800000000000" },
      ],
      lending: [{ ccy: "USDT", earnings: "0.0123", ts: "1800000000000" }],
    });
    expect(r.entries.map((e) => [e.kind, e.tag, e.amount])).toEqual([
      ["income", "airdrop", "10"],
      ["other", undefined, "1"],
      ["income", "reward", "0.0123"],
    ]);
    expect(r.unknownTypes).toEqual(["펀딩 계정 999"]);
  });
});
