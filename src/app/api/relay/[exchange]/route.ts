// 거래소 API 무상태 중계 (바이비트, 비트겟, MEXC, 게이트, 업비트, 코인원, 고팍스, 코인베이스).
// - 브라우저가 서명까지 마친 요청을 그대로 전달한다. API Secret은 여기로 오지 않는다.
// - 오픈 프록시가 되지 않도록 거래소별로 호스트·경로·전달 헤더를 고정한다. 조회 경로만 허용한다 (코인원은 조회도 POST).
// - 요청·응답 내용을 저장하거나 로그로 남기지 않는다.
// (바이낸스·OKX는 /api/relay/binance, /api/relay/okx 전용 경로를 쓴다.)

interface RelayConfig {
  host: string;
  method?: "GET" | "POST"; // POST: 서명된 본문을 그대로 전달 (코인원)
  paths: string[];
  patterns?: RegExp[]; // 경로에 ID가 들어가는 엔드포인트
  headers: string[]; // 전달을 허용하는 인증 헤더
}

const RELAYS: Record<string, RelayConfig> = {
  bybit: {
    host: "https://api.bybit.com",
    paths: [
      "/v5/account/wallet-balance",
      "/v5/asset/transfer/query-account-coins-balance",
      "/v5/account/transaction-log",
      "/v5/asset/deposit/query-record",
      "/v5/asset/withdraw/query-record",
    ],
    headers: ["X-BAPI-API-KEY", "X-BAPI-TIMESTAMP", "X-BAPI-SIGN", "X-BAPI-RECV-WINDOW"],
  },
  bitget: {
    host: "https://api.bitget.com",
    paths: ["/api/v2/spot/account/assets", "/api/v2/spot/account/bills", "/api/v2/spot/wallet/deposit-records", "/api/v2/spot/wallet/withdrawal-records",
      "/api/v2/mix/account/bill", "/api/v2/mix/account/accounts", "/api/v2/earn/savings/records", "/api/v2/earn/account/assets"],
    headers: ["ACCESS-KEY", "ACCESS-SIGN", "ACCESS-TIMESTAMP", "ACCESS-PASSPHRASE"],
  },
  mexc: {
    host: "https://api.mexc.com",
    paths: ["/api/v3/account", "/api/v3/myTrades", "/api/v3/capital/deposit/hisrec", "/api/v3/capital/withdraw/history"],
    headers: ["X-MEXC-APIKEY"],
  },
  // 업비트: 개인 API가 브라우저 요청을 막아 중계한다. JWT에 쿼리 해시가 서명되어 있어 다른 조회로 바꿔 쓸 수 없다.
  // 키에 등록한 IP에서만 동작하므로 이 서버의 공인 IP를 사용자가 업비트에 등록해야 한다.
  upbit: {
    host: "https://api.upbit.com",
    paths: ["/v1/accounts", "/v1/orders/closed", "/v1/order", "/v1/deposits", "/v1/withdraws"],
    headers: ["Authorization"],
  },
  // MEXC 선물은 현물과 다른 서버. 서명에 API 키·시각·쿼리가 들어간다.
  mexcfut: {
    host: "https://contract.mexc.com",
    paths: ["/api/v1/private/account/assets", "/api/v1/private/position/list/history_positions"],
    headers: ["ApiKey", "Request-Time", "Signature"],
  },
  gate: {
    host: "https://api.gateio.ws",
    paths: ["/api/v4/spot/accounts", "/api/v4/spot/account_book", "/api/v4/wallet/deposits", "/api/v4/wallet/withdrawals",
      "/api/v4/futures/usdt/account_book", "/api/v4/futures/usdt/accounts", "/api/v4/earn/uni/lends", "/api/v4/earn/uni/interest_records"],
    headers: ["KEY", "Timestamp", "SIGN"],
  },
  // 코인원 v2.1: 조회도 POST. 본문(base64 JSON)이 서명되어 있어 다른 조회로 바꿀 수 없다. 조회 경로만 허용한다.
  coinone: {
    host: "https://api.coinone.co.kr",
    method: "POST",
    paths: ["/v2.1/account/balance/all", "/v2.1/order/completed_orders/all", "/v2.1/transaction/coin/history", "/v2.1/transaction/krw/history"],
    headers: ["X-COINONE-PAYLOAD", "X-COINONE-SIGNATURE"],
  },
  // 고팍스: 서명에 경로·쿼리·시각이 들어간다.
  gopax: {
    host: "https://api.gopax.co.kr",
    paths: ["/balances", "/trades", "/deposit-withdrawal-status"],
    headers: ["api-key", "timestamp", "signature"],
  },
  // JWT에 요청 경로가 서명되어 있어, 다른 경로로 바꿔 쓸 수 없다.
  coinbase: {
    host: "https://api.coinbase.com",
    paths: ["/api/v3/brokerage/accounts", "/v2/accounts"],
    patterns: [/^\/v2\/accounts\/[A-Za-z0-9-]{1,64}\/transactions$/],
    headers: ["Authorization"],
  },
};

export async function POST(request: Request, { params }: { params: Promise<{ exchange: string }> }) {
  const { exchange } = await params;
  const config = RELAYS[exchange];
  if (!config) return Response.json({ error: "지원하지 않는 거래소" }, { status: 404 });

  let body: { path?: unknown; query?: unknown; headers?: unknown; body?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청" }, { status: 400 });
  }
  const { path, query, headers } = body;
  const method = config.method ?? "GET";
  if (method === "POST" && (typeof body.body !== "string" || body.body.length > 4096)) {
    return Response.json({ error: "잘못된 요청" }, { status: 400 });
  }
  if (typeof path !== "string" || typeof query !== "string" || typeof headers !== "object" || headers === null) {
    return Response.json({ error: "잘못된 요청" }, { status: 400 });
  }
  if (!config.paths.includes(path) && !config.patterns?.some((p) => p.test(path))) {
    return Response.json({ error: "허용되지 않은 엔드포인트" }, { status: 403 });
  }

  const forward: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (!config.headers.includes(name) || typeof value !== "string") {
      return Response.json({ error: `허용되지 않은 헤더: ${name}` }, { status: 400 });
    }
    forward[name] = value;
  }

  const upstream = await fetch(`${config.host}${path}${query ? `?${query}` : ""}`, {
    method,
    headers: { ...forward, "Content-Type": "application/json" },
    body: method === "POST" ? (body.body as string) : undefined,
    cache: "no-store",
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
