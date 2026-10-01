import Decimal from "@/lib/decimal";
import { db, type XapiSource } from "@/lib/db";
import { buildBybitEntries, type BybitDeposit, type BybitLog, type BybitWithdrawal } from "@/lib/ledger/bybit-build";
import { buildCoinbaseEntries, type CoinbaseTx } from "@/lib/ledger/coinbase-build";
import { coinbaseGet, importCoinbaseKey, listCoinbaseAccounts } from "@/lib/sources/coinbase";
import { buildBitgetEntries, type BitgetBill, type BitgetTransfer } from "@/lib/ledger/bitget-build";
import { buildGateEntries, type GateBook, type GateTransfer } from "@/lib/ledger/gate-build";
import { buildMexcEntries, MEXC_QUOTES, type MexcDeposit, type MexcTrade, type MexcWithdrawal } from "@/lib/ledger/mexc-build";
import { relay, signBitget, signBybit, signGate, signMexc, xapiCreds, type Creds } from "@/lib/sources/exchanges";

// 거래소 API 거래 내역 동기화 (OKX는 lib/ledger/okx-sync.ts).

export interface XapiSyncResult {
  added: number;
  unknownTypes: string[];
  warnings: string[];
}

export const HISTORY_SUPPORTED = new Set<XapiSource["exchange"]>(["bybit", "coinbase", "bitget", "gate", "mexc"]);

const DAY = 86_400_000;
const HISTORY_DAYS = 730; // 바이비트 거래 로그 보관 기간 (2년)

type BybitPage<T> = { retCode: number; retMsg: string; result: { list?: T[]; rows?: T[]; nextPageCursor?: string } };

// 기간을 window 단위로 잘라, 각 구간을 커서로 끝까지 읽는다.
async function bybitCollect<T>(
  c: Creds,
  path: string,
  params: Record<string, string>,
  from: number,
  to: number,
  windowMs: number,
  onWindow: () => void,
): Promise<T[]> {
  const out: T[] = [];
  for (let start = from; start < to; start += windowMs) {
    const end = Math.min(start + windowMs - 1, to);
    let cursor: string | undefined;
    do {
      const q = { ...params, startTime: String(start), endTime: String(end), limit: "50", ...(cursor ? { cursor } : {}) };
      const page = (await relay("bybit", await signBybit(c, path, q, Date.now()))) as BybitPage<T>;
      if (page.retCode !== 0) throw new Error(`바이비트: ${page.retMsg}`);
      out.push(...(page.result.list ?? page.result.rows ?? []));
      cursor = page.result.nextPageCursor || undefined;
    } while (cursor);
    onWindow();
  }
  return out;
}

async function syncBybit(source: XapiSource, onProgress: (msg: string) => void): Promise<XapiSyncResult> {
  const c = await xapiCreds(source);
  const stateKey = `${source.id}:history`;
  const now = Date.now();
  const last = Number((await db.syncState.get(stateKey))?.cursor ?? 0);
  // 마지막 동기화 하루 전부터 다시 읽는다 (경계 누락 방지, 결정적 ID로 중복 없음)
  const from = last ? last - DAY : now - HISTORY_DAYS * DAY;

  const total = Math.ceil((now - from) / (7 * DAY)) + 2 * Math.ceil((now - from) / (30 * DAY));
  let done = 0;
  const tick = () => onProgress(`바이비트 내역 조회 중 (${++done}/${total})`);

  const logs = await bybitCollect<BybitLog>(c, "/v5/account/transaction-log", { accountType: "UNIFIED" }, from, now, 7 * DAY, tick);
  const warnings: string[] = [];
  let deposits: BybitDeposit[] = [];
  let withdrawals: BybitWithdrawal[] = [];
  try {
    deposits = await bybitCollect<BybitDeposit>(c, "/v5/asset/deposit/query-record", {}, from, now, 30 * DAY, tick);
    withdrawals = await bybitCollect<BybitWithdrawal>(c, "/v5/asset/withdraw/query-record", { withdrawType: "2" }, from, now, 30 * DAY, tick);
  } catch (e) {
    warnings.push(`입출금 기록 조회 실패: ${e instanceof Error ? e.message : e}. 하위 계정 키이거나 권한이 부족할 수 있습니다.`);
  }

  const built = buildBybitEntries({ sourceId: source.id, logs, deposits, withdrawals });
  const existing = await db.ledger.bulkGet(built.entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(built.entries);
    await db.syncState.put({ key: stateKey, cursor: String(now), syncedAt: now });
  });
  warnings.push(
    ...built.warnings,
    "Convert·Earn·P2P 등 펀딩 계정의 일부 기록은 아직 가져오지 않습니다. 잔고 대조에서 차이가 나면 CSV로 보완하세요.",
  );
  return { added: existing.filter((x) => !x).length, unknownTypes: built.unknownTypes, warnings };
}

