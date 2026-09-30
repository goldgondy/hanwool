import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signBitget, signBybit, signGate, signMexc } from "./exchanges";

// 각 거래소 공식 문서·SDK에 적힌 공식을 Node crypto로 따로 계산해 우리 서명(WebCrypto)과 비교한다.
const C = { apiKey: "test-api-key", secret: "test-secret-값", passphrase: "pp" };
const NOW = 1_790_000_000_123;

describe("거래소 서명", () => {
  it("바이비트: HMAC-SHA256(timestamp + apiKey + recvWindow + query) 16진수", async () => {
    const r = await signBybit(C, "/v5/account/wallet-balance", { accountType: "UNIFIED" }, NOW);
    const expected = createHmac("sha256", C.secret).update(`${NOW}${C.apiKey}10000accountType=UNIFIED`).digest("hex");
    expect(r.query).toBe("accountType=UNIFIED");
    expect(r.headers).toEqual({
      "X-BAPI-API-KEY": C.apiKey,
      "X-BAPI-TIMESTAMP": String(NOW),
      "X-BAPI-RECV-WINDOW": "10000",
      "X-BAPI-SIGN": expected,
    });
  });

  it("비트겟: base64(HMAC-SHA256(timestamp + GET + path[?query])), 쿼리 없으면 ? 없음", async () => {
    const r = await signBitget(C, "/api/v2/spot/account/assets", {}, NOW);
    const expected = createHmac("sha256", C.secret).update(`${NOW}GET/api/v2/spot/account/assets`).digest("base64");
    expect(r.headers["ACCESS-SIGN"]).toBe(expected);
    expect(r.headers["ACCESS-PASSPHRASE"]).toBe("pp");

    const q = await signBitget(C, "/api/v2/spot/account/assets", { coin: "BTC" }, NOW);
    expect(q.headers["ACCESS-SIGN"]).toBe(
      createHmac("sha256", C.secret).update(`${NOW}GET/api/v2/spot/account/assets?coin=BTC`).digest("base64"),
    );
  });

  it("MEXC: 쿼리에 timestamp·signature(HMAC-SHA256 16진수)를 붙인다", async () => {
    const r = await signMexc(C, "/api/v3/account", {}, NOW);
    const base = `recvWindow=10000&timestamp=${NOW}`;
    expect(r.query).toBe(`${base}&signature=${createHmac("sha256", C.secret).update(base).digest("hex")}`);
    expect(r.headers).toEqual({ "X-MEXC-APIKEY": C.apiKey });
  });

  it("게이트: HMAC-SHA512(GET\\n경로\\n쿼리\\nSHA512(빈 본문)\\n초 단위 시각) 16진수", async () => {
    const r = await signGate(C, "/api/v4/spot/accounts", {}, NOW);
    const ts = String(Math.floor(NOW / 1000));
    const bodyHash = createHash("sha512").update("").digest("hex");
    const expected = createHmac("sha512", C.secret).update(`GET\n/api/v4/spot/accounts\n\n${bodyHash}\n${ts}`).digest("hex");
    expect(r.headers).toEqual({ KEY: C.apiKey, Timestamp: ts, SIGN: expected });
  });
});
