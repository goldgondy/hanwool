import Decimal from "@/lib/decimal";
import type { XapiSource } from "@/lib/db";
import type { RawBalance, Warn } from "@/lib/sources/types";
import { decrypt } from "@/lib/vault";
import { fetchCoinbaseBalances } from "./coinbase";
import { fetchKoreaBalances } from "./korea";
import { fetchCoinoneBalances, fetchGopaxBalances } from "./korea-more";
import { hmacSha256Base64, hmacSha256Hex, hmacSha512Hex, sha512Hex } from "./sign";

// 거래소 API 잔고 조회 (바이비트, 비트겟, MEXC, 게이트). 서명은 브라우저에서 하고 /api/relay/[거래소]로 중계한다.
// 서명 방식은 각 거래소 공식 문서·SDK 기준 (2026-09-30 확인). ⚠ 실제 키로 검증 전.

export type ApiExchange = "bybit" | "bitget" | "mexc" | "gate" | "coinbase" | "upbit" | "bithumb" | "coinone" | "gopax";

export const API_EXCHANGES: Record<
  ApiExchange,
  { name: string; needsPassphrase: boolean; keyHelp: string; keyLabel?: string; secretLabel?: string; multilineSecret?: boolean }
> = {
  upbit: {
    name: "업비트",
    needsPassphrase: false,
    keyHelp:
      "업비트 → 마이페이지 → Open API 관리 → 권한은 '자산조회·주문조회·입출금조회'만 체크. 허용 IP에 이 서비스 중계 서버의 IP를 등록해야 합니다 (개발 중에는 이 컴퓨터의 공인 IP)",
    keyLabel: "Access Key",
    secretLabel: "Secret Key",
  },
  bithumb: {
    name: "빗썸",
    needsPassphrase: false,
    keyHelp: "빗썸 → 마이페이지 → API 관리 → 권한은 '자산 조회·주문 조회·입출금 조회'만. 이 브라우저에서 직접 조회하므로 IP를 제한했다면 지금 쓰는 인터넷의 공인 IP를 등록하세요",
    keyLabel: "Connect Key (API Key)",
    secretLabel: "Secret Key",
  },
  coinone: {
    name: "코인원",
    needsPassphrase: false,
    keyHelp: "코인원 → 마이페이지 → API 관리(Open API) → 새 키 발급 → 권한은 '잔고 조회·주문 조회(체결 내역)·입출금 내역 조회'만. 주문·출금 권한은 켜지 마세요",
    keyLabel: "Access Token",
    secretLabel: "Secret Key",
  },
  gopax: {
    name: "고팍스",
    needsPassphrase: false,
    keyHelp: "고팍스 → 마이페이지 → API 키 관리 → 새 키 발급 → 권한은 조회만. 키 유효기간은 1년입니다",
    keyLabel: "API Key",
    secretLabel: "Secret",
  },
  coinbase: {
    name: "코인베이스",
    needsPassphrase: false,
    keyHelp: "coinbase.com/settings/api(CDP) → API 키 생성 → 서명 알고리즘은 ECDSA(ES256), 권한은 View(조회)만. 다운로드한 파일의 name과 privateKey를 넣으세요",
    keyLabel: "API 키 이름 (organizations/…/apiKeys/…)",
    secretLabel: "개인키 (-----BEGIN EC PRIVATE KEY----- 부터 끝까지)",
    multilineSecret: true,
  },
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

// MEXC 선물 (contract.mexc.com, 현물과 다른 서버): Signature = HMAC-SHA256(apiKey + 요청 시각 + 정렬된 쿼리) 16진수 (CCXT 구현 기준)
export async function signMexcFutures(c: Creds, path: string, params: Record<string, string>, now: number): Promise<SignedRequest> {
  const query = new URLSearchParams(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString();
  const ts = String(now);
  return {
    path,
    query,
    headers: { ApiKey: c.apiKey, "Request-Time": ts, Signature: await hmacSha256Hex(c.secret, c.apiKey + ts + query) },
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

// mexcfut: MEXC 선물 서버 (현물과 별도 중계 설정)
export async function relay(exchange: ApiExchange | "mexcfut", req: SignedRequest): Promise<unknown> {
  const res = await fetch(`/api/relay/${exchange}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const text = await res.text();
  const name = exchange === "mexcfut" ? "MEXC 선물" : API_EXCHANGES[exchange].name;
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

// 비트겟 현물 + 선물(실현 잔고 = 평가액 − 미실현 손익) + Earn. 원장도 세 계정을 한 계좌로 본다 (lib/ledger/bitget-sync.ts).
async function bitget(c: Creds, warn: Warn): Promise<RawBalance[]> {
  type R<T> = { code: string; msg: string; data: T };
  const get = async <T>(path: string, params: Record<string, string> = {}) => {
    const d = (await relay("bitget", await signBitget(c, path, params, Date.now()))) as R<T>;
    if (d.code !== "00000") throw new Error(d.msg);
    return d.data;
  };
  const out: (RawBalance | null)[] = [];
  const spot = await get<{ coin: string; available: string; frozen?: string; locked?: string }[]>("/api/v2/spot/account/assets");
  for (const x of spot) out.push(bal("Bitget 현물", x.coin, new Decimal(x.available || 0).plus(x.frozen || 0).plus(x.locked || 0)));
  for (const productType of ["USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"]) {
    try {
      const fut = await get<{ marginCoin: string; accountEquity: string; unrealizedPL?: string | null }[]>("/api/v2/mix/account/accounts", { productType });
      for (const x of fut) out.push(bal("Bitget 선물", x.marginCoin, new Decimal(x.accountEquity || 0).minus(x.unrealizedPL || 0)));
    } catch (e) {
      warn(`비트겟 선물(${productType}) 잔고 조회 실패: ${e instanceof Error ? e.message : e}`);
    }
  }
  try {
    const earn = await get<{ coin: string; amount: string }[]>("/api/v2/earn/account/assets");
    for (const x of earn) out.push(bal("Bitget Earn", x.coin, new Decimal(x.amount || 0)));
  } catch (e) {
    warn(`비트겟 Earn 잔고 조회 실패: ${e instanceof Error ? e.message : e}`);
  }
  return out.filter((x): x is RawBalance => x !== null);
}

// MEXC 현물 + 선물(평가액 − 미실현 손익). MEXC는 Earn API가 없어 Earn 예치분은 포함하지 못한다.
async function mexc(c: Creds, warn: Warn): Promise<RawBalance[]> {
  const d = (await relay("mexc", await signMexc(c, "/api/v3/account", {}, Date.now()))) as {
    balances: { asset: string; free: string; locked: string }[];
  };
  const out = d.balances.map((x) => bal("MEXC 현물", x.asset, new Decimal(x.free || 0).plus(x.locked || 0)));
  try {
    const fut = (await relay("mexcfut", await signMexcFutures(c, "/api/v1/private/account/assets", {}, Date.now()))) as {
      success: boolean;
      message?: string;
      data: { currency: string; equity: number | string; unrealized: number | string }[];
    };
    if (!fut.success) throw new Error(fut.message ?? "조회 실패");
    for (const x of fut.data) out.push(bal("MEXC 선물", x.currency, new Decimal(x.equity || 0).minus(x.unrealized || 0)));
  } catch (e) {
    warn(`MEXC 선물 잔고 조회 실패: ${e instanceof Error ? e.message : e}`);
  }
  return out.filter((x): x is RawBalance => x !== null);
}

// 게이트 현물 + USDT 무기한 선물(total = 미실현 손익 제외) + 심플 언 예치금. 원장도 한 계좌로 본다 (lib/ledger/gate-sync.ts).
async function gate(c: Creds, warn: Warn): Promise<RawBalance[]> {
  const get = async <T>(path: string) => (await relay("gate", await signGate(c, path, {}, Date.now()))) as T;
  const out: (RawBalance | null)[] = [];
  const spot = await get<{ currency: string; available: string; locked: string }[]>("/api/v4/spot/accounts");
  for (const x of spot) out.push(bal("Gate 현물", x.currency, new Decimal(x.available || 0).plus(x.locked || 0)));
  try {
    const fut = await get<{ currency: string; total: string }>("/api/v4/futures/usdt/accounts");
    out.push(bal("Gate 선물", fut.currency || "USDT", new Decimal(fut.total || 0)));
  } catch (e) {
    warn(`게이트 선물 잔고 조회 실패: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const lends = await get<{ currency: string; amount: string }[]>("/api/v4/earn/uni/lends");
    for (const x of lends) out.push(bal("Gate 심플 언", x.currency, new Decimal(x.amount || 0)));
  } catch (e) {
    warn(`게이트 심플 언 잔고 조회 실패: ${e instanceof Error ? e.message : e}`);
  }
  return out.filter((x): x is RawBalance => x !== null);
}

export async function xapiCreds(source: XapiSource): Promise<Creds> {
  return {
    apiKey: source.apiKey,
    secret: await decrypt(source.encSecret),
    passphrase: source.encPassphrase ? await decrypt(source.encPassphrase) : undefined,
  };
}

export async function fetchXapiBalances(source: XapiSource, warn: Warn = () => {}): Promise<RawBalance[]> {
  const creds = await xapiCreds(source);
  switch (source.exchange) {
    case "bybit":
      return bybit(creds, warn);
    case "bitget":
      return bitget(creds, warn);
    case "mexc":
      return mexc(creds, warn);
    case "gate":
      return gate(creds, warn);
    case "coinbase":
      return fetchCoinbaseBalances(creds.apiKey, creds.secret);
    case "upbit":
    case "bithumb":
      return fetchKoreaBalances(source.exchange, creds);
    case "coinone":
      return fetchCoinoneBalances(creds);
    case "gopax":
      return fetchGopaxBalances(creds);
  }
}