// 코인베이스: 계정(지갑)별 거래 내역을 최신순으로, 지난 동기화 하루 전까지 읽는다
async function syncCoinbase(source: XapiSource, onProgress: (msg: string) => void): Promise<XapiSyncResult> {
  const c = await xapiCreds(source);
  const key = await importCoinbaseKey(c.secret);
  const stateKey = `${source.id}:history`;
  const now = Date.now();
  const last = Number((await db.syncState.get(stateKey))?.cursor ?? 0);
  const from = last ? last - DAY : 0;

  onProgress("코인베이스 계정 목록 조회 중");
  const accounts = await listCoinbaseAccounts(c.apiKey, key);
  const txs: CoinbaseTx[] = [];
  for (const [i, a] of accounts.entries()) {
    onProgress(`코인베이스 내역 조회 중 (${i + 1}/${accounts.length} 계정)`);
    let after: string | undefined;
    for (;;) {
      const r = await coinbaseGet<{ data: CoinbaseTx[]; pagination?: { next_starting_after?: string | null } }>(c.apiKey, key, `/v2/accounts/${a.id}/transactions`, {
        limit: "100",
        order: "desc",
        ...(after ? { starting_after: after } : {}),
      });
      const fresh = r.data.filter((t) => Date.parse(t.created_at) >= from);
      txs.push(...fresh);
      after = r.pagination?.next_starting_after ?? undefined;
      if (!after || fresh.length < r.data.length) break;
    }
  }

  const built = buildCoinbaseEntries(source.id, txs);
  const existing = await db.ledger.bulkGet(built.entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(built.entries);
    await db.syncState.put({ key: stateKey, cursor: String(now), syncedAt: now });
  });
  const warnings = [...built.warnings];
  if (built.entries.some((e) => e.rawType === "Card/bank payment" || e.rawType === "Payout")) {
    warnings.push("카드·은행으로 직접 사고판 거래는 코인베이스가 표시한 결제 금액을 대가로 넣었습니다 (수수료 제외 금액일 수 있음).");
  }
  return { added: existing.filter((x) => !x).length, unknownTypes: built.unknownTypes, warnings };
}

// 비트겟: 기간을 30일 단위로 잘라 idLessThan 커서로 끝까지 읽는다
async function bitgetCollect<T>(c: Creds, path: string, from: number, to: number, idOf: (r: T) => string, limit: number, onWindow: () => void): Promise<T[]> {
  const out: T[] = [];
  for (let start = from; start < to; start += 30 * DAY) {
    const end = Math.min(start + 30 * DAY, to);
    let cursor: string | undefined;
    for (;;) {
      const q: Record<string, string> = { startTime: String(start), endTime: String(end), limit: String(limit), ...(cursor ? { idLessThan: cursor } : {}) };
      const page = (await relay("bitget", await signBitget(c, path, q, Date.now()))) as { code: string; msg: string; data: T[] };
      if (page.code !== "00000") throw new Error(`비트겟: ${page.msg}`);
      out.push(...page.data);
      const next = page.data.length ? idOf(page.data[page.data.length - 1]) : undefined;
      if (page.data.length < limit || !next || next === cursor) break;
      cursor = next;
    }
    onWindow();
  }
  return out;
}

