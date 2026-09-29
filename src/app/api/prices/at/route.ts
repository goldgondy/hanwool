import { pricesAt, type PriceQuery } from "@/lib/server/price-history";

// 과거 시각의 원화 시세. 요청 내용(심볼·시각)은 저장하거나 로그로 남기지 않는다.
// 응답으로 쓰인 공개 시세만 Neon에 캐시된다.

const MAX_QUERIES = 1000;

export async function POST(request: Request) {
  let body: { queries?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "잘못된 요청" }, { status: 400 });
  }
  const raw = Array.isArray(body.queries) ? body.queries : null;
  if (!raw || raw.length > MAX_QUERIES) {
    return Response.json({ error: `queries는 최대 ${MAX_QUERIES}개 배열이어야 합니다` }, { status: 400 });
  }
  const queries: PriceQuery[] = [];
  for (const q of raw) {
    const { symbol, time } = (q ?? {}) as Record<string, unknown>;
    if (typeof symbol !== "string" || !/^[A-Za-z0-9]{1,20}$/.test(symbol) || typeof time !== "number" || !Number.isFinite(time)) {
      return Response.json({ error: "잘못된 쿼리" }, { status: 400 });
    }
    queries.push({ symbol, time });
  }

  try {
    return Response.json({ results: await pricesAt(queries) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "시세 조회 실패" }, { status: 502 });
  }
}

// 대량 조회 시 외부 API를 여러 번 부르므로 넉넉히 둔다
export const maxDuration = 60;
