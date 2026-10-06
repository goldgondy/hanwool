import { describe, expect, it } from "vitest";
import { emptyCoin, quickCalculate } from "./quick";

describe("간이 계산기", () => {
  it("2026년 말 보유분은 의제취득가, 2027년 매수와 합친 총평균 단가로 매도 원가를 계산한다", () => {
    const r = quickCalculate([
      {
        ...emptyCoin("BTC"),
        holdQty: "1",
        holdCost: "50,000,000",
        holdPrice: "130,000,000", // 2026년 말 시가가 더 높음 → 1.3억으로 인정
        buyQty: "1",
        buyCost: "150,000,000",
        sellQty: "1",
        sellAmount: "160,000,000",
        sellFee: "80,000",
      },
    ]);
    // 평균단가 = (1.3억 + 1.5억) ÷ 2 = 1.4억 → 이익 1.6억 − 1.4억 − 8만 = 19,920,000
    expect(r.perCoin[0].gain.toNumber()).toBe(19_920_000);
    expect(r.perCoin[0].deemedUsed).toBe(true);
    const y = r.engine.years[0];
    // 과세표준 = 19,920,000 − 2,500,000 = 17,420,000 → 소득세 3,484,000 + 지방세 348,400
    expect(y.totalTaxKrw.toNumber()).toBe(3_832_400);
  });

  it("코인끼리 손익을 통산하고 빈 줄은 무시한다", () => {
    const r = quickCalculate([
      { ...emptyCoin("A"), buyQty: "10", buyCost: "1000000", sellQty: "10", sellAmount: "5000000" },
      { ...emptyCoin("B"), buyQty: "1", buyCost: "3000000", sellQty: "1", sellAmount: "1000000" },
      emptyCoin(),
    ]);
    expect(r.perCoin).toHaveLength(2);
    expect(r.engine.years[0].netKrw.toNumber()).toBe(2_000_000);
    expect(r.engine.years[0].totalTaxKrw.toNumber()).toBe(0);
  });

  it("보유보다 많이 팔면 경고한다", () => {
    const r = quickCalculate([{ ...emptyCoin("C"), buyQty: "1", buyCost: "100", sellQty: "2", sellAmount: "300" }]);
    expect(r.engine.warnings.some((w) => w.message.includes("보유 수량 부족"))).toBe(true);
  });
});
