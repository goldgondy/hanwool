import Decimal from "@/lib/decimal";
import type { RawBalance } from "@/lib/sources/types";
import { koreaAssetKey } from "./korea";
import { hmacSha512Hex } from "./sign";

// 코인원·고팍스 API. 공식 문서 확인: 2026-10-05 (docs.coinone.co.kr, gopax.github.io/API). ⚠ 실제 키로 검증 전.
// - 둘 다 브라우저 직접 호출(CORS)을 막아 /api/relay/[거래소] 중계를 거친다. 서명은 브라우저에서 하고 Secret은 중계로 가지 않는다.
// - 코인원 v2.1: POST, 본문 = base64(JSON {access_token, nonce(UUID), …}), X-COINONE-SIGNATURE = HMAC-SHA512(본문, Secret) 16진수
//   (CCXT 구현처럼 Secret은 대문자로 바꿔 쓴다). 조회 기간은 한 번에 최대 90일.
// - 고팍스: GET, 서명 = base64(HMAC-SHA512("t" + 시각 + METHOD + 경로[?쿼리] + 본문, base64 디코딩한 Secret)).
//   API 키 유효기간 1년, IP 제한은 출금에만 적용.

export interface Creds {
  apiKey: string;
  secret: string;
}

let next = 0;
// 초당 요청 한도(고팍스 초당 20회)를 넉넉히 지키도록 간격을 둔다
async function pace(ms = 120) {
  const now = Date.now();
  const slot = Math.max(now, next);
  next = slot + ms;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

async function relayCall(exchange: "coinone" | "gopax", req: { path: string; query: string; headers: Record<string, string>; body?: string }) {
  const res = await fetch(`/api/relay/${exchange}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
  const text = await res.text();
  const name = exchange === "coinone" ? "코인원" : "고팍스";
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${name} 응답을 읽지 못했습니다 (HTTP ${res.status})`);
  }
  return { ok: res.ok, status: res.status, data, name };
}

// ── 코인원 ──

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export async function signCoinone(c: Creds, path: string, params: Record<string, unknown>, nonce = crypto.randomUUID()) {
  const body = b64(JSON.stringify({ access_token: c.apiKey, nonce, ...params }));
  return { path, query: "", body, headers: { "X-COINONE-PAYLOAD": body, "X-COINONE-SIGNATURE": await hmacSha512Hex(c.secret.toUpperCase(), body) } };
}

export async function coinonePost<T>(c: Creds, path: string, params: Record<string, unknown> = {}): Promise<T> {
  await pace();
  const { ok, status, data, name } = await relayCall("coinone", await signCoinone(c, path, params));
  if (!ok || data.result !== "success") {
    throw new Error(`${name}: ${String(data.error_msg ?? data.error ?? `HTTP ${status}`)}${data.error_code ? ` (코드 ${data.error_code})` : ""}`);
  }
  return data as T;
}

export async function fetchCoinoneBalances(c: Creds): Promise<RawBalance[]> {
  const r = await coinonePost<{ balances: { currency: string; available: string; limit: string }[] }>(c, "/v2.1/account/balance/all");
  const out: RawBalance[] = [];
  for (const b of r.balances) {
    const amount = new Decimal(b.available || 0).plus(b.limit || 0);
    if (amount.isZero()) continue;
    const coin = b.currency.toUpperCase();
    out.push({ location: "코인원", asset: coin, rawAsset: coin, assetKey: koreaAssetKey(coin), amount });
  }
  return out;
}

// ── 고팍스 ──

export async function signGopax(c: Creds, pathWithQuery: string, now = Date.now()) {
  const ts = String(now);
  const keyBytes = Uint8Array.from(atob(c.secret.trim()), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`t${ts}GET${pathWithQuery}`)));
  const [path, query = ""] = pathWithQuery.split("?");
  return { path, query, headers: { "api-key": c.apiKey, timestamp: ts, signature: btoa(String.fromCharCode(...sig)) } };
}

export async function gopaxGet<T>(c: Creds, path: string, params: Record<string, string> = {}): Promise<T> {
  await pace();
  const query = new URLSearchParams(params).toString();
  const { ok, status, data, name } = await relayCall("gopax", await signGopax(c, query ? `${path}?${query}` : path));
  if (!ok) throw new Error(`${name}: ${String(data.errorMessage ?? data.message ?? `HTTP ${status}`)}${data.errorCode ? ` (코드 ${data.errorCode})` : ""}`);
  return data as T;
}

export async function fetchGopaxBalances(c: Creds): Promise<RawBalance[]> {
  const rows = await gopaxGet<{ asset: string; avail: number | string; hold: number | string; pendingWithdrawal: number | string }[]>(c, "/balances");
  const out: RawBalance[] = [];
  for (const b of rows) {
    const amount = new Decimal(b.avail || 0).plus(b.hold || 0).plus(b.pendingWithdrawal || 0);
    if (amount.isZero()) continue;
    const coin = b.asset.toUpperCase();
    out.push({ location: "고팍스", asset: coin, rawAsset: coin, assetKey: koreaAssetKey(coin), amount });
  }
  return out;
}
