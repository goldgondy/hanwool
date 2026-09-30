import { db, type XapiSource } from "@/lib/db";
import { buildBybitEntries, type BybitDeposit, type BybitLog, type BybitWithdrawal } from "@/lib/ledger/bybit-build";
import { relay, signBybit, xapiCreds, type Creds } from "@/lib/sources/exchanges";

// 거래소 API 거래 내역 동기화. 현재 바이비트 지원 (나머지 거래소는 순차 추가).

export interface XapiSyncResult {
  added: number;
  unknownTypes: string[];
  warnings: string[];
}

export const HISTORY_SUPPORTED = new Set<XapiSource["exchange"]>(["bybit"]);

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

export async function syncXapiHistory(source: XapiSource, onProgress: (msg: string) => void = () => {}): Promise<XapiSyncResult> {
  if (source.exchange === "bybit") return syncBybit(source, onProgress);
  throw new Error("이 거래소의 거래 내역 API는 아직 지원하지 않습니다");
}
