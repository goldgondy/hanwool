import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { runEngine, type TaxEvent } from "./engine";

const D = (v: Decimal.Value) => new Decimal(v);
const kst = (s: string) => Date.parse(`${s}+09:00`);

let seq = 0;
const buy = (time: string, asset: string, qty: Decimal.Value, cost: Decimal.Value): TaxEvent => ({
  type: "acquire",
  time: kst(time),
  asset,
  qty: D(qty),
  costKrw: D(cost),
  ref: `a${seq++}`,
});
const sell = (
  time: string,
  asset: string,
  qty: Decimal.Value,
  proceeds: Decimal.Value,
  fee: Decimal.Value = 0,
): TaxEvent => ({
  type: "dispose",
  time: kst(time),
  asset,
  qty: D(qty),
  proceedsKrw: D(proceeds),
  feeKrw: D(fee),
  ref: `d${seq++}`,
});
const fee = (time: string, asset: string, qty: Decimal.Value): TaxEvent => ({
  type: "fee",
  time: kst(time),
  asset,
  qty: D(qty),
  ref: `f${seq++}`,
});

describe("이동평균법", () => {
  it("여러 번 매수한 평균 원가로 일부 매도 손익을 계산한다", () => {
    const r = runEngine(
      [
        buy("2027-02-01T00:00:00", "BTC", 1, 100_000_000),
        buy("2027-03-01T00:00:00", "BTC", 1, 140_000_000),
        sell("2027-04-01T00:00:00", "BTC", "0.5", 70_000_000, 50_000),
      ],
      {},
    );

    expect(r.disposals).toHaveLength(1);
    expect(r.disposals[0].costKrw.toNumber()).toBe(60_000_000);
    expect(r.disposals[0].gainKrw.toNumber()).toBe(9_950_000);

    const pool = r.pools.get("BTC")!;
    expect(pool.qty.toString()).toBe("1.5");
    expect(pool.costKrw.toNumber()).toBe(180_000_000);

    const y = r.years[0];
    expect(y.year).toBe(2027);
    expect(y.taxableKrw.toNumber()).toBe(7_450_000);
    expect(y.incomeTaxKrw.toNumber()).toBe(1_490_000);
    expect(y.localTaxKrw.toNumber()).toBe(149_000);
    expect(y.totalTaxKrw.toNumber()).toBe(1_639_000);
    expect(r.warnings).toHaveLength(0);
  });

  it("전량 매도하면 풀이 비워진다", () => {
    const r = runEngine(
      [
        buy("2027-01-10T00:00:00", "ETH", 3, 10_000_000),
        sell("2027-01-11T00:00:00", "ETH", 3, 12_000_000),
      ],
      {},
    );
    const pool = r.pools.get("ETH")!;
    expect(pool.qty.isZero()).toBe(true);
    expect(pool.costKrw.isZero()).toBe(true);
    expect(r.disposals[0].gainKrw.toNumber()).toBe(2_000_000);
  });
});

describe("의제취득가액", () => {
  it("2026년 말 시가가 실제 취득가보다 높으면 시가를 취득가로 쓴다", () => {
    const r = runEngine(
      [
        buy("2025-01-01T00:00:00", "ETH", 10, 30_000_000),
        sell("2027-06-01T00:00:00", "ETH", 4, 24_000_000),
      ],
      { ETH: D(5_000_000) },
    );
    expect(r.deemed).toHaveLength(1);
    expect(r.deemed[0].appliedCostKrw.toNumber()).toBe(50_000_000);
    expect(r.disposals[0].costKrw.toNumber()).toBe(20_000_000);
    expect(r.disposals[0].gainKrw.toNumber()).toBe(4_000_000);
  });

  it("실제 취득가가 더 높으면 실제 취득가를 유지한다", () => {
    const r = runEngine(
      [
        buy("2025-01-01T00:00:00", "ETH", 10, 60_000_000),
        sell("2027-06-01T00:00:00", "ETH", 4, 24_000_000),
      ],
      { ETH: D(5_000_000) },
    );
    expect(r.deemed[0].appliedCostKrw.toNumber()).toBe(60_000_000);
    expect(r.disposals[0].gainKrw.toNumber()).toBe(0);
  });

  it("과세 시작 이후 거래가 없어도 보유분의 의제취득가를 계산한다", () => {
    const r = runEngine([buy("2026-05-01T00:00:00", "SOL", 2, 400_000)], { SOL: D(300_000) });
    expect(r.deemed[0].appliedCostKrw.toNumber()).toBe(600_000);
    expect(r.pools.get("SOL")!.costKrw.toNumber()).toBe(600_000);
  });

  it("2026년 말 시가가 없으면 경고하고 실제 취득가를 쓴다", () => {
    const r = runEngine([buy("2026-05-01T00:00:00", "XYZ", 1, 1000)], {});
    expect(r.deemed[0].fairValueKrw).toBeNull();
    expect(r.deemed[0].appliedCostKrw.toNumber()).toBe(1000);
    expect(r.warnings.some((w) => w.asset === "XYZ")).toBe(true);
  });
});

