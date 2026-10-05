import { base58xrp } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";

// XRP 클래식 주소 ("r…"): 리플 전용 Base58 알파벳, 버전 0x00 + 계정 ID 20바이트 + 체크섬 4바이트(SHA-256 두 번).
// X-주소("X…", 태그를 합친 형식)는 받지 않고 클래식 주소를 넣도록 안내한다.

export function isXrpAddress(s: string): boolean {
  const a = s.trim();
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) return false;
  try {
    const b = base58xrp.decode(a);
    if (b.length !== 25 || b[0] !== 0) return false;
    const check = sha256(sha256(b.slice(0, 21)));
    return check[0] === b[21] && check[1] === b[22] && check[2] === b[23] && check[3] === b[24];
  } catch {
    return false;
  }
}
