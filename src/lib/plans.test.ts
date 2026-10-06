import { describe, expect, it } from "vitest";
import type { Source } from "@/lib/db";
import { requiredPlan, reviewQuote } from "./plans";

const enc = { iv: "", ct: "" };
const upbit: Source = { id: "1", kind: "xapi", exchange: "upbit", label: "업비트", apiKey: "k", encSecret: enc, createdAt: 0 };
const bithumbFile: Source = { id: "2", kind: "csv", exchange: "bithumb", label: "빗썸", imports: [], createdAt: 0 };
const okxFile: Source = { id: "3", kind: "csv", exchange: "okx", label: "OKX", imports: [], createdAt: 0 };
const binance: Source = { id: "4", kind: "binance", label: "바이낸스", apiKey: "k", encSecret: enc, createdAt: 0 };
const wallet: Source = { id: "5", kind: "tron", label: "트론", address: "T", createdAt: 0 };

describe("요금제", () => {
  it("연결한 계정으로 필요한 요금제를 정한다", () => {
    expect(requiredPlan([])).toBe("domestic");
    expect(requiredPlan([upbit, bithumbFile])).toBe("domestic");
    expect(requiredPlan([upbit, okxFile])).toBe("overseas");
    expect(requiredPlan([binance])).toBe("overseas");
    expect(requiredPlan([upbit, binance, wallet])).toBe("wallet");
  });

  it("세무사 검토: 기본료 + 거래 규모, 선물·DeFi·1만 건 초과는 개별 견적", () => {
    expect(reviewQuote(300).price).toBe(99_000);
    expect(reviewQuote(1_500).price).toBe(149_000);
    expect(reviewQuote(8_000).price).toBe(249_000);
    expect(reviewQuote(20_000)).toMatchObject({ price: null, needsQuote: ["거래 1만 건 초과"] });
    expect(reviewQuote(300, { derivatives: true }).needsQuote).toEqual(["선물·파생상품 거래"]);
  });
});
