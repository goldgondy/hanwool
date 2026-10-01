import { base58 } from "@scure/base";

// 솔라나 주소: 32바이트 공개키의 Base58 표기 (32~44자). 체크섬이 없어 길이만 확인할 수 있다.
export function isSolanaAddress(s: string): boolean {
  const v = s.trim();
  if (v.length < 32 || v.length > 44) return false;
  try {
    return base58.decode(v).length === 32;
  } catch {
    return false;
  }
}