async function syncBitget(source: XapiSource, onProgress: (msg: string) => void): Promise<XapiSyncResult> {
  const c = await xapiCreds(source);
  const stateKey = `${source.id}:history`;
  const now = Date.now();
  const last = Number((await db.syncState.get(stateKey))?.cursor ?? 0);
  const from = last ? last - DAY : now - 365 * DAY;
  const windows = Math.ceil((now - from) / (30 * DAY));
  let done = 0;
  const tick = () => onProgress(`비트겟 내역 조회 중 (${++done}/${windows * 3})`);

  const bills = await bitgetCollect<BitgetBill>(c, "/api/v2/spot/account/bills", from, now, (r) => r.billId, 500, tick);
  const warnings: string[] = [];
  let deposits: BitgetTransfer[] = [];
  let withdrawals: BitgetTransfer[] = [];
  try {
    deposits = await bitgetCollect<BitgetTransfer>(c, "/api/v2/spot/wallet/deposit-records", from, now, (r) => r.orderId, 100, tick);
    withdrawals = await bitgetCollect<BitgetTransfer>(c, "/api/v2/spot/wallet/withdrawal-records", from, now, (r) => r.orderId, 100, tick);
  } catch (e) {
    warnings.push(`입출금 기록 조회 실패 (블록체인 거래 해시 없이 기록): ${e instanceof Error ? e.message : e}`);
  }

  const built = buildBitgetEntries({ sourceId: source.id, bills, deposits, withdrawals });
  const existing = await db.ledger.bulkGet(built.entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(built.entries);
    await db.syncState.put({ key: stateKey, cursor: String(now), syncedAt: now });
  });
  warnings.push("현물 계정 내역만 가져옵니다. 선물·마진·Earn 계정으로 옮긴 금액은 '기타'로 기록됩니다.");
  if (!last) warnings.push("첫 동기화는 최근 1년 내역을 가져옵니다. 그 이전 거래는 비트겟 거래 명세서(CSV)로 보완하세요.");
  return { added: existing.filter((x) => !x).length, unknownTypes: built.unknownTypes, warnings };
}

// 게이트: 기간을 30일 단위로 잘라(초 단위 시각) 페이지를 끝까지 읽는다
async function gateCollect<T>(c: Creds, path: string, from: number, to: number, paging: "page" | "offset", limit: number, onWindow: () => void): Promise<T[]> {
  const out: T[] = [];
  for (let start = from; start < to; start += 30 * DAY) {
    const end = Math.min(start + 30 * DAY, to);
    for (let page = 1; ; page++) {
      const q: Record<string, string> = {
        from: String(Math.floor(start / 1000)),
        to: String(Math.floor(end / 1000)),
        limit: String(limit),
        ...(paging === "page" ? { page: String(page) } : { offset: String((page - 1) * limit) }),
      };
      const rows = (await relay("gate", await signGate(c, path, q, Date.now()))) as T[];
      out.push(...rows);
      if (rows.length < limit) break;
    }
    onWindow();
  }
  return out;
}

async function syncGate(source: XapiSource, onProgress: (msg: string) => void): Promise<XapiSyncResult> {
  const c = await xapiCreds(source);
  const stateKey = `${source.id}:history`;
  const now = Date.now();
  const last = Number((await db.syncState.get(stateKey))?.cursor ?? 0);
  const from = last ? last - DAY : now - 365 * DAY;
  const windows = Math.ceil((now - from) / (30 * DAY));
  let done = 0;
  const tick = () => onProgress(`게이트 내역 조회 중 (${++done}/${windows * 3})`);

  const book = await gateCollect<GateBook>(c, "/api/v4/spot/account_book", from, now, "page", 1000, tick);
  const warnings: string[] = [];
  let deposits: GateTransfer[] = [];
  let withdrawals: GateTransfer[] = [];
  try {
    deposits = await gateCollect<GateTransfer>(c, "/api/v4/wallet/deposits", from, now, "offset", 500, tick);
    withdrawals = await gateCollect<GateTransfer>(c, "/api/v4/wallet/withdrawals", from, now, "offset", 500, tick);
  } catch (e) {
    warnings.push(`입출금 기록 조회 실패 (블록체인 거래 해시 없이 기록): ${e instanceof Error ? e.message : e}`);
  }

  const built = buildGateEntries({ sourceId: source.id, book, deposits, withdrawals });
  const existing = await db.ledger.bulkGet(built.entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(built.entries);
    await db.syncState.put({ key: stateKey, cursor: String(now), syncedAt: now });
  });
  warnings.push("현물 계정 장부만 가져옵니다. 선물·마진·Earn 계정으로 옮긴 금액은 '기타'로 기록됩니다.");
  if (!last) warnings.push("첫 동기화는 최근 1년 내역을 가져옵니다. 그 이전 거래는 게이트 거래 명세서(CSV)로 보완하세요.");
  return { added: existing.filter((x) => !x).length, unknownTypes: built.unknownTypes, warnings };
}

async function mexcGet<T>(c: Creds, path: string, params: Record<string, string>): Promise<T> {
  await new Promise((r) => setTimeout(r, 150)); // 체결 조회는 가중치가 커서 간격을 둔다
  return (await relay("mexc", await signMexc(c, path, params, Date.now()))) as T;
}

