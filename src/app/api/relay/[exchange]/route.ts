// 거래소 API 무상태 중계 (바이비트, 비트겟, MEXC, 게이트).
// - 브라우저가 서명까지 마친 요청을 그대로 전달한다. API Secret은 여기로 오지 않는다.
// - 오픈 프록시가 되지 않도록 거래소별로 호스트·경로·전달 헤더를 고정한다. 읽기 전용 GET만 허용한다.
// - 요청·응답 내용을 저장하거나 로그로 남기지 않는다.
// (바이낸스·OKX는 /api/relay/binance, /api/relay/okx 전용 경로를 쓴다.)

interface RelayConfig {
  host: string;
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
    paths: ["/api/v2/spot/account/assets"],
    headers: ["ACCESS-KEY", "ACCESS-SIGN", "ACCESS-TIMESTAMP", "ACCESS-PASSPHRASE"],
  },
  mexc: {
    host: "https://api.mexc.com",
    paths: ["/api/v3/account"],
    headers: ["X-MEXC-APIKEY"],
  },
  gate: {
    host: "https://api.gateio.ws",
    paths: ["/api/v4/spot/accounts"],
    headers: ["KEY", "Timestamp", "SIGN"],
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

  let body: { path?: unknown; query?: unknown; headers?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청" }, { status: 400 });
  }
  const { path, query, headers } = body;
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
    method: "GET",
    headers: { ...forward, "Content-Type": "application/json" },
    cache: "no-store",
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
