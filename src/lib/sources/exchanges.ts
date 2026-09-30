import Decimal from "@/lib/decimal";
import type { XapiSource } from "@/lib/db";
import type { RawBalance, Warn } from "@/lib/sources/types";
import { decrypt } from "@/lib/vault";
import { hmacSha256Base64, hmacSha256Hex, hmacSha512Hex, sha512Hex } from "./sign";

// 거래소 API 잔고 조회 (바이비트, 비트겟, MEXC, 게이트). 서명은 브라우저에서 하고 /api/relay/[거래소]로 중계한다.
// 서명 방식은 각 거래소 공식 문서·SDK 기준 (2026-09-30 확인). ⚠ 실제 키로 검증 전.

export type ApiExchange = "bybit" | "bitget" | "mexc" | "gate";

export const API_EXCHANGES: Record<ApiExchange, { name: string; needsPassphrase: boolean; keyHelp: string }> = {
  bybit: { name: "바이비트", needsPassphrase: false, keyHelp: "API 관리 → 새 키 생성 → 시스템 생성 키, 권한은 읽기 전용(Read-Only)" },
  bitget: { name: "비트겟", needsPassphrase: true, keyHelp: "API 관리 → API 키 생성 → 권한은 읽기(Read-only)만. 생성 시 정한 Passphrase가 필요" },
  mexc: { name: "MEXC", needsPassphrase: false, keyHelp: "API 관리 → 키 생성 → 권한은 조회(Read)만" },
  gate: { name: "게이트", needsPassphrase: false, keyHelp: "API 관리 → APIv4 키 생성 → 권한은 읽기 전용(Read Only)만" },
};

export interface Creds {
  apiKey: string;
  secret: string;
  passphrase?: string;
}

export interface SignedRequest {
  path: string;
  query: string;
  headers: Record<string, string>;
}

// ── 서명 요청 만들기 (순수 함수, now를 받아 테스트 가능) ──

// 바이비트 V5: sign = HMAC-SHA256(timestamp + apiKey + recvWindow + queryString) 소문자 16진수
export async function signBybit(c: Creds, path: string, params: Record<string, string>, now: number): Promise<SignedRequest> {
  const query = new URLSearchParams(params).toString();
  const ts = String(now);
  const recv = "10000";
  return {
    path,
    query,
    headers: {
      "X-BAPI-API-KEY": c.apiKey,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": recv,
      "X-BAPI-SIGN": await hmacSha256Hex(c.secret, ts + c.apiKey + recv + query),
    },
  };
}

// 비트겟 V2: sign = base64(HMAC-SHA256(timestamp + METHOD + requestPath[?query] + body)), 시각은 밀리초
export async function signBitget(c: Creds, path: string, params: Record<string, string>, now: number): Promise<SignedRequest> {
  const query = new URLSearchParams(params).toString();
  const ts = String(now);
  return {
    path,
    query,
    headers: {
      "ACCESS-KEY": c.apiKey,
      "ACCESS-TIMESTAMP": ts,
      "ACCESS-PASSPHRASE": c.passphrase ?? "",
      "ACCESS-SIGN": await hmacSha256Base64(c.secret, `${ts}GET${path}${query ? `?${query}` : ""}`),
    },
  };
}

// MEXC V3 (바이낸스 방식): signature = HMAC-SHA256(쿼리 문자열) 소문자 16진수, 쿼리 끝에 붙인다
export async function signMexc(c: Creds, path: string, params: Record<string, string>, now: number): Promise<SignedRequest> {
  const base = new URLSearchParams({ ...params, recvWindow: "10000", timestamp: String(now) }).toString();
  return {
    path,
    query: `${base}&signature=${await hmacSha256Hex(c.secret, base)}`,
    headers: { "X-MEXC-APIKEY": c.apiKey },
  };
}

// 게이트 V4: sign = HMAC-SHA512("METHOD\n/api/v4/경로\n쿼리\nSHA512(본문)\n시각(초)") 16진수
export async function signGate(c: Creds, path: string, params: Record<string, string>, now: number): Promise<SignedRequest> {
  const query = new URLSearchParams(params).toString();
  const ts = String(Math.floor(now / 1000));
  const message = ["GET", path, query, await sha512Hex(""), ts].join("\n");
  return {
    path,
    query,
    headers: { KEY: c.apiKey, Timestamp: ts, SIGN: await hmacSha512Hex(c.secret, message) },
  };
}

