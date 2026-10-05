import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import { signCoinone, signGopax } from "@/lib/sources/korea-more";
import { buildCoinoneTrades, buildCoinoneTransfers, buildGopaxTrades, buildGopaxTransfers } from "./korea-more-build";

const sum = (es: { assetKey: string; amount: string }[], k: string) => es.filter((e) => e.assetKey === k).reduce((s, e) => s.plus(e.amount), new Decimal(0)).toString();
const TX = "bb1d723751cc4d312c38adc13d9a45b9a16608328d0b9a10f5e3ebc647d64506";

describe("코인원 서명", () => {
  it("본문 = base64(JSON), 서명 = HMAC-SHA512(본문, 대문자 Secret) 16진수", async () => {
    const r = await signCoinone({ apiKey: "token", secret: "abc-def" }, "/v2.1/account/balance/all", { size: 1 }, "022f53b2-8b2f-40c6-8e51-b594f562ee83");
    const json = JSON.parse(Buffer.from(r.body, "base64").toString());
    expect(json).toEqual({ access_token: "token", nonce: "022f53b2-8b2f-40c6-8e51-b594f562ee83", size: 1 });
    expect(r.headers["X-COINONE-PAYLOAD"]).toBe(r.body);
    expect(r.headers["X-COINONE-SIGNATURE"]).toBe(createHmac("sha512", "ABC-DEF").update(r.body).digest("hex"));
  });
});

describe("고팍스 서명", () => {
  it('서명 = base64(HMAC-SHA512("t"+시각+GET+경로?쿼리, base64 디코딩한 Secret))', async () => {
    const secret = Buffer.from("my-secret-bytes").toString("base64");
    const r = await signGopax({ apiKey: "k", secret }, "/trades?limit=100&deepSearch=true", 1_700_000_000_000);
    const expected = createHmac("sha512", Buffer.from(secret, "base64")).update("t1700000000000GET/trades?limit=100&deepSearch=true").digest("base64");
    expect(r).toEqual({ path: "/trades", query: "limit=100&deepSearch=true", headers: { "api-key": "k", timestamp: "1700000000000", signature: expected } });
  });
});

describe("코인원 원장", () => {
  it("체결: 코인 +, 원화 −(가격×수량), 수수료 따로, 같은 주문끼리 묶음", () => {
    const es = buildCoinoneTrades("s", [
      { trade_id: "t1", order_id: "o1", quote_currency: "KRW", target_currency: "BTC", is_ask: false, price: "100000000", qty: "0.01", timestamp: 1, fee: "0.00001", fee_currency: "BTC" },
      { trade_id: "t2", order_id: "o1", quote_currency: "KRW", target_currency: "BTC", is_ask: false, price: "100000000", qty: "0.02", timestamp: 2, fee: "0.00002", fee_currency: "BTC" },
    ]);
    expect(sum(es, "BTC")).toBe("0.02997");
    expect(sum(es, "fiat:KRW")).toBe("-3000000");
    expect(new Set(es.map((e) => e.groupId))).toEqual(new Set(["coinone:o:o1"]));
  });

  it("입출금: 완료된 것만, 거래 번호를 남기고, 원화는 법정화폐로", () => {
    const es = buildCoinoneTransfers("s", [
      { id: "w1", currency: "BTC", txid: TX, type: "WITHDRAWAL", amount: "0.121", fee: "0.0001", status: "WITHDRAWAL_SUCCESS", created_at: 1, to_address: "bc1q" },
      { id: "w2", currency: "BTC", txid: "", type: "WITHDRAWAL", amount: "1", fee: "0", status: "WITHDRAWAL_FAIL", created_at: 2 },
      { id: "k1", currency: "KRW", type: "DEPOSIT", amount: "5000000", fee: "0", status: "DEPOSIT_COMPLETE", created_at: 3 },
    ]);
    expect(es.map((e) => [e.assetKey, e.kind, e.amount])).toEqual([
      ["BTC", "transfer", "-0.121"],
      ["BTC", "fee", "-0.0001"],
      ["fiat:KRW", "transfer", "5000000"],
    ]);
    expect(es[0].txHash).toBe(TX);
  });
});

describe("고팍스 원장", () => {
  it("체결과 입출금", () => {
    const trades = buildGopaxTrades("s", [{ id: 1, orderId: 9, baseAmount: 3, quoteAmount: 3000000, fee: 0.0012, feeAsset: "ZEC", timestamp: "2020-09-25T04:06:30.000Z", side: "buy", tradingPairName: "ZEC-KRW" }]);
    expect(trades.map((e) => [e.assetKey, e.amount])).toEqual([
      ["ZEC", "3"],
      ["fiat:KRW", "-3000000"],
      ["ZEC", "-0.0012"],
    ]);
    const tr = buildGopaxTransfers("s", [
      { id: 640, asset: "BTC", type: "crypto_withdrawal", netAmount: 0.0001, feeAmount: 0.0005, status: "completed", reviewStartedAt: 1595556218, completedAt: 1595556902, txId: TX },
      { id: 641, asset: "BTC", type: "crypto_deposit", netAmount: 0.5, feeAmount: 0.0001, status: "completed", reviewStartedAt: 1595556218, completedAt: 1595556902, txId: TX },
      { id: 642, asset: "KRW", type: "fiat_withdrawal", netAmount: 10000, feeAmount: 1000, status: "rejected", reviewStartedAt: 1, completedAt: null },
    ]);
    // 출금: 보낸 0.0001 + 수수료 0.0005, 입금: 받은 0.5만 (입금 수수료는 이미 빠진 금액)
    expect(tr.map((e) => [e.kind, e.amount])).toEqual([
      ["transfer", "-0.0001"],
      ["fee", "-0.0005"],
      ["transfer", "0.5"],
    ]);
    expect(tr[0].time).toBe(1595556902000);
  });
});
