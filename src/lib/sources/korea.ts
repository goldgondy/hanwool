import Decimal from "@/lib/decimal";
import { fiatAssetKey } from "@/lib/assets";
import type { RawBalance } from "@/lib/sources/types";
import { hmacRaw, sha512Hex } from "./sign";

// 업비트·빗썸 API. 공식 문서 확인: 2026-10-02. ⚠ 실제 키로 검증 전.
// - 둘 다 JWT 인증: {access_key, nonce, (timestamp), query_hash = SHA512(쿼리 문자열), query_hash_alg}
//   업비트 HS512, 빗썸 HS256. 쿼리 문자열은 실제 요청과 같은 순서·인코딩하지 않은 형태로 해시한다.
// - 업비트: 개인 API가 브라우저 요청(CORS)을 막아 /api/relay/upbit 중계를 거친다. 키에 등록한 IP에서만 동작하므로
//   중계 서버의 IP를 등록해야 한다 (개발 중에는 이 컴퓨터의 공인 IP).
// - 빗썸: 브라우저에서 직접 호출할 수 있다 (CORS 허용). 키에 IP를 제한했다면 사용자의 IP를 등록한다.

export interface KoreaCreds {
  apiKey: string;
  secret: string;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

// 값에 특수문자가 없는 파라미터만 쓰므로 인코딩 없이 그대로 잇는다 (해시와 실제 요청이 같아야 함)
export const plainQuery = (params: Record<string, string>) =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

export async function koreaJwt(exchange: "upbit" | "bithumb", c: KoreaCreds, query: string, now = Date.now(), nonce = crypto.randomUUID()) {
  const alg = exchange === "upbit" ? "HS512" : "HS256";
  const payload: Record<string, string | number> = { access_key: c.apiKey, nonce };
  if (exchange === "bithumb") payload.timestamp = now;
  if (query) {
    payload.query_hash = await sha512Hex(query);
    payload.query_hash_alg = "SHA512";
  }
  const input = `${b64urlJson({ alg, typ: "JWT" })}.${b64urlJson(payload)}`;
  const sig = await hmacRaw(alg === "HS512" ? "SHA-512" : "SHA-256", c.secret, input);
  return `${input}.${b64url(sig)}`;
}

const NAMES = { upbit: "업비트", bithumb: "빗썸" } as const;
let next = 0;
// 두 거래소 모두 초당 요청 한도가 있어(업비트 거래 그룹 초당 30회) 간격을 둔다
async function pace() {
  const now = Date.now();
  const slot = Math.max(now, next);
  next = slot + 120;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

export async function koreaGet<T>(exchange: "upbit" | "bithumb", c: KoreaCreds, path: string, params: Record<string, string> = {}): Promise<T> {
  await pace();
  const query = plainQuery(params);
  const auth = `Bearer ${await koreaJwt(exchange, c, query)}`;
  const res =
    exchange === "upbit"
      ? await fetch("/api/relay/upbit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, query, headers: { Authorization: auth } }),
        })
      : await fetch(`https://api.bithumb.com${path}${query ? `?${query}` : ""}`, { headers: { Authorization: auth } });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${NAMES[exchange]} 응답을 읽지 못했습니다 (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const err = (data as { error?: { name?: string; message?: string } }).error;
    // 업비트 no_authorization_i_p, 빗썸 out_of_scope = 허용되지 않은 IP
    if (/authorization_i_?p|out_of_scope/i.test(err?.name ?? "")) {
      throw new Error(`${NAMES[exchange]}: 이 IP가 API 키의 허용 IP로 등록되어 있지 않습니다. 키 설정에서 IP를 등록하세요 (${err?.message ?? ""})`);
    }
    throw new Error(`${NAMES[exchange]}: ${err?.message ?? `HTTP ${res.status}`}`);
  }
  return data as T;
}

// 원화는 원장과 같은 규칙(fiat:KRW)으로 표시한다
export const koreaAssetKey = (currency: string) => (currency.toUpperCase() === "KRW" ? fiatAssetKey("KRW") : currency.toUpperCase());

export async function fetchKoreaBalances(exchange: "upbit" | "bithumb", c: KoreaCreds): Promise<RawBalance[]> {
  const rows = await koreaGet<{ currency: string; balance: string; locked: string }[]>(exchange, c, "/v1/accounts");
  const out: RawBalance[] = [];
  for (const r of rows) {
    const amount = new Decimal(r.balance || 0).plus(r.locked || 0);
    if (amount.isZero()) continue;
    const coin = r.currency.toUpperCase();
    out.push({ location: NAMES[exchange], asset: coin, rawAsset: coin, assetKey: koreaAssetKey(coin), amount });
  }
  return out;
}
