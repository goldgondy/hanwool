import Decimal from "@/lib/decimal";
import type { BinanceSource } from "@/lib/db";
import type { RawBalance, Warn } from "@/lib/sources/types";
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

export type Call = <T>(path: string, params?: Record<string, string>) => Promise<T>;

// 서명은 브라우저에서 수행하고, 서명된 쿼리만 중계 서버로 보낸다.
export function makeCall(apiKey: string, secret: string): Call {
  return async <T>(path: string, params: Record<string, string> = {}) => {
    const qs = new URLSearchParams({
      ...params,
      recvWindow: "10000",
      timestamp: String(Date.now()),
    }).toString();
    const signature = await hmacSha256Hex(secret, qs);

    const res = await fetch("/api/relay/binance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, query: `${qs}&signature=${signature}`, apiKey }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data?.msg ?? data?.error ?? `HTTP ${res.status}`) as Error & { code?: number };
      err.code = data?.code; // 예: -1121 존재하지 않는 거래쌍
      throw err;
    }
    return data as T;
  };
}

// Simple Earn 포지션 조회 (페이지당 최대 100건)
async function earnRows<T>(call: Call, path: string): Promise<T[]> {
  const rows: T[] = [];
  for (let current = 1; ; current++) {
    const page = await call<{ rows: T[]; total: number }>(path, {
      current: String(current),
      size: "100",
    });
    rows.push(...page.rows);
    if (page.rows.length === 0 || rows.length >= page.total) return rows;
  }
}

export async function fetchBinanceBalances(
  source: BinanceSource,
  warn: Warn,
): Promise<RawBalance[]> {
  const call = makeCall(source.apiKey, await decrypt(source.encSecret));

  // 필수: 실패하면 계정 전체를 오류로 처리한다.
  const [spot, funding] = await Promise.all([
    call<{ balances: { asset: string; free: string; locked: string }[] }>(
      "/api/v3/account",
      { omitZeroBalances: "true" },
    ),
    call<{ asset: string; free: string; locked: string; freeze: string }[]>(
      "/sapi/v1/asset/get-funding-asset",
    ),
  ]);

  // 선택: 권한이 없거나 계정을 개설하지 않았으면 실패할 수 있으므로 경고만 남긴다.
  const optional = [
    {
      name: "Earn(유연)",
      run: () =>
        earnRows<{ asset: string; totalAmount: string }>(
          call,
          "/sapi/v1/simple-earn/flexible/position",
        ),
    },
    {
      name: "Earn(고정)",
      run: () =>
        earnRows<{ asset: string; amount: string }>(
          call,
          "/sapi/v1/simple-earn/locked/position",
        ),
    },
    {
      name: "교차 마진",
      run: () =>
        call<{ userAssets: { asset: string; netAsset: string }[] }>(
          "/sapi/v1/margin/account",
        ),
    },
    {
      name: "USDⓈ-M 선물",
      run: () => call<{ asset: string; balance: string }[]>("/fapi/v3/balance"),
    },
    {
      name: "COIN-M 선물",
      run: () => call<{ asset: string; balance: string }[]>("/dapi/v1/balance"),
    },
  ] as const;

  const settled = await Promise.allSettled(optional.map((o) => o.run()));
  settled.forEach((r, i) => {
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      warn(`Binance ${optional[i].name} 조회 실패: ${msg}`);
    }
  });
  const value = <T,>(i: number) =>
    settled[i].status === "fulfilled" ? (settled[i].value as T) : undefined;

  const flexible = value<{ asset: string; totalAmount: string }[]>(0) ?? [];
  const locked = value<{ asset: string; amount: string }[]>(1) ?? [];
  const margin = value<{ userAssets: { asset: string; netAsset: string }[] }>(2);
  const usdm = value<{ asset: string; balance: string }[]>(3) ?? [];
  const coinm = value<{ asset: string; balance: string }[]>(4) ?? [];

  const out: RawBalance[] = [];
  const push = (location: string, asset: string, amount: Decimal, rawAsset = asset) => {
    if (!amount.isZero()) out.push({ location, asset, rawAsset, assetKey: asset, amount });
  };

  // 유연 Earn 보유분이 현물 잔고에 LD접두 자산(LDBTC 등)으로도 나타날 수 있어 중복을 제거한다.
  // 접두사만 보고 판단하면 LDO(Lido) 같은 실제 토큰까지 잘못 처리하므로, 실제 유연 포지션과 대조한다.
  const flexibleMirrors = new Set(flexible.map((f) => `LD${f.asset}`));

  for (const b of spot.balances) {
    if (flexibleMirrors.has(b.asset)) continue;
    push("Binance Spot", b.asset, new Decimal(b.free).plus(b.locked));
  }
  for (const b of funding) {
    push("Binance Funding", b.asset, new Decimal(b.free).plus(b.locked).plus(b.freeze));
  }
  for (const f of flexible) push("Binance Earn(유연)", f.asset, new Decimal(f.totalAmount));
  for (const l of locked) push("Binance Earn(고정)", l.asset, new Decimal(l.amount));
  // 순자산 = 보유 - 차입 - 이자. 음수이면 부채이며 평가액 합계에서 차감된다.
  for (const m of margin?.userAssets ?? []) {
    push("Binance Cross Margin", m.asset, new Decimal(m.netAsset));
  }
  // balance = 지갑 잔고 (미실현 손익 제외)
  for (const b of usdm) push("Binance USDⓈ-M", b.asset, new Decimal(b.balance));
  for (const b of coinm) push("Binance COIN-M", b.asset, new Decimal(b.balance));

  return out;
}
