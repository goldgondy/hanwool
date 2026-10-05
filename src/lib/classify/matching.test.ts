import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "@/lib/db";
import { classifyAll } from "./classifier";

// 거래소 ↔ 지갑 ↔ 거래소 이체 짝짓기 점검 (2026-10-05).
// 실제 파일 형식(OKX 출금 내역·빗썸 기간별 내역·업비트 붙여넣기)과 같은 모양의 원장으로 짝이 맞는지 본다.

const H = 3_600_000;
const T0 = Date.UTC(2026, 4, 11, 13, 37);
const BTC_TX = "e1f538d9c4a7b2e0e1f538d9c4a7b2e0e1f538d9c4a7b2e0e1f538d9c4a7b2e0";
const ETH_TX = "0x4a1d87c0000000000000000000000000000000000000000000000000000000aa";

let n = 0;
const ex = (p: Partial<LedgerEntry> & Pick<LedgerEntry, "amount" | "sourceId">): LedgerEntry => ({
  id: `x${n++}`,
  location: "거래소",
  time: T0,
  asset: "BTC",
  assetKey: "BTC",
  kind: "transfer",
  groupId: `g${n}`,
  origin: "exchange",
  ...p,
});
const chain = (p: Partial<LedgerEntry> & Pick<LedgerEntry, "amount" | "sourceId">): LedgerEntry => ({
  id: `c${n++}`,
  location: "Bitcoin",
  time: T0 + 0.5 * H,
  asset: "BTC",
  assetKey: "btc:native",
  kind: "transfer",
  groupId: `btc:${BTC_TX}`,
  origin: "chain",
  txHash: BTC_TX,
  ...p,
});
const run = (entries: LedgerEntry[]) => classifyAll({ entries, ownAddresses: new Set(), decisions: new Map() });
const only = (entries: LedgerEntry[]) => {
  const v = run(entries);
  return v.map((g) => [g.classification.category, g.classification.rule, g.classification.status]);
};

