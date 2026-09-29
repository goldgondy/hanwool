import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptField, encryptField, needsReencrypt, parseKeyRing } from "./crypto";

const key = () => randomBytes(32).toString("base64");
const K1 = key();
const K2 = key();
const ring1 = parseKeyRing(`k1:${K1}`);
const ring12 = parseKeyRing(`k1:${K1},k2:${K2}`);
const CTX = "source:11111111-1111-1111-1111-111111111111:secret";

describe("encryptField / decryptField", () => {
  it("암호화한 값을 같은 context로 복호화하면 원래 값이 나온다", () => {
    const secret = JSON.stringify({ apiSecret: "abc한글123", passphrase: "p@ss" });
    const token = encryptField(ring1, secret, CTX);
    expect(token.startsWith("v1.k1.")).toBe(true);
    expect(token).not.toContain("abc");
    expect(decryptField(ring1, token, CTX)).toBe(secret);
  });

  it("같은 값도 매번 다른 암호문이 된다", () => {
    expect(encryptField(ring1, "same", CTX)).not.toBe(encryptField(ring1, "same", CTX));
  });

  it("다른 행·필드로 옮긴 암호문은 복호화되지 않는다", () => {
    const token = encryptField(ring1, "secret", CTX);
    expect(() => decryptField(ring1, token, "source:22222222-2222-2222-2222-222222222222:secret")).toThrow(/복호화에 실패/);
    expect(() => decryptField(ring1, token, CTX.replace(":secret", ":config"))).toThrow(/복호화에 실패/);
  });

  it("암호문을 한 글자라도 바꾸면 복호화되지 않는다", () => {
    const token = encryptField(ring1, "secret", CTX);
    const parts = token.split(".");
    const ct = parts[4];
    parts[4] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    expect(() => decryptField(ring1, parts.join("."), CTX)).toThrow(/복호화에 실패/);
  });

  it("다른 마스터 키로는 복호화되지 않는다", () => {
    const token = encryptField(ring1, "secret", CTX);
    expect(() => decryptField(parseKeyRing(`k1:${K2}`), token, CTX)).toThrow(/복호화에 실패/);
  });
});

describe("키 교체", () => {
  it("새 키가 추가되면 새 키로 암호화하고, 예전 키 암호문도 읽는다", () => {
    const old = encryptField(ring1, "old", CTX);
    const fresh = encryptField(ring12, "new", CTX);
    expect(fresh.startsWith("v1.k2.")).toBe(true);
    expect(decryptField(ring12, old, CTX)).toBe("old");
    expect(decryptField(ring12, fresh, CTX)).toBe("new");
    expect(needsReencrypt(ring12, old)).toBe(true);
    expect(needsReencrypt(ring12, fresh)).toBe(false);
  });

  it("예전 키를 목록에서 빼면 그 키로 만든 암호문은 읽지 못한다", () => {
    const old = encryptField(ring1, "old", CTX);
    expect(() => decryptField(parseKeyRing(`k2:${K2}`), old, CTX)).toThrow(/k1가 없습니다/);
  });
});

describe("parseKeyRing", () => {
  it("잘못된 설정을 거부한다", () => {
    expect(() => parseKeyRing(undefined)).toThrow(/설정되지 않았습니다/);
    expect(() => parseKeyRing("k1:" + randomBytes(16).toString("base64"))).toThrow(/32바이트/);
    expect(() => parseKeyRing(`k1:${K1},k1:${K2}`)).toThrow(/중복/);
    expect(() => parseKeyRing("nocolon")).toThrow(/형식/);
  });
});
