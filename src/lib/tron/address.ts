import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";

// 트론 주소: 사람이 보는 형식은 Base58Check("T…"), API 내부는 16진수("41" + 20바이트).
const b58 = createBase58check(sha256);

const toHexStr = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function isTronAddress(s: string): boolean {
  try {
    const bytes = b58.decode(s.trim());
    return bytes.length === 21 && bytes[0] === 0x41;
  } catch {
    return false;
  }
}

// "T…" 또는 "41…"(16진수) → "T…"
export function toBase58(addr: string): string {
  const a = addr.trim();
  if (a.startsWith("T")) return a;
  const hex = a.startsWith("0x") ? `41${a.slice(2)}` : a;
  const bytes = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  return b58.encode(bytes);
}

// "T…" → "41…"(소문자 16진수)
export function toHex(addr: string): string {
  const a = addr.trim();
  if (!a.startsWith("T")) return a.toLowerCase();
  return toHexStr(b58.decode(a));
}
