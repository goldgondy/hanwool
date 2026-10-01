import { describe, expect, it } from "vitest";
import { isTronAddress, toBase58, toHex } from "./address";

// 실제 TronGrid 응답에서 확인한 같은 주소의 두 표기 (2026-10-01)
const B58 = "TWoYrRBWqb2K9viaFTwn3dDVt59Y5hgkJ7";
const HEX = "41e4870d794ffac360581af27a3d600b020983b171";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_HEX = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";

describe("트론 주소", () => {
  it("Base58과 16진수를 서로 바꾼다", () => {
    expect(toHex(B58)).toBe(HEX);
    expect(toBase58(HEX)).toBe(B58);
    expect(toHex(USDT)).toBe(USDT_HEX);
    expect(toBase58(USDT_HEX)).toBe(USDT);
    // 이벤트 로그의 0x + 20바이트 형식도 받는다
    expect(toBase58(`0x${HEX.slice(2)}`)).toBe(B58);
  });

  it("주소 형식을 검사한다", () => {
    expect(isTronAddress(B58)).toBe(true);
    expect(isTronAddress(B58.slice(0, -1) + "8")).toBe(false); // 체크섬 오류
    expect(isTronAddress("0x75541197f23762e65ffa7cb48cf881ef15fbc366")).toBe(false);
  });
});
