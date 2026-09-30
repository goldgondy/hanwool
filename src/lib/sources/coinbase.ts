import Decimal from "@/lib/decimal";
import type { RawBalance } from "@/lib/sources/types";

// 코인베이스 Advanced Trade API (CDP API 키). 공식 문서 확인: 2026-09-30
// - 요청마다 ES256(ECDSA P-256) JWT를 만들어 Authorization: Bearer 로 보낸다. Ed25519 키는 지원하지 않는다.
// - header {alg: ES256, kid: 키 이름, nonce, typ: JWT}, payload {iss: "cdp", sub: 키 이름, nbf, exp(+120초), uri: "GET api.coinbase.com/경로"}
// - 개인키는 "-----BEGIN EC PRIVATE KEY-----"(SEC1) PEM. WebCrypto는 PKCS8만 읽으므로 감싸서 가져온다.

const HOST = "api.coinbase.com";

// ── PEM → CryptoKey ──

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

const der = (tag: number, body: Uint8Array) => Uint8Array.from([tag, ...derLength(body.length), ...body]);

// SEC1 ECPrivateKey(P-256) → PKCS8 PrivateKeyInfo
function sec1ToPkcs8(sec1: Uint8Array): Uint8Array {
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const algorithm = Uint8Array.from([
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // id-ecPublicKey
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // prime256v1
  ]);
  const inner = der(0x04, sec1);
  return der(0x30, Uint8Array.from([...version, ...algorithm, ...inner]));
}

// 코인베이스에서 받은 JSON의 "\n" 문자열 형태도 받아 준다.
export function normalizePem(pem: string) {
  return pem.replace(/\\n/g, "\n").trim();
}

export async function importCoinbaseKey(pem: string): Promise<CryptoKey> {
  const text = normalizePem(pem);
  const m = text.match(/-----BEGIN (EC )?PRIVATE KEY-----([\s\S]+?)-----END (EC )?PRIVATE KEY-----/);
  if (!m) throw new Error("개인키 형식이 아닙니다 (-----BEGIN EC PRIVATE KEY----- 로 시작해야 합니다)");
  const body = Uint8Array.from(atob(m[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const pkcs8 = m[1] ? sec1ToPkcs8(body) : body;
  try {
    return await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new Error("개인키를 읽지 못했습니다. ECDSA(ES256) 키인지 확인하세요 (Ed25519 키는 지원되지 않음)");
  }
}

// ── JWT ──

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

export async function makeCoinbaseJwt(keyName: string, key: CryptoKey, method: string, path: string, nowSec: number, nonce: string) {
  const header = { alg: "ES256", kid: keyName, nonce, typ: "JWT" };
  const payload = { iss: "cdp", sub: keyName, nbf: nowSec, exp: nowSec + 120, uri: `${method} ${HOST}${path}` };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  // WebCrypto ECDSA 서명은 r||s(64바이트) 형식으로 나온다 = JWS ES256 형식
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

const randomNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

// ── 잔고 ──

interface Account {
  currency: string;
  available_balance: { value: string };
  hold?: { value: string };
}

export async function fetchCoinbaseBalances(keyName: string, privateKeyPem: string): Promise<RawBalance[]> {
  const key = await importCoinbaseKey(privateKeyPem);
  const path = "/api/v3/brokerage/accounts";
  const out: RawBalance[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const jwt = await makeCoinbaseJwt(keyName, key, "GET", path, Math.floor(Date.now() / 1000), randomNonce());
    const query = new URLSearchParams({ limit: "250", ...(cursor ? { cursor } : {}) }).toString();
    const res = await fetch("/api/relay/coinbase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, query, headers: { Authorization: `Bearer ${jwt}` } }),
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) throw new Error("코인베이스: API 키 이름이나 개인키가 올바르지 않습니다 (HTTP 401)");
      throw new Error(`코인베이스 조회 실패 (HTTP ${res.status}) ${text.slice(0, 120)}`);
    }
    const data = JSON.parse(text) as { accounts: Account[]; has_next: boolean; cursor?: string };
    for (const a of data.accounts) {
      const amount = new Decimal(a.available_balance?.value || 0).plus(a.hold?.value || 0);
      if (!amount.isZero()) {
        out.push({ location: "Coinbase", asset: a.currency.toUpperCase(), rawAsset: a.currency, assetKey: a.currency.toUpperCase(), amount });
      }
    }
    if (!data.has_next || !data.cursor) break;
    cursor = data.cursor;
  }
  return out;
}
