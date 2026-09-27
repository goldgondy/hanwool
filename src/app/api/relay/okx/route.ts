// OKX 무상태 중계. 바이낸스 중계와 같은 원칙을 따른다.
// - 서명(OK-ACCESS-SIGN)은 브라우저에서 만들어 오며, API Secret은 여기로 오지 않는다.
// - Passphrase는 OKX 인증 헤더로 전달해야 하므로 중계를 거치지만, 저장하거나 로그로 남기지 않는다.
// - 읽기 전용 GET 엔드포인트만 허용한다.

const OKX_BASE = "https://www.okx.com";

const ALLOWED = new Set([
  "/api/v5/account/balance",
  "/api/v5/asset/balances",
  "/api/v5/finance/savings/balance",
]);

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청" }, { status: 400 });
  }

  const { path, apiKey, passphrase, timestamp, sign } = body;
  if (
    typeof path !== "string" ||
    typeof apiKey !== "string" ||
    typeof passphrase !== "string" ||
    typeof timestamp !== "string" ||
    typeof sign !== "string"
  ) {
    return Response.json({ error: "잘못된 요청" }, { status: 400 });
  }

  if (!ALLOWED.has(path.split("?")[0])) {
    return Response.json({ error: "허용되지 않은 엔드포인트" }, { status: 403 });
  }

  const upstream = await fetch(`${OKX_BASE}${path}`, {
    method: "GET",
    headers: {
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": passphrase,
    },
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
