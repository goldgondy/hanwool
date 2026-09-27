import Decimal from "decimal.js";
import type { BinanceSource } from "@/lib/db";
import type { RawBalance } from "@/lib/sources/types";
import { decrypt } from "@/lib/vault";

async function hmacSha256Hex(secret: string, message: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 서명은 브라우저에서 수행하고, 서명된 쿼리만 중계 서버로 보낸다.
async function signedCall<T>(
  source: BinanceSource,
  secret: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const qs = new URLSearchParams({
    ...params,
    recvWindow: "10000",
    timestamp: String(Date.now()),
  }).toString();
  const signature = await hmacSha256Hex(secret, qs);

  const res = await fetch("/api/relay/binance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path,
      query: `${qs}&signature=${signature}`,
      apiKey: source.apiKey,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.msg ?? data?.error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

// Simple Earn 유연 상품은 현물 잔고에 LDBTC처럼 표시된다.
function normalizeAsset(raw: string) {
  if (raw.startsWith("LD") && raw.length > 2) return raw.slice(2);
  return raw;
}

export async function fetchBinanceBalances(
  source: BinanceSource,
): Promise<RawBalance[]> {
  const secret = await decrypt(source.encSecret);
  const [spot, funding] = await Promise.all([
    signedCall<{ balances: { asset: string; free: string; locked: string }[] }>(
      source,
      secret,
      "/api/v3/account",
      { omitZeroBalances: "true" },
    ),
    signedCall<{ asset: string; free: string; locked: string; freeze: string }[]>(
      source,
      secret,
      "/sapi/v1/asset/get-funding-asset",
    ),
  ]);

  const out: RawBalance[] = [];
  for (const b of spot.balances) {
    const amount = new Decimal(b.free).plus(b.locked);
    if (amount.isZero()) continue;
    const isEarn = b.asset.startsWith("LD");
    out.push({
      location: isEarn ? "Binance Earn(유연)" : "Binance Spot",
      asset: normalizeAsset(b.asset),
      rawAsset: b.asset,
      amount,
    });
  }
  for (const b of funding) {
    const amount = new Decimal(b.free).plus(b.locked).plus(b.freeze);
    if (amount.isZero()) continue;
    out.push({
      location: "Binance Funding",
      asset: b.asset,
      rawAsset: b.asset,
      amount,
    });
  }
  return out;
}
