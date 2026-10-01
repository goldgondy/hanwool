import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { koreaJwt, plainQuery } from "@/lib/sources/korea";
import { buildKoreaOrders, buildKoreaTransfers, sumFunds } from "./korea-build";

const brief = (es: { kind: string; assetKey: string; amount: string; groupId: string }[]) => es.map((e) => [e.kind, e.assetKey, e.amount, e.groupId]);

describe("업비트·빗썸", () => {
  it("원화 매수: 코인 + 원화 지급 + 원화 수수료 (원화는 법정화폐로 표시해 '원화 매수'로 분류된다)", () => {
    const r = buildKoreaOrders("upbit", "s", [
      { uuid: "u1", side: "bid", market: "KRW-BTC", created_at: "2027-01-02T09:00:00+09:00", executed_volume: "0.01", executed_funds: sumFunds([{ funds: "600000" }, { funds: "400000" }]), paid_fee: "500", state: "done" },
      { uuid: "u2", side: "ask", market: "BTC-ETH", created_at: "2027-01-03T09:00:00+09:00", executed_volume: "1", executed_funds: "0.05", paid_fee: "0.0000125", state: "cancel" },
      { uuid: "u3", side: "bid", market: "KRW-XRP", created_at: "2027-01-03T09:00:00+09:00", executed_volume: "0", executed_funds: "0", paid_fee: "0", state: "cancel" },
    ]);
    expect(brief(r)).toEqual([
      ["trade", "BTC", "0.01", "upbit:o:u1"],
      ["trade", "fiat:KRW", "-1000000", "upbit:o:u1"],
      ["fee", "fiat:KRW", "-500", "upbit:o:u1"],
      ["trade", "ETH", "-1", "upbit:o:u2"],
      ["trade", "BTC", "0.05", "upbit:o:u2"],
      ["fee", "BTC", "-0.0000125", "upbit:o:u2"],
    ]);
    expect(r[0].time).toBe(Date.UTC(2027, 0, 2, 0, 0, 0));
  });

  it("입출금: 완료된 것만, 원화는 법정화폐 이체, 코인 출금은 거래 해시와 수수료", () => {
    const r = buildKoreaTransfers(
      "bithumb",
      "s",
      [
        { uuid: "d1", currency: "KRW", state: "ACCEPTED", created_at: "2027-01-01T10:00:00+09:00", amount: "1000000", txid: "BKTX1" },
        { uuid: "d2", currency: "USDT", state: "DEPOSIT_PROCESSING", created_at: "2027-01-01T10:00:00+09:00", amount: "5" },
      ],
      [{ uuid: "w1", currency: "USDT", state: "DONE", created_at: "2027-01-05T10:00:00+09:00", done_at: "2027-01-05T10:05:00+09:00", amount: "100", fee: "1", txid: "0xabc", transaction_type: "default" }],
    );
    expect(r.map((e) => [e.kind, e.assetKey, e.amount, e.txHash])).toEqual([
      ["transfer", "fiat:KRW", "1000000", undefined],
      ["transfer", "USDT", "-100", "0xabc"],
      ["fee", "USDT", "-1", "0xabc"],
    ]);
  });

  it("JWT: 쿼리 해시(SHA512)와 서명(업비트 HS512, 빗썸 HS256)이 표준 방식과 같다", async () => {
    const c = { apiKey: "ak", secret: "sk" };
    const query = plainQuery({ state: "done", limit: "100" });
    expect(query).toBe("state=done&limit=100");
    for (const [ex, hash] of [["upbit", "sha512"], ["bithumb", "sha256"]] as const) {
      const jwt = await koreaJwt(ex, c, query, 1700000000000, "n-1");
      const [h, p, s] = jwt.split(".");
      const payload = JSON.parse(Buffer.from(p, "base64url").toString());
      expect(payload.query_hash).toBe(createHash("sha512").update(query).digest("hex"));
      expect(payload.access_key).toBe("ak");
      expect(payload.timestamp).toBe(ex === "bithumb" ? 1700000000000 : undefined);
      expect(s).toBe(createHmac(hash, "sk").update(`${h}.${p}`).digest("base64url"));
    }
  });
});
