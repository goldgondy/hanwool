// 솔라나 공식 RPC 무상태 중계. 공식 RPC는 브라우저 요청을 막아(403) 서버를 거쳐야 한다.
// - 읽기 전용 메서드만 허용하고, 단건 요청만 받는다 (배치 불가).
// - 전체 계정 조회(getProgramAccounts)는 스테이킹 프로그램 + 필터가 있는 경우만 허용한다.
// - 요청·응답 내용(지갑 주소 포함)을 저장하거나 로그로 남기지 않는다.

const UPSTREAM = "https://api.mainnet-beta.solana.com";
const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";

const METHODS = new Set([
  "getSignaturesForAddress",
  "getTransaction",
  "getBalance",
  "getTokenAccountsByOwner",
  "getProgramAccounts",
  "getInflationReward",
  "getBlockTime",
  "getEpochInfo",
]);

export async function POST(request: Request) {
  const text = await request.text();
  if (text.length > 20_000) return Response.json({ error: "요청이 너무 큽니다" }, { status: 413 });

  let body: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "잘못된 요청" }, { status: 400 });
  }
  if (Array.isArray(body) || typeof body !== "object" || body === null) return Response.json({ error: "단건 요청만 허용" }, { status: 400 });
  const { method, params } = body;
  if (typeof method !== "string" || !METHODS.has(method) || !Array.isArray(params)) {
    return Response.json({ error: "허용되지 않은 메서드" }, { status: 403 });
  }
  if (method === "getProgramAccounts") {
    const opts = params[1] as { filters?: unknown[] } | undefined;
    if (params[0] !== STAKE_PROGRAM || !Array.isArray(opts?.filters) || opts.filters.length === 0) {
      return Response.json({ error: "허용되지 않은 조회" }, { status: 403 });
    }
  }

  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
