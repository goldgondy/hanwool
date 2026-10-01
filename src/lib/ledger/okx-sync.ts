import { db, type OkxSource } from "@/lib/db";
import { buildOkxEntries, type OkxAssetBill, type OkxBill, type OkxDeposit, type OkxLending, type OkxWithdrawal } from "@/lib/ledger/okx-build";
import { okxCreds, signedGet, type Credentials } from "@/lib/sources/okx";
import type { XapiSyncResult } from "@/lib/ledger/xapi-sync";

const DAY = 86_400_000;
const RETENTION_DAYS = 90; // 거래 계정 내역 API 보관 기간 (bills-archive, 3개월)

// 최신 → 과거 순 페이지를 from 이전 기록이 나올 때까지 읽는다.
// cursor: 다음 페이지 요청에 쓸 값 (billId 또는 시각). 같은 커서가 반복되면 멈춘다.
async function collect<T extends { ts: string }>(
  c: Credentials,
  path: string,
  params: Record<string, string>,
  from: number,
  cursorOf: (row: T) => string,
  onPage: () => void,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (;;) {
    const q = new URLSearchParams({ ...params, limit: "100", ...(after ? { after } : {}) }).toString();
    const page = await signedGet<T[]>(c, `${path}?${q}`);
    onPage();
    const fresh = page.filter((r) => Number(r.ts) >= from);
    out.push(...fresh);
    const next = page.length ? cursorOf(page[page.length - 1]) : undefined;
    if (page.length < 100 || fresh.length < page.length || !next || next === after) return out;
    after = next;
  }
}

export async function syncOkxHistory(source: OkxSource, onProgress: (msg: string) => void = () => {}): Promise<XapiSyncResult> {
  const c = await okxCreds(source);
  const stateKey = `${source.id}:history`;
  const now = Date.now();
  const last = Number((await db.syncState.get(stateKey))?.cursor ?? 0);
  const from = last ? last - DAY : now - RETENTION_DAYS * DAY;
  const warnings: string[] = [];
  if (last && now - last > RETENTION_DAYS * DAY) {
    warnings.push(`마지막 동기화 후 3개월이 지나 그 사이 일부 거래 계정 내역을 API로 받을 수 없습니다. 빠진 기간은 OKX 거래 명세서(CSV)로 보완하세요.`);
  }

  let pages = 0;
  const tick = () => onProgress(`OKX 내역 조회 중 (${++pages}쪽)`);
  const begin = String(from);

  const bills = await collect<OkxBill>(c, "/api/v5/account/bills-archive", { begin }, from, (r) => r.billId, tick);
  let assetBills: OkxAssetBill[] = [];
  try {
    assetBills = await collect<OkxAssetBill>(c, "/api/v5/asset/bills-history", {}, from, (r) => r.ts, tick);
  } catch {
    // 이전 엔드포인트 (최근 1개월)
    assetBills = await collect<OkxAssetBill>(c, "/api/v5/asset/bills", {}, from, (r) => r.ts, tick);
  }
  const deposits = await collect<OkxDeposit>(c, "/api/v5/asset/deposit-history", {}, from, (r) => r.ts, tick);
  const withdrawals = await collect<OkxWithdrawal>(c, "/api/v5/asset/withdrawal-history", {}, from, (r) => r.ts, tick);
  let lending: OkxLending[] = [];
  try {
    lending = await collect<OkxLending>(c, "/api/v5/finance/savings/lending-history", {}, from, (r) => r.ts, tick);
  } catch (e) {
    warnings.push(`심플 언 이자 내역 조회 실패: ${e instanceof Error ? e.message : e}`);
  }

  const built = buildOkxEntries({ sourceId: source.id, bills, assetBills, deposits, withdrawals, lending });
  const existing = await db.ledger.bulkGet(built.entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(built.entries);
    await db.syncState.put({ key: stateKey, cursor: String(now), syncedAt: now });
  });
  if (!last) warnings.push("OKX API는 최근 3개월 내역만 줍니다. 그 이전 거래는 OKX 거래 명세서(CSV)로 보완하세요. 앞으로 3개월 안에 한 번씩 동기화하면 빠짐없이 쌓입니다.");
  return { added: existing.filter((x) => !x).length, unknownTypes: built.unknownTypes, warnings: [...built.warnings, ...warnings] };
}
