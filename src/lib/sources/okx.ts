import Decimal from "@/lib/decimal";
import type { OkxSource } from "@/lib/db";
import type { RawBalance } from "@/lib/sources/types";
import { decrypt } from "@/lib/vault";

async function hmacSha256Base64(secret: string, message: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export interface Credentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export async function okxCreds(source: OkxSource): Promise<Credentials> {
  return { apiKey: source.apiKey, secret: await decrypt(source.encSecret), passphrase: await decrypt(source.encPassphrase) };
}

// 내역 API는 2초에 5회까지라 (bills-archive) 요청 사이 간격을 둔다
const MIN_INTERVAL_MS = 450;
let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_INTERVAL_MS;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

// 서명 원문: timestamp + METHOD + requestPath(쿼리 포함) + body
export async function signedGet<T>(creds: Credentials, path: string): Promise<T> {
  await pace();
  const timestamp = new Date().toISOString();
  const sign = await hmacSha256Base64(creds.secret, `${timestamp}GET${path}`);

  const res = await fetch("/api/relay/okx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path,
      apiKey: creds.apiKey,
      passphrase: creds.passphrase,
      timestamp,
      sign,
    }),
  });
  const data = await res.json();
  if (!res.ok || (data.code !== undefined && data.code !== "0")) {
    throw new Error(data?.msg || data?.error || `HTTP ${res.status}`);
  }
  return data.data as T;
}

export async function fetchOkxBalances(source: OkxSource): Promise<RawBalance[]> {
  const creds = await okxCreds(source);

  const [trading, funding, savings] = await Promise.all([
    signedGet<{ details: { ccy: string; eq: string }[] }[]>(
      creds,
      "/api/v5/account/balance",
    ),
    signedGet<{ ccy: string; bal: string }[]>(creds, "/api/v5/asset/balances"),
    signedGet<{ ccy: string; amt: string }[]>(
      creds,
      "/api/v5/finance/savings/balance",
    ),
  ]);

  const out: RawBalance[] = [];
  const push = (location: string, ccy: string, amount: string) => {
    const d = new Decimal(amount || 0);
    if (d.isZero()) return;
    out.push({ location, asset: ccy, rawAsset: ccy, assetKey: ccy, amount: d });
  };

  // eq: 통화별 자산 가치 (현물 보유 + 파생상품 평가손익)
  for (const d of trading[0]?.details ?? []) push("OKX Trading", d.ccy, d.eq);
  for (const b of funding) push("OKX Funding", b.ccy, b.bal);
  for (const s of savings) push("OKX Simple Earn", s.ccy, s.amt);

  return out;
}