// ── 조회 ──

async function relay(exchange: ApiExchange, req: SignedRequest): Promise<unknown> {
  const res = await fetch(`/api/relay/${exchange}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const text = await res.text();
  const name = API_EXCHANGES[exchange].name;
  // 바이비트 등은 인증 실패 시 본문 없이 401을 돌려준다.
  if (!text.trim() && (res.status === 401 || res.status === 403)) {
    throw new Error(`${name}: API 키가 올바르지 않거나 권한이 없습니다 (HTTP ${res.status})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${name} 응답을 읽지 못했습니다 (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const d = data as Record<string, unknown>;
    throw new Error(String(d.retMsg ?? d.msg ?? d.message ?? d.error ?? `HTTP ${res.status}`));
  }
  return data;
}

const bal = (location: string, coin: string, amount: Decimal): RawBalance | null =>
  amount.isZero() ? null : { location, asset: coin.toUpperCase(), rawAsset: coin, assetKey: coin.toUpperCase(), amount };

async function bybit(c: Creds, warn: Warn): Promise<RawBalance[]> {
  const out: (RawBalance | null)[] = [];
  type R<T> = { retCode: number; retMsg: string; result: T };
  const check = <T>(d: R<T>) => {
    if (d.retCode !== 0) throw new Error(d.retMsg);
    return d.result;
  };
  const unified = check(
    (await relay("bybit", await signBybit(c, "/v5/account/wallet-balance", { accountType: "UNIFIED" }, Date.now()))) as R<{
      list: { coin: { coin: string; walletBalance: string }[] }[];
    }>,
  );
  for (const x of unified.list[0]?.coin ?? []) out.push(bal("Bybit 통합 계정", x.coin, new Decimal(x.walletBalance || 0)));
  try {
    const fund = check(
      (await relay("bybit", await signBybit(c, "/v5/asset/transfer/query-account-coins-balance", { accountType: "FUND" }, Date.now()))) as R<{
        balance: { coin: string; walletBalance: string }[];
      }>,
    );
    for (const x of fund.balance ?? []) out.push(bal("Bybit 펀딩", x.coin, new Decimal(x.walletBalance || 0)));
  } catch (e) {
    warn(`바이비트 펀딩 계정 조회 실패: ${e instanceof Error ? e.message : e}`);
  }
  return out.filter((x): x is RawBalance => x !== null);
}

async function bitget(c: Creds): Promise<RawBalance[]> {
  const d = (await relay("bitget", await signBitget(c, "/api/v2/spot/account/assets", {}, Date.now()))) as {
    code: string;
    msg: string;
    data: { coin: string; available: string; frozen?: string; locked?: string }[];
  };
  if (d.code !== "00000") throw new Error(d.msg);
  return d.data
    .map((x) => bal("Bitget 현물", x.coin, new Decimal(x.available || 0).plus(x.frozen || 0).plus(x.locked || 0)))
    .filter((x): x is RawBalance => x !== null);
}

async function mexc(c: Creds): Promise<RawBalance[]> {
  const d = (await relay("mexc", await signMexc(c, "/api/v3/account", {}, Date.now()))) as {
    balances: { asset: string; free: string; locked: string }[];
  };
  return d.balances
    .map((x) => bal("MEXC 현물", x.asset, new Decimal(x.free || 0).plus(x.locked || 0)))
    .filter((x): x is RawBalance => x !== null);
}

async function gate(c: Creds): Promise<RawBalance[]> {
  const d = (await relay("gate", await signGate(c, "/api/v4/spot/accounts", {}, Date.now()))) as {
    currency: string;
    available: string;
    locked: string;
  }[];
  return d
    .map((x) => bal("Gate 현물", x.currency, new Decimal(x.available || 0).plus(x.locked || 0)))
    .filter((x): x is RawBalance => x !== null);
}

export async function fetchXapiBalances(source: XapiSource, warn: Warn = () => {}): Promise<RawBalance[]> {
  const creds: Creds = {
    apiKey: source.apiKey,
    secret: await decrypt(source.encSecret),
    passphrase: source.encPassphrase ? await decrypt(source.encPassphrase) : undefined,
  };
  switch (source.exchange) {
    case "bybit":
      return bybit(creds, warn);
    case "bitget":
      return bitget(creds);
    case "mexc":
      return mexc(creds);
    case "gate":
      return gate(creds);
  }
}
