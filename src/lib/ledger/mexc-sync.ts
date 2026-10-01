import Decimal from "@/lib/decimal";
import { db, type XapiSource } from "@/lib/db";
import {
  buildMexcEntries,
  buildMexcFuturesEntries,
  MEXC_QUOTES,
  type MexcDeposit,
  type MexcPosition,
  type MexcTrade,
  type MexcWithdrawal,
} from "@/lib/ledger/mexc-build";
import { relay, signMexc, signMexcFutures, xapiCreds, type Creds } from "@/lib/sources/exchanges";
import type { XapiSyncResult } from "@/lib/ledger/xapi-sync";

const DAY = 86_400_000;

async function mexcGet<T>(c: Creds, path: string, params: Record<string, string>): Promise<T> {
  await new Promise((r) => setTimeout(r, 150)); // 체결 조회는 가중치가 커서 간격을 둔다
  return (await relay("mexc", await signMexc(c, path, params, Date.now()))) as T;
}

// 선물 종료 포지션: 최신순 페이지를 from 이전 기록이 나올 때까지
async function futuresPositions(c: Creds, from: number, onProgress: (msg: string) => void): Promise<MexcPosition[]> {
  const out: MexcPosition[] = [];
  for (let page = 1; page <= 500; page++) {
    onProgress(`MEXC 선물 내역 조회 중 (${page}쪽)`);
    const r = (await relay("mexcfut", await signMexcFutures(c, "/api/v1/private/position/list/history_positions", { page_num: String(page), page_size: "100" }, Date.now()))) as {
      success: boolean;
      message?: string;
      data: MexcPosition[] | { resultList?: MexcPosition[] };
    };
    if (!r.success) throw new Error(r.message ?? "조회 실패");
    const rows = Array.isArray(r.data) ? r.data : (r.data.resultList ?? []);
    const fresh = rows.filter((p) => Number(p.updateTime) >= from);
    out.push(...fresh);
    if (rows.length < 100 || fresh.length < rows.length) break;
  }
  return out;
}

export async function syncMexc(source: XapiSource, onProgress: (msg: string) => void): Promise<XapiSyncResult> {
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
  const entries = buildMexcEntries({ sourceId: source.id, trades, deposits, withdrawals }).entries;

  // 선물: 종료된 포지션의 실현 손익 (수수료 차감 후). 현물 ↔ 선물 이동은 현물 기록에 없고 잔고 대조에서 두 계정을 합친다.
  let futures = 0;
  try {
    const positions = await futuresPositions(c, last ? last - DAY : 0, onProgress);
    const fut = buildMexcFuturesEntries(source.id, positions);
    entries.push(...fut);
    futures = fut.length;
  } catch (e) {
    warnings.push(`선물 내역 조회 실패: ${e instanceof Error ? e.message : e}`);
  }

  const existing = await db.ledger.bulkGet(entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(entries);
    await db.syncState.put({ key: stateKey, cursor: String(now), syncedAt: now });
  });
  if (futures > 0) warnings.push(`선물 포지션 손익 ${futures}건은 과세 여부 검토가 필요해 미분류로 두었습니다.`);
  if (last && now - last > 29 * DAY) warnings.push("마지막 동기화 후 1개월이 지나 그 사이 일부 체결을 API로 받을 수 없습니다. 빠진 기간은 MEXC 거래 명세서(CSV)로 보완하세요.");
  warnings.push(
    "MEXC API는 체결을 최근 1개월, 입출금을 최근 90일만 주고 USDT·USDC 거래쌍만 조회합니다. 한 달에 한 번 이상 동기화하고, 그 밖의 거래는 CSV로 보완하세요.",
    "MEXC는 Earn(예치) API가 없어 Earn에 넣은 금액과 이자는 가져오지 못합니다. 선물 포지션이 열려 있는 동안 낸 펀딩비는 포지션이 닫힌 뒤 반영됩니다.",
  );
  return { added: existing.filter((x) => !x).length, unknownTypes: [], warnings };
}
