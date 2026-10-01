// 거래소 API 서명용 WebCrypto 도우미 (브라우저·Node 공통). Secret은 이 기기 밖으로 나가지 않는다.

const enc = new TextEncoder();

async function hmac(hash: "SHA-256" | "SHA-512", secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export const hmacRaw = hmac;
export const hmacSha256Hex = async (secret: string, message: string) => hex(await hmac("SHA-256", secret, message));
export const hmacSha256Base64 = async (secret: string, message: string) => base64(await hmac("SHA-256", secret, message));
export const hmacSha512Hex = async (secret: string, message: string) => hex(await hmac("SHA-512", secret, message));
export const sha512Hex = async (message: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-512", enc.encode(message))));
