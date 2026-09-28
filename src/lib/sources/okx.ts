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

interface Credentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

// 서명 원문: timestamp + METHOD + requestPath(쿼리 포함) + body
async function signedGet<T>(creds: Credentials, path: string): Promise<T> {
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
  const creds: Credentials = {
    apiKey: source.apiKey,
    secret: await decrypt(source.encSecret),
    passphrase: await decrypt(source.encPassphrase),
  };

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
