// 바이낸스 무상태 중계.
// - 브라우저에서 이미 HMAC 서명된 쿼리를 그대로 전달만 한다. API Secret은 여기로 오지 않는다.
// - 오픈 프록시가 되지 않도록 읽기 전용 엔드포인트만 허용한다.
// - 요청/응답 내용을 로그로 남기지 않는다.
// - 바이낸스는 미국 IP를 차단하므로 서울 리전 등에 배포해야 한다.

const SPOT = "https://api.binance.com";
const USDM = "https://fapi.binance.com";
const COINM = "https://dapi.binance.com";

const ALLOWED: Record<string, { host: string; method: "GET" | "POST" }> = {
  "/api/v3/account": { host: SPOT, method: "GET" },
  "/sapi/v1/asset/get-funding-asset": { host: SPOT, method: "POST" },
  "/sapi/v1/simple-earn/flexible/position": { host: SPOT, method: "GET" },
  "/sapi/v1/simple-earn/locked/position": { host: SPOT, method: "GET" },
  "/sapi/v1/margin/account": { host: SPOT, method: "GET" },
  "/fapi/v3/balance": { host: USDM, method: "GET" },
  "/dapi/v1/balance": { host: COINM, method: "GET" },
  // 거래 내역 (lib/ledger/binance-sync.ts)
  "/api/v3/myTrades": { host: SPOT, method: "GET" },
  "/sapi/v1/capital/deposit/hisrec": { host: SPOT, method: "GET" },
  "/sapi/v1/capital/withdraw/history": { host: SPOT, method: "GET" },
  "/sapi/v1/convert/tradeFlow": { host: SPOT, method: "GET" },
  "/sapi/v1/asset/dribblet": { host: SPOT, method: "GET" },
  "/sapi/v1/asset/assetDividend": { host: SPOT, method: "GET" },
  "/sapi/v1/simple-earn/flexible/history/rewardsRecord": { host: SPOT, method: "GET" },
  "/sapi/v1/simple-earn/locked/history/rewardsRecord": { host: SPOT, method: "GET" },
  "/sapi/v1/pay/transactions": { host: SPOT, method: "GET" },
  "/sapi/v1/c2c/orderMatch/listUserOrderHistory": { host: SPOT, method: "GET" },
  "/fapi/v1/income": { host: USDM, method: "GET" },
  "/dapi/v1/income": { host: COINM, method: "GET" },
};

export async function POST(request: Request) {
  let body: { path?: unknown; query?: unknown; apiKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청" }, { status: 400 });
  }

  const { path, query, apiKey } = body;
  if (
    typeof path !== "string" ||
    typeof query !== "string" ||
    typeof apiKey !== "string"
  ) {
    return Response.json({ error: "잘못된 요청" }, { status: 400 });
  }

  const target = ALLOWED[path];
  if (!target) {
    return Response.json({ error: "허용되지 않은 엔드포인트" }, { status: 403 });
  }
  if (!query.includes("signature=")) {
    return Response.json({ error: "서명 누락" }, { status: 400 });
  }

  const upstream = await fetch(`${target.host}${path}?${query}`, {
    method: target.method,
    headers: { "X-MBX-APIKEY": apiKey },
    cache: "no-store",
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
