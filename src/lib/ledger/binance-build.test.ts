import { describe, expect, it } from "vitest";
import {
  binanceTime,
  buildBinanceConverts,
  buildBinanceDividends,
  buildBinanceDust,
  buildBinanceEarn,
  buildBinanceIncome,
  buildBinanceP2P,
  buildBinanceTrades,
  buildBinanceTransfers,
} from "./binance-build";

const brief = (es: { kind: string; assetKey: string; amount: string; groupId: string }[]) => es.map((e) => [e.kind, e.assetKey, e.amount, e.groupId]);

describe("binance", () => {
  it("현물 체결: 매수·매도를 기준·결제 통화와 수수료로 기록하고 주문 번호로 묶는다", () => {
    const r = buildBinanceTrades("s", [
      { base: "BTC", quote: "USDT", trade: { symbol: "BTCUSDT", id: 1, orderId: 10, qty: "0.01", quoteQty: "1000", commission: "0.00001", commissionAsset: "BTC", time: 1, isBuyer: true } },
      { base: "BTC", quote: "USDT", trade: { symbol: "BTCUSDT", id: 2, orderId: 11, qty: "0.005", quoteQty: "510", commission: "0.001", commissionAsset: "BNB", time: 2, isBuyer: false } },
    ]);
    expect(brief(r)).toEqual([
      ["trade", "BTC", "0.01", "bn:ord:BTCUSDT:10"],
      ["trade", "USDT", "-1000", "bn:ord:BTCUSDT:10"],
      ["fee", "BTC", "-0.00001", "bn:ord:BTCUSDT:10"],
      ["trade", "BTC", "-0.005", "bn:ord:BTCUSDT:11"],
      ["trade", "USDT", "510", "bn:ord:BTCUSDT:11"],
      ["fee", "BNB", "-0.001", "bn:ord:BTCUSDT:11"],
    ]);
  });

  it("입출금: 완료(입금 1·6, 출금 6)만, 블록체인 해시만 남기고 내부 이체 문구는 버린다", () => {
    const r = buildBinanceTransfers(
      "s",
      [
        { id: "d1", amount: "100", coin: "USDT", status: 1, txId: "0xabc", insertTime: 1 },
        { id: "d2", amount: "5", coin: "USDT", status: 6, txId: "Internal transfer 123", insertTime: 2 },
        { id: "d3", amount: "9", coin: "USDT", status: 0, txId: "0xdef", insertTime: 3 },
      ],
      [{ id: "w1", amount: "50", transactionFee: "1", coin: "USDT", status: 6, txId: "0x123", applyTime: "2027-01-02 03:04:05" }],
    );
    expect(r.map((e) => [e.kind, e.amount, e.txHash])).toEqual([
      ["transfer", "100", "0xabc"],
      ["transfer", "5", undefined],
      ["transfer", "-50", "0x123"],
      ["fee", "-1", "0x123"],
    ]);
    expect(r[2].time).toBe(Date.UTC(2027, 0, 2, 3, 4, 5));
    expect(binanceTime(1700000000000)).toBe(1700000000000);
  });

  it("Convert·소액 전환은 교환으로 묶는다", () => {
    const conv = buildBinanceConverts("s", [
      { orderId: 9, orderStatus: "SUCCESS", fromAsset: "USDT", fromAmount: "20", toAsset: "BNB", toAmount: "0.06", createTime: 1 },
      { orderId: 8, orderStatus: "FAIL", fromAsset: "USDT", fromAmount: "20", toAsset: "BNB", toAmount: "0.06", createTime: 1 },
    ]);
    expect(brief(conv)).toEqual([
      ["trade", "USDT", "-20", "bn:conv:9"],
      ["trade", "BNB", "0.06", "bn:conv:9"],
    ]);
    const dust = buildBinanceDust("s", [
      { transId: 7, operateTime: "1627575731000", userAssetDribbletDetails: [{ fromAsset: "LTC", amount: "0.000006", transferedAmount: "0.00000267", serviceChargeAmount: "0.00000005", operateTime: "1627575731000" }] },
    ]);
    expect(brief(dust)).toEqual([
      ["trade", "LTC", "-0.000006", "bn:dust:7"],
      ["trade", "BNB", "0.00000267", "bn:dust:7"],
      ["fee", "BNB", "-0.00000005", "bn:dust:7"],
    ]);
  });

  it("배당: 에어드랍·런치풀은 에어드랍, 나머지는 보상. Earn 이자는 같은 배당이 있으면 중복 제거", () => {
    const div = buildBinanceDividends("s", [
      { id: 1, amount: "10", asset: "ABC", divTime: 1000, enInfo: "Launchpool" },
      { id: 2, amount: "0.5", asset: "USDT", divTime: 2000, enInfo: "Simple Earn Flexible Interest" },
    ]);
    expect(div.map((e) => e.tag)).toEqual(["airdrop", "reward"]);
    const earn = buildBinanceEarn(
      "s",
      [
        { asset: "USDT", amount: "0.5", time: 3000, key: "a", kind: "flexible" },
        { asset: "USDT", amount: "0.7", time: 4000, key: "b", kind: "flexible" },
      ],
      div,
    );
    expect(earn.map((e) => [e.amount, e.tag, e.location])).toEqual([["0.7", "reward", "Binance Earn(유연)"]]);
  });

  it("선물: 이체는 건너뛰고, 손익·펀딩비·수수료는 파생상품, 리베이트는 보상", () => {
    const r = buildBinanceIncome("s", "um", [
      { incomeType: "TRANSFER", income: "100", asset: "USDT", time: 1, tranId: 1 },
      { incomeType: "REALIZED_PNL", income: "25", asset: "USDT", time: 2, tranId: 2, symbol: "BTCUSDT" },
      { incomeType: "COMMISSION", income: "-0.4", asset: "USDT", time: 2, tranId: 3, symbol: "BTCUSDT" },
      { incomeType: "FUNDING_FEE", income: "-0.1", asset: "USDT", time: 3, tranId: 4, symbol: "BTCUSDT" },
      { incomeType: "REFERRAL_KICKBACK", income: "0.05", asset: "USDT", time: 4, tranId: 5 },
    ]);
    expect(r.entries.map((e) => [e.kind, e.amount, e.tag])).toEqual([
      ["other", "25", undefined],
      ["other", "-0.4", undefined],
      ["other", "-0.1", undefined],
      ["income", "0.05", "reward"],
    ]);
    expect(r.derivatives).toBe(3);
  });

  it("P2P 원화 매수: 코인 입금 + 원화 지급(교환), 은행에서 들어온 원화(이체)로 원화 합계 0", () => {
    const r = buildBinanceP2P("s", [
      { orderNumber: "p1", tradeType: "BUY", asset: "USDT", fiat: "KRW", amount: "100", totalPrice: "140000", orderStatus: "COMPLETED", createTime: 1 },
      { orderNumber: "p2", tradeType: "SELL", asset: "USDT", fiat: "KRW", amount: "50", totalPrice: "70000", orderStatus: "CANCELLED", createTime: 2 },
    ]);
    expect(brief(r)).toEqual([
      ["trade", "USDT", "100", "bn:p2p:p1"],
      ["trade", "fiat:KRW", "-140000", "bn:p2p:p1"],
      ["transfer", "fiat:KRW", "140000", "bn:p2p:p1:bank"],
    ]);
  });
});