describe("과세 기간", () => {
  it("2027년 이전 양도는 과세 대상이 아니지만 원가 풀에는 반영된다", () => {
    const r = runEngine(
      [
        buy("2026-03-01T00:00:00", "BTC", 1, 50_000_000),
        sell("2026-06-01T00:00:00", "BTC", "0.5", 40_000_000),
      ],
      {},
    );
    expect(r.disposals[0].taxable).toBe(false);
    expect(r.years).toHaveLength(0);
    expect(r.pools.get("BTC")!.costKrw.toNumber()).toBe(25_000_000);
  });

  it("KST 2027-01-01 00:00부터 과세한다", () => {
    const r = runEngine(
      [
        buy("2026-01-01T00:00:00", "BTC", 2, 0),
        sell("2026-12-31T23:59:59", "BTC", 1, 1000),
        sell("2027-01-01T00:00:00", "BTC", 1, 1000),
      ],
      {},
    );
    expect(r.disposals.map((d) => d.taxable)).toEqual([false, true]);
  });
});

describe("연간 합산", () => {
  it("이익과 손실을 통산하고 250만 원을 공제한다", () => {
    const r = runEngine(
      [
        buy("2027-01-05T00:00:00", "A", 1, 1_000_000),
        sell("2027-02-05T00:00:00", "A", 1, 6_000_000),
        buy("2027-01-05T00:00:00", "B", 1, 5_000_000),
        sell("2027-02-05T00:00:00", "B", 1, 2_000_000),
      ],
      {},
    );
    const y = r.years[0];
    expect(y.gainKrw.toNumber()).toBe(5_000_000);
    expect(y.lossKrw.toNumber()).toBe(-3_000_000);
    expect(y.netKrw.toNumber()).toBe(2_000_000);
    expect(y.deductionKrw.toNumber()).toBe(2_000_000);
    expect(y.taxableKrw.toNumber()).toBe(0);
    expect(y.totalTaxKrw.toNumber()).toBe(0);
  });

  it("연도별로 따로 합산하고 손실을 이월하지 않는다", () => {
    const r = runEngine(
      [
        buy("2027-01-05T00:00:00", "A", 2, 10_000_000),
        sell("2027-06-01T00:00:00", "A", 1, 1_000_000),
        sell("2028-06-01T00:00:00", "A", 1, 15_000_000),
      ],
      {},
    );
    expect(r.years.map((y) => y.year)).toEqual([2027, 2028]);
    expect(r.years[0].netKrw.toNumber()).toBe(-4_000_000);
    expect(r.years[0].totalTaxKrw.toNumber()).toBe(0);
    // 2028: 10,000,000 이익 - 2,500,000 = 7,500,000 → 소득세 1,500,000 + 지방세 150,000
    expect(r.years[1].totalTaxKrw.toNumber()).toBe(1_650_000);
  });

  it("원 미만은 절사한다", () => {
    const r = runEngine(
      [
        buy("2027-01-05T00:00:00", "A", 1, 0),
        sell("2027-02-05T00:00:00", "A", 1, "2500009.99"),
      ],
      {},
    );
    // 과세표준 9원 → 소득세 1원 (1.8 절사) → 지방세 0원 (0.1 절사)
    expect(r.years[0].taxableKrw.toNumber()).toBe(9);
    expect(r.years[0].incomeTaxKrw.toNumber()).toBe(1);
    expect(r.years[0].localTaxKrw.toNumber()).toBe(0);
  });
});

describe("예외 상황", () => {
  it("보유보다 많이 처분하면 경고하고 부족분 취득가를 0으로 본다", () => {
    const r = runEngine(
      [
        buy("2027-01-05T00:00:00", "SOL", 1, 200_000),
        sell("2027-02-05T00:00:00", "SOL", 3, 900_000),
      ],
      {},
    );
    expect(r.disposals[0].costKrw.toNumber()).toBe(200_000);
    expect(r.disposals[0].gainKrw.toNumber()).toBe(700_000);
    expect(r.warnings).toHaveLength(1);
    expect(r.pools.get("SOL")!.qty.isZero()).toBe(true);
  });

  it("같은 시각의 취득을 처분보다 먼저 처리한다", () => {
    const r = runEngine(
      [
        sell("2027-03-01T00:00:00", "USDT", 100, 140_000),
        buy("2027-03-01T00:00:00", "USDT", 100, 135_000),
      ],
      {},
    );
    expect(r.warnings).toHaveLength(0);
    expect(r.disposals[0].gainKrw.toNumber()).toBe(5_000);
  });

  it("원가를 모르는 입금은 경고한다", () => {
    const r = runEngine(
      [{ ...buy("2027-01-05T00:00:00", "ARB", 100, 0), costUnknown: true } as TaxEvent],
      {},
    );
    expect(r.warnings[0].message).toContain("취득가액을 알 수 없는");
  });
});

describe("코인 수수료 정책", () => {
  const events = () => [
    buy("2027-01-05T00:00:00", "BNB", 10, 1_000_000),
    fee("2027-01-06T00:00:00", "BNB", 1),
    sell("2027-02-01T00:00:00", "BNB", 9, 1_000_000),
  ];

  it("carry: 원가를 남은 보유분에 얹는다", () => {
    const r = runEngine(events(), {}, { feeTreatment: "carry" });
    expect(r.disposals).toHaveLength(1);
    expect(r.disposals[0].gainKrw.toNumber()).toBe(0);
  });

  it("expense: 수수료 수량의 원가를 손실로 인식한다", () => {
    const r = runEngine(events(), {}, { feeTreatment: "expense" });
    expect(r.disposals.map((d) => d.gainKrw.toNumber())).toEqual([-100_000, 100_000]);
    // 연간 합계는 두 정책이 같다
    expect(r.years[0].netKrw.toNumber()).toBe(0);
  });
});
