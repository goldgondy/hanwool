import { describe, expect, it } from "vitest";
import { classifyAll } from "@/lib/classify/classifier";
import { buildManualEntries, HOLDING_TIME, validateManual, type ManualInput } from "./manual";

const T = Date.parse("2027-02-01T10:00:00+09:00");
const classify = (inputs: ManualInput[]) =>
  classifyAll({ entries: inputs.flatMap((m, i) => buildManualEntries("m", `u${i}`, m)), ownAddresses: new Set(), decisions: new Map() }).map((g) => [
    g.classification.category,
    g.classification.rule,
  ]);
const m = (p: Partial<ManualInput>): ManualInput => ({ type: "buy", time: T, place: "코인원", coin: "BTC", qty: "0.1", ...p });

describe("직접 입력", () => {
  it("원화 매수·매도는 원화 매수/매도로 확정, 교환은 교환, 보상은 보상", () => {
    expect(classify([m({ krw: "10,000,000", fee: "5000" })])).toEqual([["buy_fiat", "R2"]]);
    expect(classify([m({ type: "sell", krw: "11000000" })])).toEqual([["sell_fiat", "R2"]]);
    expect(classify([m({ type: "swap", coin: "USDT", qty: "100", coin2: "ETH", qty2: "0.03" })])).toEqual([["trade", "R1"]]);
    expect(classify([m({ type: "airdrop", coin: "ABC", qty: "50" })])).toEqual([["airdrop", "R3"]]);
  });

  it("입금은 출처를 모르니 검토 필요, 다른 계정 출금과 맞으면 R11로 짝지어진다", () => {
    expect(classify([m({ type: "deposit", coin: "USDT", qty: "100" })])).toEqual([["external_in", "R12"]]);
  });

  it("2026년 말 보유분: 과세 직전 시각, 취득가를 모르면 코인만 (시가로 평가)", () => {
    const known = buildManualEntries("m", "h1", m({ type: "holding", krw: "30000000", time: NaN }));
    expect(known.map((e) => [e.time, e.assetKey, e.amount])).toEqual([
      [HOLDING_TIME, "BTC", "0.1"],
      [HOLDING_TIME, "fiat:KRW", "-30000000"],
    ]);
    expect(buildManualEntries("m", "h2", m({ type: "holding", time: NaN })).map((e) => e.assetKey)).toEqual(["BTC"]);
    expect(new Date(HOLDING_TIME).toISOString()).toBe("2026-12-31T14:59:59.000Z");
  });

  it("입력 검사", () => {
    expect(validateManual(m({ krw: "" }))).toBe("원화 금액을 입력하세요");
    expect(validateManual(m({ qty: "abc", krw: "1" }))).toBe("수량을 0보다 큰 숫자로 입력하세요");
    expect(validateManual(m({ type: "holding", time: NaN }))).toBeNull();
    expect(validateManual(m({ type: "deposit", time: NaN }))).toBe("날짜와 시각을 입력하세요");
  });
});
