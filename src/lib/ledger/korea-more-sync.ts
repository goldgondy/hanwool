import { db, type XapiSource } from "@/lib/db";
import { buildCoinoneTrades, buildCoinoneTransfers, buildGopaxTrades, buildGopaxTransfers, type CoinoneTrade, type CoinoneTransfer, type GopaxTrade, type GopaxTransfer } from "@/lib/ledger/korea-more-build";
import { coinonePost, gopaxGet, type Creds } from "@/lib/sources/korea-more";
import { xapiCreds } from "@/lib/sources/exchanges";
import type { XapiSyncResult } from "@/lib/ledger/xapi-sync";

// 코인원·고팍스 내역 동기화. 처음에는 서비스 시작 무렵부터, 다음부터는 마지막 동기화 하루 전부터 읽는다.
const DAY = 86_400_000;
const START = { coinone: Date.UTC(2016, 0, 1), gopax: Date.UTC(2018, 0, 1) };

// ── 코인원: 90일 구간마다, 구간 안은 최신순 100건씩 (to_trade_id / to_id로 이전 페이지) ──
async function coinoneWindowed<T>(c: Creds, path: string, listKey: string, cursorKey: "to_trade_id" | "to_id", idOf: (r: T) => string, from: number, now: number, onProgress: (m: string) => void, label: string) {
  const out: T[] = [];
  for (let start = from; start < now; start += 90 * DAY) {
    const end = Math.min(start + 90 * DAY - 1, now);
    onProgress(`코인원 ${label} 조회 중 (${new Date(start).toISOString().slice(0, 7)})`);
    let cursor: string | undefined;
    for (;;) {
      const r = await coinonePost<Record<string, T[]>>(c, path, { size: 100, from_ts: start, to_ts: end, ...(cursor ? { [cursorKey]: cursor } : {}) });
      const rows = r[listKey] ?? [];
      out.push(...rows);
      if (rows.length < 100) break;
      cursor = idOf(rows[rows.length - 1]);
    }
  }
  return out;
}

async function syncCoinone(source: XapiSource, c: Creds, from: number, now: number, onProgress: (m: string) => void) {
  const trades = await coinoneWindowed<CoinoneTrade>(c, "/v2.1/order/completed_orders/all", "completed_orders", "to_trade_id", (t) => t.trade_id, from, now, onProgress, "체결");
  const coin = await coinoneWindowed<CoinoneTransfer>(c, "/v2.1/transaction/coin/history", "transactions", "to_id", (t) => t.id, from, now, onProgress, "코인 입출금");
  const krw = await coinoneWindowed<CoinoneTransfer>(c, "/v2.1/transaction/krw/history", "transactions", "to_id", (t) => t.id, from, now, onProgress, "원화 입출금");
  return [...buildCoinoneTrades(source.id, trades), ...buildCoinoneTransfers(source.id, [...coin, ...krw.map((r) => ({ ...r, currency: "KRW" }))])];
}

// ── 고팍스: 최신순으로 이전 기록을 계속 읽는다 ──
async function syncGopax(source: XapiSource, c: Creds, from: number, onProgress: (m: string) => void) {
  const trades: GopaxTrade[] = [];
  let pastmax: number | undefined;
  for (let page = 1; page <= 2000; page++) {
    onProgress(`고팍스 체결 조회 중 (${page}쪽)`);
    const rows = await gopaxGet<GopaxTrade[]>(c, "/trades", { limit: "100", deepSearch: "true", ...(pastmax ? { pastmax: String(pastmax) } : {}) });
    const fresh = rows.filter((t) => Date.parse(t.timestamp) >= from);
    trades.push(...fresh);
    if (rows.length < 100 || fresh.length < rows.length) break;
    pastmax = Math.min(...rows.map((t) => t.id));
  }

  const transfers = new Map<number, GopaxTransfer>();
  let before: number | undefined;
  for (let page = 1; page <= 5000; page++) {
    onProgress(`고팍스 입출금 조회 중 (${page}쪽)`);
    const rows = await gopaxGet<GopaxTransfer[]>(c, "/deposit-withdrawal-status", { limit: "20", ...(before ? { before: String(before) } : {}) });
    const fresh = rows.filter((r) => r.reviewStartedAt * 1000 >= from && !transfers.has(r.id));
    for (const r of fresh) transfers.set(r.id, r);
    if (rows.length < 20 || fresh.length === 0) break;
    before = Math.min(...rows.map((r) => r.reviewStartedAt)) * 1000;
  }
  return [...buildGopaxTrades(source.id, trades), ...buildGopaxTransfers(source.id, [...transfers.values()])];
}

export async function syncKoreaMore(source: XapiSource & { exchange: "coinone" | "gopax" }, onProgress: (msg: string) => void): Promise<XapiSyncResult> {
  const c = await xapiCreds(source);
  const stateKey = `${source.id}:history`;
  const now = Date.now();
  const last = Number((await db.syncState.get(stateKey))?.cursor ?? 0);
  const from = last ? last - DAY : START[source.exchange];
  const entries = source.exchange === "coinone" ? await syncCoinone(source, c, from, now, onProgress) : await syncGopax(source, c, from, onProgress);

  const existing = await db.ledger.bulkGet(entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(entries);
    await db.syncState.put({ key: stateKey, cursor: String(now), syncedAt: now });
  });
  const name = source.exchange === "coinone" ? "코인원" : "고팍스";
  return {
    added: existing.filter((x) => !x).length,
    unknownTypes: [],
    warnings: [`${name} 스테이킹·이벤트 보상은 API로 제공되지 않습니다. 잔고 대조에서 늘어난 차이로 나타나면 '보상'으로 조정하세요.`],
  };
}
