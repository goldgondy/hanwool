// TON 주소: 사람이 보는 형식(EQ…/UQ…, base64url 48자)과 내부 형식("0:16진수 64자")은 같은 계정이다.
// 사용자 형식 = [플래그 1바이트, 워크체인 1바이트, 계정 해시 32바이트, CRC16 2바이트]

function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();

// 어떤 형식이든 내부 형식("0:ABC…", 대문자)으로. 잘못된 주소면 null.
export function toRawTon(input: string): string | null {
  const s = input.trim();
  const raw = s.match(/^(-?\d+):([0-9a-fA-F]{64})$/);
  if (raw) return `${raw[1]}:${raw[2].toUpperCase()}`;
  if (!/^[A-Za-z0-9_\-+/]{48}$/.test(s)) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length !== 36) return null;
  const crc = crc16(bytes.slice(0, 34));
  if (bytes[34] !== crc >> 8 || bytes[35] !== (crc & 0xff)) return null;
  const wc = bytes[1] === 0xff ? -1 : bytes[1];
  return `${wc}:${hex(bytes.slice(2, 34))}`;
}

export const isTonAddress = (s: string) => toRawTon(s) !== null;

// toncenter 거래 해시(base64) → 16진수 소문자 (거래소가 보여 주는 형식, 짝짓기용)
export function tonHashHex(b64: string): string {
  return Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}