async function syncMexc(source: XapiSource, onProgress: (msg: string) => void): Promise<XapiSyncResult> {
  const c = await xapiCreds(source);
  const stateKey = `${source.id}:history`;
  const now = Date.now();
  const last = Number((await db.syncState.get(stateKey))?.cursor ?? 0);
  const warnings: string[] = [];

  // 입출금: 최근 90일까지, 7일 단위
  const depFrom = Math.max(last ? last - DAY : 0, now - 89 * DAY);
  const deposits: MexcDeposit[] = [];
  const withdrawals: MexcWithdrawal[] = [];
  for (let start = depFrom; start < now; start += 7 * DAY) {
    onProgress("MEXC 입출금 조회 중");
    const q = { startTime: String(start), endTime: String(Math.min(start + 7 * DAY, now)), limit: "1000" };
    const dep = await mexcGet<MexcDeposit[] | { msg?: string }>(c, "/api/v3/capital/deposit/hisrec", q);
    const wd = await mexcGet<MexcWithdrawal[] | { msg?: string }>(c, "/api/v3/capital/withdraw/history", q);
    if (!Array.isArray(dep)) throw new Error(`MEXC 입금 조회 실패: ${dep.msg ?? "알 수 없는 응답"}`);
    if (!Array.isArray(wd)) throw new Error(`MEXC 출금 조회 실패: ${wd.msg ?? "알 수 없는 응답"}`);
    deposits.push(...dep);
    withdrawals.push(...wd);
  }

  // 조회할 코인: 현재 보유 + 입출금 + 이전에 원장에 기록된 코인
  const coins = new Set<string>();
  const account = await mexcGet<{ balances: { asset: string; free: string; locked: string }[] }>(c, "/api/v3/account", {});
  for (const b of account.balances) if (!new Decimal(b.free || 0).plus(b.locked || 0).isZero()) coins.add(b.asset.toUpperCase());
  for (const t of [...deposits, ...withdrawals]) coins.add(t.coin.toUpperCase());
  for (const e of await db.ledger.where("sourceId").equals(source.id).toArray()) coins.add(e.asset);

  // 체결: 최근 1개월까지, 거래쌍별. 없는 거래쌍은 오류가 나므로 건너뛴다.
  const tradeFrom = Math.max(last ? last - DAY : 0, now - 29 * DAY);
  const trades: { base: string; quote: string; trade: MexcTrade }[] = [];
  const pairs = [...coins].flatMap((coin) => MEXC_QUOTES.filter((q) => q !== coin).map((quote) => [coin, quote] as const));
  for (const [i, [coin, quote]] of pairs.entries()) {
    onProgress(`MEXC 체결 조회 중 (${i + 1}/${pairs.length} 거래쌍)`);
    let start = tradeFrom;
    for (;;) {
      let page: MexcTrade[];
      try {
        page = await mexcGet<MexcTrade[]>(c, "/api/v3/myTrades", { symbol: `${coin}${quote}`, startTime: String(start), endTime: String(now), limit: "100" });
      } catch {
        break; // 존재하지 않는 거래쌍
      }
      if (!Array.isArray(page)) break; // 오류 응답 ({code, msg})
      trades.push(...page.map((trade) => ({ base: coin, quote, trade })));
      if (page.length < 100) break;
      start = Math.max(...page.map((t) => t.time)) + 1;
    }
  }

  const built = buildMexcEntries({ sourceId: source.id, trades, deposits, withdrawals });
  const existing = await db.ledger.bulkGet(built.entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(built.entries);
    await db.syncState.put({ key: stateKey, cursor: String(now), syncedAt: now });
  });
  if (last && now - last > 29 * DAY) warnings.push("마지막 동기화 후 1개월이 지나 그 사이 일부 체결을 API로 받을 수 없습니다. 빠진 기간은 MEXC 거래 명세서(CSV)로 보완하세요.");
  warnings.push(
    "MEXC API는 체결을 최근 1개월, 입출금을 최근 90일만 주고 USDT·USDC 거래쌍만 조회합니다. 한 달에 한 번 이상 동기화하고, 그 밖의 거래는 CSV로 보완하세요.",
  );
  return { added: existing.filter((x) => !x).length, unknownTypes: [], warnings };
}

export async function syncXapiHistory(source: XapiSource, onProgress: (msg: string) => void = () => {}): Promise<XapiSyncResult> {
  if (source.exchange === "bybit") return syncBybit(source, onProgress);
  if (source.exchange === "coinbase") return syncCoinbase(source, onProgress);
  if (source.exchange === "bitget") return syncBitget(source, onProgress);
  if (source.exchange === "gate") return syncGate(source, onProgress);
  if (source.exchange === "mexc") return syncMexc(source, onProgress);
  throw new Error("이 거래소의 거래 내역 API는 아직 지원하지 않습니다");
}
