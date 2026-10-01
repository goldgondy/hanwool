import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import type { ReconcileRow } from "@/lib/ledger/reconcile";
import { isRebasing, judgeDiff, summarize } from "./diff";

const row = (asset: string, assetKey: string, ledger: string, actual: string): ReconcileRow => ({
  asset,
  assetKey,
  location: "Ethereum",
  ledger: new Decimal(ledger),
  actual: new Decimal(actual),
  diff: new Decimal(actual).minus(ledger),
  entryCount: 1,
});

const STETH = "eth:0xae7ab96520de3a18e5e111b5eaab095312d7fe84";

describe("judgeDiff", () => {
  it("차이가 없으면 일치", () => {
    expect(judgeDiff(row("ETH", "eth:native", "1", "1")).kind).toBe("match");
  });

  it("stETH가 늘어나면 리베이스 보상으로 제안 (예: 원장 10, 실제 10.3)", () => {
    const j = judgeDiff(row("stETH", STETH, "10", "10.3"));
    expect(j.kind).toBe("rebasing_gain");
    expect(j.suggestion).toMatch(/보상/);
  });

  it("Aave aToken 심볼도 리베이스로 본다", () => {
    expect(isRebasing({ asset: "aEthWETH", assetKey: "eth:0x4d5f" })).toBe(true);
    expect(isRebasing({ asset: "aArbUSDC", assetKey: "arb:0x724d" })).toBe(true);
    expect(isRebasing({ asset: "AAVE", assetKey: "eth:0x7fc6" })).toBe(false);
    expect(isRebasing({ asset: "ARB", assetKey: "arb:0x912c" })).toBe(false);
  });

  it("리베이스가 아닌 토큰의 증가·감소는 설명되지 않는 차이", () => {
    expect(judgeDiff(row("USDC", "eth:0xa0b8", "100", "150")).kind).toBe("unexplained_gain");
    expect(judgeDiff(row("ETH", "eth:native", "1", "0.7")).kind).toBe("unexplained_loss");
    // stETH라도 줄었다면 리베이스로 설명되지 않는다
    expect(judgeDiff(row("stETH", STETH, "10", "9")).kind).toBe("unexplained_loss");
  });
});

describe("summarize", () => {
  it("일치·증가·감소 개수를 센다", () => {
    expect(
      summarize([
        row("ETH", "eth:native", "1", "1"),
        row("stETH", STETH, "10", "10.3"),
        row("USDC", "eth:0xa0b8", "100", "150"),
        row("DAI", "eth:0x6b17", "5", "1"),
      ]),
    ).toEqual({ rows: 4, matched: 1, gains: 2, losses: 1 });
  });
});
