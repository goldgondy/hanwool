import { db, type LedgerEntry, type XapiSource } from "@/lib/db";
import {
  buildBitgetEarnEntries,
  buildBitgetEntries,
  buildBitgetFuturesEntries,
  type BitgetBill,
  type BitgetMixBill,
  type BitgetSavingsRecord,
  type BitgetTransfer,
} from "@/lib/ledger/bitget-build";
import { relay, signBitget, xapiCreds, type Creds } from "@/lib/sources/exchanges";
import type { XapiSyncResult } from "@/lib/ledger/xapi-sync";

const DAY = 86_400_000;
export const BITGET_PRODUCT_TYPES = ["USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"];

type Page<T> = { code: string; msg: string; data: T };

// 기간을 30일 단위로 잘라 idLessThan 커서로 끝까지 읽는다. 응답 모양이 엔드포인트마다 달라 rows/next를 받는다.
async function collect<D, T>(
  c: Creds,
  path: string,
  params: Record<string, string>,
  from: number,
  to: number,
  limit: number,
  rows: (d: D) => T[],
  next: (d: D, rows: T[]) => string | undefined,
  onWindow: () => void,
): Promise<T[]> {
  const out: T[] = [];
  for (let start = from; start < to; start += 30 * DAY) {
    const end = Math.min(start + 30 * DAY, to);
    let cursor: string | undefined;
    for (;;) {
      const q = { ...params, startTime: String(start), endTime: String(end), limit: String(limit), ...(cursor ? { idLessThan: cursor } : {}) };
      const page = (await relay("bitget", await signBitget(c, path, q, Date.now()))) as Page<D>;
      if (page.code !== "00000") throw new Error(`비트겟: ${page.msg}`);
      const list = rows(page.data) ?? [];
      out.push(...list);
      const n = list.length ? next(page.data, list) : undefined;
      if (list.length < limit || !n || n === cursor) break;
      cursor = n;
    }
    onWindow();
  }
  return out;
}

export async function syncBitget(source: XapiSource, onProgress: (msg: string) => void): Promise<XapiSyncResult> {
  const c = await xapiCreds(source);
  const stateKey = `${source.id}:history`;
  const now = Date.now();
  const last = Number((await db.syncState.get(stateKey))?.cursor ?? 0);
  const from = last ? last - DAY : now - 365 * DAY;
  const windows = Math.ceil((now - from) / (30 * DAY));
  let done = 0;
  const total = windows * (3 + BITGET_PRODUCT_TYPES.length + 2);
  const tick = () => onProgress(`비트겟 내역 조회 중 (${++done}/${total})`);
  const warnings: string[] = [];
  const unknown = new Set<string>();

  // 현물
  const bills = await collect<BitgetBill[], BitgetBill>(c, "/api/v2/spot/account/bills", {}, from, now, 500, (d) => d, (_, r) => r[r.length - 1].billId, tick);
  let deposits: BitgetTransfer[] = [];
  let withdrawals: BitgetTransfer[] = [];
  try {
    const rows = (d: BitgetTransfer[]) => d;
    const next = (_: unknown, r: BitgetTransfer[]) => r[r.length - 1].orderId;
    deposits = await collect(c, "/api/v2/spot/wallet/deposit-records", {}, from, now, 100, rows, next, tick);
    withdrawals = await collect(c, "/api/v2/spot/wallet/withdrawal-records", {}, from, now, 100, rows, next, tick);
  } catch (e) {
    warnings.push(`입출금 기록 조회 실패 (블록체인 거래 해시 없이 기록): ${e instanceof Error ? e.message : e}`);
  }
  const spot = buildBitgetEntries({ sourceId: source.id, bills, deposits, withdrawals });
  spot.unknownTypes.forEach((t) => unknown.add(t));
  const entries: LedgerEntry[] = [...spot.entries];

  // 선물 (USDT·USDC·코인 마진)
  let derivatives = 0;
  for (const productType of BITGET_PRODUCT_TYPES) {
    try {
      const mix = await collect<{ bills: BitgetMixBill[]; endId?: string }, BitgetMixBill>(
        c,
        "/api/v2/mix/account/bill",
        { productType },
        from,
        now,
        100,
        (d) => d.bills,
        (d) => d.endId,
        tick,
      );
      const built = buildBitgetFuturesEntries(source.id, mix);
      entries.push(...built.entries);
      built.unknownTypes.forEach((t) => unknown.add(t));
      derivatives += built.derivatives;
    } catch (e) {
      warnings.push(`선물(${productType}) 내역 조회 실패: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Earn 이자 (자유·고정 예치)
  const records: BitgetSavingsRecord[] = [];
  for (const periodType of ["flexible", "fixed"]) {
    try {
      records.push(
        ...(await collect<{ resultList: BitgetSavingsRecord[]; endId?: string }, BitgetSavingsRecord>(
          c,
          "/api/v2/earn/savings/records",
          { periodType },
          from,
          now,
          100,
          (d) => d.resultList,
          (d) => d.endId,
          tick,
        )),
      );
    } catch (e) {
      warnings.push(`Earn(${periodType}) 내역 조회 실패: ${e instanceof Error ? e.message : e}`);
    }
  }
  entries.push(...buildBitgetEarnEntries(source.id, records, spot.entries));

  const existing = await db.ledger.bulkGet(entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(entries);
    await db.syncState.put({ key: stateKey, cursor: String(now), syncedAt: now });
  });
  if (derivatives > 0) warnings.push(`선물 손익·펀딩비·수수료 기록 ${derivatives}건은 과세 여부 검토가 필요해 미분류로 두었습니다.`);
  warnings.push("현물·선물·Earn을 한 계좌로 보고 그 사이 이동은 건너뜁니다. 마진·카피 트레이딩·P2P 계정은 아직 포함하지 않습니다.");
  if (!last) warnings.push("첫 동기화는 최근 1년 내역을 가져옵니다. 그 이전 거래는 비트겟 거래 명세서(CSV)로 보완하세요.");
  return { added: existing.filter((x) => !x).length, unknownTypes: [...unknown], warnings };
}
