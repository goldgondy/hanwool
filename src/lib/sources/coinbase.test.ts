import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { importCoinbaseKey, makeCoinbaseJwt } from "./coinbase";

// 코인베이스 키와 같은 형식(SEC1 EC PEM)의 P-256 키를 만들어, 우리 JWT를 Node crypto로 검증한다.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const SEC1_PEM = privateKey.export({ type: "sec1", format: "pem" }).toString();
const PKCS8_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY_NAME = "organizations/org-123/apiKeys/key-456";

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

async function jwtFor(pem: string) {
  const key = await importCoinbaseKey(pem);
  return makeCoinbaseJwt(KEY_NAME, key, "GET", "/api/v3/brokerage/accounts", 1_790_000_000, "abcd1234");
}

describe("코인베이스 JWT", () => {
  it("SEC1 PEM 키로 만든 JWT의 머리·내용이 공식 형식과 같다", async () => {
    const [h, p] = (await jwtFor(SEC1_PEM)).split(".");
    expect(decode(h)).toEqual({ alg: "ES256", kid: KEY_NAME, nonce: "abcd1234", typ: "JWT" });
    expect(decode(p)).toEqual({
      iss: "cdp",
      sub: KEY_NAME,
      nbf: 1_790_000_000,
      exp: 1_790_000_120,
      uri: "GET api.coinbase.com/api/v3/brokerage/accounts",
    });
  });

  it("서명이 공개키로 검증된다 (ES256, r||s 형식)", async () => {
    const [h, p, s] = (await jwtFor(SEC1_PEM)).split(".");
    const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });

  it("PKCS8 PEM과 JSON의 \\n 문자열 형태도 받는다", async () => {
    await expect(jwtFor(PKCS8_PEM)).resolves.toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    await expect(jwtFor(SEC1_PEM.replace(/\n/g, "\\n"))).resolves.toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("다른 형식의 키는 알아볼 수 있는 오류를 낸다", async () => {
    await expect(importCoinbaseKey("abc")).rejects.toThrow(/BEGIN EC PRIVATE KEY/);
    const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await expect(importCoinbaseKey(ed)).rejects.toThrow(/ECDSA/);
  });
});
