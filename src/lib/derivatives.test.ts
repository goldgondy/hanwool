import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "@/lib/db";
import { derivativeInfo, summarizeDerivatives } from "./derivatives";

let n = 0;
const e = (p: Partial<LedgerEntry>): LedgerEntry => ({ id: `e${n++}`, sourceId: "s", location: "x", time: Date.UTC(2027, 2, 1), asset: "USDT", assetKey: "USDT", amount: "0", kind: "other", groupId: `g${n}`, origin: "exchange", ...p });

describe("선물 기록 알아보기", () => {
  it("거래소별 형식", () => {
    const cases: [Partial<LedgerEntry>, string, string][] = [
      [{ location: "Binance USDⓈ-M", rawType: "futures REALIZED_PNL (BTCUSDT)" }, "바이낸스", "pnl"],
      [{ location: "Binance USDⓈ-M", rawType: "futures FUNDING_FEE (BTCUSDT)" }, "바이낸스", "funding"],
      [{ location: "Binance USDⓈ-M", rawType: "futures COMMISSION (BTCUSDT)" }, "바이낸스", "fee"],
      [{ location: "Binance USDT-Futures", rawType: "Realized Profit and Loss" }, "바이낸스", "pnl"],
      [{ location: "Binance USDT-Futures", rawType: "Funding Fee" }, "바이낸스", "funding"],
      [{ location: "OKX 거래 계정", rawType: "bill 8/173 (BTC-USDT-SWAP)" }, "OKX", "funding"],
      [{ location: "OKX 거래 계정", rawType: "bill 2/4 (BTC-USDT-SWAP)" }, "OKX", "pnl"],
      [{ location: "OKX 거래 계정", rawType: "Perpetual Close long" }, "OKX", "pnl"],
      [{ location: "Bybit 통합 계정", rawType: "TRADE (linear)" }, "바이비트", "pnl"],
      [{ location: "Bybit 통합 계정", rawType: "SETTLEMENT (linear)" }, "바이비트", "funding"],
      [{ location: "Bitget 선물", rawType: "futures close_long (BTCUSDT)" }, "비트겟", "pnl"],
      [{ location: "Gate 선물 (USDT)", rawType: "futures fund" }, "게이트", "funding"],
      [{ location: "Gate 선물 (USDT)", rawType: "futures fee" }, "게이트", "fee"],
      [{ location: "MEXC 선물", rawType: "futures position closed (BTC_USDT)" }, "MEXC", "pnl"],
    ];
    for (const [p, ex, part] of cases) expect([p.rawType, derivativeInfo(e(p))]).toEqual([p.rawType, { exchange: ex, part }]);
  });

  it("현물 체결·보상·OKX 현물 기록·마진은 선물이 아니다", () => {
    expect(derivativeInfo(e({ location: "OKX 거래 계정", kind: "trade", rawType: "bill 2/1 (BTC-USDT)" }))).toBeNull();
    expect(derivativeInfo(e({ location: "Bybit 통합 계정", rawType: "TRADE (spot)" }))).toBeNull();
    expect(derivativeInfo(e({ location: "Gate 선물 (USDT)", kind: "income", tag: "reward", rawType: "futures refr" }))).toBeNull();
    expect(derivativeInfo(e({ location: "Binance Margin", rawType: "margin trade" }))).toBeNull();
  });

  it("연도·거래소·정산 코인별 합계", () => {
    const list = [
      e({ location: "Binance USDⓈ-M", rawType: "futures REALIZED_PNL", amount: "120.5" }),
      e({ location: "Binance USDⓈ-M", rawType: "futures FUNDING_FEE", amount: "-3.2" }),
      e({ location: "Binance USDⓈ-M", rawType: "futures COMMISSION", amount: "-4" }),
      e({ location: "Binance COIN-M", rawType: "futures REALIZED_PNL", asset: "BTC", amount: "0.01" }),
      e({ location: "Binance USDⓈ-M", rawType: "futures REALIZED_PNL", amount: "-50", time: Date.UTC(2026, 5, 1) }),
    ];
    const s = summarizeDerivatives(list, 2027);
    expect(s.years).toEqual([2027, 2026]);
    expect(s.rows.map((r) => [r.exchange, r.asset, r.pnl.toString(), r.funding.toString(), r.fee.toString(), r.count])).toEqual([
      ["바이낸스", "BTC", "0.01", "0", "0", 1],
      ["바이낸스", "USDT", "120.5", "-3.2", "-4", 3],
    ]);
  });
});
