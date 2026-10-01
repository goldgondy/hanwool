import { db, type LedgerEntry, type XapiSource } from "@/lib/db";
import {
  buildGateEarnEntries,
  buildGateEntries,
  buildGateFuturesEntries,
  type GateBook,
  type GateFuturesBook,
  type GateInterestRecord,
  type GateTransfer,
} from "@/lib/ledger/gate-build";
import { relay, signGate, xapiCreds, type Creds } from "@/lib/sources/exchanges";
import type { XapiSyncResult } from "@/lib/ledger/xapi-sync";

const DAY = 86_400_000;

// 기간을 30일 단위로 잘라(초 단위 시각) 페이지를 끝까지 읽는다
async function collect<T>(c: Creds, path: string, from: number, to: number, paging: "page" | "offset", limit: number, onWindow: () => void): Promise<T[]> {
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

export async function syncGate(source: XapiSource, onProgress: (msg: string) => void): Promise<XapiSyncResult> {
  const c = await xapiCreds(source);
  const stateKey = `${source.id}:history`;
  const now = Date.now();
  const last = Number((await db.syncState.get(stateKey))?.cursor ?? 0);
  const from = last ? last - DAY : now - 365 * DAY;
  const windows = Math.ceil((now - from) / (30 * DAY));
  let done = 0;
  const tick = () => onProgress(`게이트 내역 조회 중 (${++done}/${windows * 5})`);
  const warnings: string[] = [];
  const unknown = new Set<string>();

  // 현물
  const book = await collect<GateBook>(c, "/api/v4/spot/account_book", from, now, "page", 1000, tick);
  let deposits: GateTransfer[] = [];
  let withdrawals: GateTransfer[] = [];
  try {
    deposits = await collect<GateTransfer>(c, "/api/v4/wallet/deposits", from, now, "offset", 500, tick);
    withdrawals = await collect<GateTransfer>(c, "/api/v4/wallet/withdrawals", from, now, "offset", 500, tick);
  } catch (e) {
    warnings.push(`입출금 기록 조회 실패 (블록체인 거래 해시 없이 기록): ${e instanceof Error ? e.message : e}`);
  }
  const spot = buildGateEntries({ sourceId: source.id, book, deposits, withdrawals });
  spot.unknownTypes.forEach((t) => unknown.add(t));
  const entries: LedgerEntry[] = [...spot.entries];

  // USDT 무기한 선물
  let derivatives = 0;
  try {
    const rows = await collect<GateFuturesBook>(c, "/api/v4/futures/usdt/account_book", from, now, "offset", 500, tick);
    const fut = buildGateFuturesEntries(source.id, "usdt", rows);
    entries.push(...fut.entries);
    fut.unknownTypes.forEach((t) => unknown.add(t));
    derivatives = fut.derivatives;
  } catch (e) {
    warnings.push(`선물 내역 조회 실패: ${e instanceof Error ? e.message : e}`);
  }

  // 심플 언 이자 (재투자분)
  try {
    const records = await collect<GateInterestRecord>(c, "/api/v4/earn/uni/interest_records", from, now, "page", 100, tick);
    entries.push(...buildGateEarnEntries(source.id, records));
  } catch (e) {
    warnings.push(`심플 언 이자 내역 조회 실패: ${e instanceof Error ? e.message : e}`);
  }

  const existing = await db.ledger.bulkGet(entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(entries);
    await db.syncState.put({ key: stateKey, cursor: String(now), syncedAt: now });
  });
  if (derivatives > 0) warnings.push(`선물 손익·펀딩비·수수료 기록 ${derivatives}건은 과세 여부 검토가 필요해 미분류로 두었습니다.`);
  warnings.push("현물·USDT 무기한 선물·심플 언을 한 계좌로 보고 그 사이 이동은 건너뜁니다. 마진·코인 마진 선물·카피 트레이딩·봇 계정은 아직 포함하지 않습니다.");
  if (!last) warnings.push("첫 동기화는 최근 1년 내역을 가져옵니다. 그 이전 거래는 게이트 거래 명세서(CSV)로 보완하세요.");
  return { added: existing.filter((x) => !x).length, unknownTypes: [...unknown], warnings };
}
