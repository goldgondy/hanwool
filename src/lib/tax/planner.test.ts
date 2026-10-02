import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import { deductionRoom, sellPlan, splitYears, taxOf, yearEndSim, type PlanHolding } from "./planner";

const d = (n: number | string) => new Decimal(n);
const h = (asset: string, qty: number, cost: number, price: number): PlanHolding => ({ asset, qty: d(qty), cost: d(cost), price: d(price) });

describe("절세 도구", () => {
  it("세액: 250만원 공제 후 22%, 남은 공제", () => {
    expect(taxOf(d(12_500_000)).toNumber()).toBe(2_200_000);
    expect(taxOf(d(-1_000_000)).toNumber()).toBe(0);
    expect(deductionRoom(d(1_000_000)).toNumber()).toBe(1_500_000);
    expect(deductionRoom(d(-500_000)).toNumber()).toBe(2_500_000);
  });

  it("연말 정리: 손실 코인을 팔면 올해 세금이 줄어든다", () => {
    const holdings = [h("ETH", 10, 40_000_000, 3_000_000), h("BTC", 1, 50_000_000, 80_000_000)];
    const r = yearEndSim(d(12_500_000), holdings, new Set(["ETH"])); // ETH 평가손실 1,000만원
    expect([r.before.tax.toNumber(), r.after.tax.toNumber(), r.change.toNumber()]).toEqual([2_200_000, 0, -2_200_000]);
  });

  it("매도 플랜: 1원당 이익이 작은(손실) 코인부터 팔고, 비례 매도보다 세금이 적다", () => {
    const holdings = [
      h("BTC", 1, 50_000_000, 100_000_000), // 1원당 이익 0.5
      h("ETH", 10, 40_000_000, 3_000_000), // 손실 -0.33
      h("XRP", 1000, 1_000_000, 1_000), // 0
    ];
    const r = sellPlan(holdings, d(40_000_000), d(0));
    expect(r.legs.map((l) => [l.asset, l.value.toNumber()])).toEqual([
      ["ETH", 30_000_000],
      ["XRP", 1_000_000],
      ["BTC", 9_000_000],
    ]);
    expect(r.gain.toNumber()).toBe(-10_000_000 + 0 + 4_500_000);
    expect(r.tax.toNumber()).toBe(0);
    expect(r.baselineTax.gt(r.tax)).toBe(true);
  });

  it("해를 나눠 팔기: 올해 남은 공제만큼 올해, 나머지는 내년 → 공제를 두 번", () => {
    const r = splitYears(d(0), d(5_000_000));
    expect([r.thisYear.toNumber(), r.nextYear.toNumber(), r.oneYear.toNumber(), r.split.toNumber(), r.saving.toNumber()]).toEqual([
      2_500_000, 2_500_000, 550_000, 0, 550_000,
    ]);
  });
});