describe("거래 번호로 짝짓기 (확정)", () => {
  it("OKX 출금 내역(보낸 금액·수수료 분리) → 내 비트코인 지갑 입금", () => {
    const v = run([
      ex({ sourceId: "okx", amount: "-0.050525", txHash: BTC_TX, groupId: "okx:wd:1" }),
      ex({ sourceId: "okx", amount: "-0.000015", kind: "fee", txHash: BTC_TX, groupId: "okx:wd:1" }),
      chain({ sourceId: "wallet", amount: "0.050525" }),
    ]);
    expect(v).toHaveLength(1);
    expect([v[0].classification.category, v[0].classification.rule, v[0].classification.status]).toEqual(["internal_transfer", "R4", "confirmed"]);
  });

  it("거래소가 출금 수량에 수수료를 포함해 적은 경우: 차이를 이체 수수료로 보고 내 계정 간 이체로 확정", () => {
    const v = run([ex({ sourceId: "x", amount: "-0.05054", txHash: BTC_TX }), chain({ sourceId: "wallet", amount: "0.050525" })]);
    expect(v).toHaveLength(1);
    const c = v[0].classification;
    expect([c.category, c.status]).toEqual(["internal_transfer", "confirmed"]);
    expect(c.pair?.feeQty).toBe("0.000015");
  });

  it("거래소가 소수점을 반올림해 적은 경우(ETH 18자리 → 8자리)도 같은 이체", () => {
    const v = run([
      ex({ sourceId: "binance", asset: "ETH", assetKey: "ETH", amount: "0.12345679", txHash: ETH_TX.toUpperCase().replace("0X", "") }),
      chain({ sourceId: "wallet", asset: "ETH", assetKey: "eth:native", location: "Ethereum", amount: "-0.123456789012345678", groupId: `eth:${ETH_TX}`, txHash: ETH_TX }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].classification.category).toBe("internal_transfer");
    expect(v[0].classification.pair?.feeQty).toBeUndefined();
  });

  it("거래소 → 거래소 (OKX 출금 → 바이낸스 입금, 둘 다 거래 번호)", () => {
    expect(
      only([
        ex({ sourceId: "okx", amount: "-0.1", txHash: BTC_TX, groupId: "okx:wd:2" }),
        ex({ sourceId: "binance", amount: "0.1", txHash: BTC_TX, groupId: "bn:dep:2", time: T0 + H }),
      ]),
    ).toEqual([["internal_transfer", "R4", "confirmed"]]);
  });

  it("거래 번호처럼 보이지 않는 값(바이낸스 'Internal transfer' 등)으로는 묶지 않는다", () => {
    const v = run([
      ex({ sourceId: "binance", amount: "1", asset: "USDT", assetKey: "USDT", txHash: "Internal transfer", groupId: "bn:dep:a" }),
      ex({ sourceId: "binance", amount: "5", asset: "USDT", assetKey: "USDT", txHash: "Internal transfer", groupId: "bn:dep:b", time: T0 + 5 * H }),
    ]);
    expect(v).toHaveLength(2);
  });

  it("거래소 일괄 출금(한 거래로 내 지갑과 남에게 보냄): 남에게 간 몫만 외부로 나감", () => {
    const v = run([
      ex({ sourceId: "okx", amount: "-0.01082", txHash: BTC_TX, groupId: "okx:wd:a" }),
      ex({ sourceId: "okx", amount: "-0.01082", txHash: BTC_TX, groupId: "okx:wd:b" }),
      chain({ sourceId: "wallet", amount: "0.01082" }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].classification.category).toBe("external_out");
  });
});

describe("스팸 토큰", () => {
  it("이름이 웹 주소인 에어드랍 토큰은 스팸으로 추정한다 (플라스마 실데이터: www.basex.cfd)", () => {
    const v = run([chain({ sourceId: "w", asset: "WWW.BASEX.CFD", assetKey: "plasma:0x1234", amount: "1863", groupId: "plasma:0xabc", txHash: "c".repeat(64) })]);
    expect([v[0].classification.category, v[0].classification.status]).toEqual(["spam", "suggested"]);
  });

  it("평범한 이름의 토큰 입금은 그대로 출처 확인 대상", () => {
    const v = run([chain({ sourceId: "w", asset: "USDT", assetKey: "plasma:0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", amount: "58", groupId: "plasma:0xdef", txHash: "d".repeat(64) })]);
    expect(v[0].classification.category).toBe("external_in");
  });
});

describe("거래 번호 없이 수량·시각으로 짝짓기 (추정)", () => {
  const upbitOut = (p: Partial<LedgerEntry> = {}) =>
    ex({ sourceId: "upbit", location: "업비트", asset: "XRP", assetKey: "XRP", amount: "-1000", groupId: "up:wd", ...p });
  const binanceIn = (p: Partial<LedgerEntry> = {}) =>
    ex({ sourceId: "binance", location: "Binance", asset: "XRP", assetKey: "XRP", amount: "999.75", groupId: "bn:dep", txHash: BTC_TX, ...p });

  it("업비트 붙여넣기 출금(번호 없음) → 2시간 뒤 바이낸스 입금", () => {
    const v = run([upbitOut(), binanceIn({ time: T0 + 2 * H })]);
    expect(v.map((g) => [g.classification.category, g.classification.rule])).toEqual([
      ["internal_transfer", "R11"],
      ["internal_transfer", "R11"],
    ]);
    expect(v.find((g) => g.key === "up:wd")?.classification.pair?.feeQty).toBe("0.25");
  });

  it("출금 심사·블록 확인으로 하루 넘게 걸린 입금도 짝짓는다 (30시간 뒤)", () => {
    expect(run([upbitOut(), binanceIn({ time: T0 + 30 * H })]).every((g) => g.classification.rule === "R11")).toBe(true);
  });

  it("파일 시간대가 1시간 어긋나 입금이 출금보다 앞서 보여도 짝짓는다", () => {
    expect(run([upbitOut(), binanceIn({ time: T0 - 1 * H })]).every((g) => g.classification.rule === "R11")).toBe(true);
  });

  it("받은 수량이 보낸 수량보다 많거나 5% 넘게 적으면 짝짓지 않는다", () => {
    expect(run([upbitOut(), binanceIn({ amount: "1000.5" })]).some((g) => g.classification.rule === "R11")).toBe(false);
    expect(run([upbitOut(), binanceIn({ amount: "900" })]).some((g) => g.classification.rule === "R11")).toBe(false);
  });

  it("후보가 여럿이면 수량이 더 가까운 입금과 짝짓는다", () => {
    const v = run([
      upbitOut(),
      binanceIn({ amount: "990", groupId: "bn:far", txHash: "a".repeat(64) }),
      binanceIn({ amount: "999.9", groupId: "bn:near", time: T0 + 5 * H, txHash: "b".repeat(64) }),
    ]);
    expect(v.find((g) => g.key === "up:wd")?.classification.pair?.key).toBe("bn:near");
    expect(v.find((g) => g.key === "bn:far")?.classification.rule).toBe("R12");
  });
});
