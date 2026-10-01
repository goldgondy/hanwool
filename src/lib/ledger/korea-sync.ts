import { db, type XapiSource } from "@/lib/db";
import { buildKoreaOrders, buildKoreaTransfers, sumFunds, type KoreaOrder, type KoreaTransfer } from "@/lib/ledger/korea-build";
import { koreaGet, type KoreaCreds } from "@/lib/sources/korea";
import { xapiCreds } from "@/lib/sources/exchanges";
import type { XapiSyncResult } from "@/lib/ledger/xapi-sync";

const DAY = 86_400_000;
const START = { upbit: Date.UTC(2017, 9, 1), bithumb: Date.UTC(2014, 0, 1) };
const NAME = { upbit: "업비트", bithumb: "빗썸" } as const;

// 최신순 페이지(100건)를 from 이전 기록이 나올 때까지 읽는다
async function pages<T extends { created_at: string }>(ex: "upbit" | "bithumb", c: KoreaCreds, path: string, params: Record<string, string>, from: number, onPage: () => void): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 1000; page++) {
    const rows = await koreaGet<T[]>(ex, c, path, { ...params, limit: "100", page: String(page), order_by: "desc" });
    onPage();
    const fresh = rows.filter((r) => Date.parse(r.created_at) >= from);
    out.push(...fresh);
    if (rows.length < 100 || fresh.length < rows.length) break;
  }
  return out;
}

// 업비트 종료 주문: 7일 구간씩. 체결 금액은 주문마다 개별 조회의 체결 목록에서 합한다.
async function upbitOrders(c: KoreaCreds, from: number, now: number, onProgress: (msg: string) => void): Promise<KoreaOrder[]> {
  const orders: KoreaOrder[] = [];
  for (let start = from; start < now; start += 7 * DAY) {
    const end = Math.min(start + 7 * DAY, now);
    onProgress(`업비트 주문 조회 중 (${new Date(start).toISOString().slice(0, 10)})`);
    for (const state of ["done", "cancel"]) {
      let s = start;
      for (;;) {
        const rows = await koreaGet<KoreaOrder[]>("upbit", c, "/v1/orders/closed", { state, start_time: String(s), end_time: String(end), limit: "1000", order_by: "asc" });
        orders.push(...rows);
        if (rows.length < 1000) break;
        s = Math.max(...rows.map((r) => Date.parse(r.created_at))) + 1;
      }
    }
  }
  const filled = orders.filter((o) => Number(o.executed_volume) > 0);
  for (const [i, o] of filled.entries()) {
    onProgress(`업비트 체결 금액 조회 중 (${i + 1}/${filled.length})`);
    const detail = await koreaGet<{ trades?: { funds: string }[] }>("upbit", c, "/v1/order", { uuid: o.uuid });
    o.executed_funds = sumFunds(detail.trades ?? []);
  }
  return filled;
}

export async function syncKorea(source: XapiSource & { exchange: "upbit" | "bithumb" }, onProgress: (msg: string) => void): Promise<XapiSyncResult> {
  const ex = source.exchange;
  const c = await xapiCreds(source);
  const stateKey = `${source.id}:history`;
  const now = Date.now();
  const last = Number((await db.syncState.get(stateKey))?.cursor ?? 0);
  const from = last ? last - DAY : START[ex];
  let n = 0;
  const tick = () => onProgress(`${NAME[ex]} 입출금 조회 중 (${++n}쪽)`);

  const orders =
    ex === "upbit"
      ? await upbitOrders(c, from, now, onProgress)
      : [
          ...(await pages<KoreaOrder>(ex, c, "/v1/orders", { state: "done" }, from, () => onProgress(`빗썸 주문 조회 중 (${++n}쪽)`))),
          ...(await pages<KoreaOrder>(ex, c, "/v1/orders", { state: "cancel" }, from, () => onProgress(`빗썸 주문 조회 중 (${++n}쪽)`))),
        ];

  // 업비트는 원화 입출금도 같은 목록에, 빗썸은 원화 입출금 목록이 따로 있다
  const deposits = await pages<KoreaTransfer>(ex, c, "/v1/deposits", {}, from, tick);
  const withdrawals = await pages<KoreaTransfer>(ex, c, "/v1/withdraws", {}, from, tick);
  if (ex === "bithumb") {
    const krw = (rows: KoreaTransfer[]) => rows.map((r) => ({ ...r, currency: r.currency || "KRW" }));
    deposits.push(...krw(await pages<KoreaTransfer>(ex, c, "/v1/deposits/krw", {}, from, tick)));
    withdrawals.push(...krw(await pages<KoreaTransfer>(ex, c, "/v1/withdraws/krw", {}, from, tick)));
  }

  const entries = [...buildKoreaOrders(ex, source.id, orders), ...buildKoreaTransfers(ex, source.id, deposits, withdrawals)];
  const existing = await db.ledger.bulkGet(entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(entries);
    await db.syncState.put({ key: stateKey, cursor: String(now), syncedAt: now });
  });
  const warnings = [`${NAME[ex]} 스테이킹 보상·에어드랍은 API로 제공되지 않습니다. 잔고 대조에서 늘어난 차이로 나타나면 '보상'으로 조정하세요.`];
  return { added: existing.filter((x) => !x).length, unknownTypes: [], warnings };
}
