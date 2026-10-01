import { db, type BinanceSource, type LedgerEntry } from "@/lib/db";
import {
  buildBinanceConverts,
  buildBinanceDividends,
  buildBinanceDust,
  buildBinanceEarn,
  buildBinanceIncome,
  buildBinanceP2P,
  buildBinancePay,
  buildBinanceTrades,
  buildBinanceTransfers,
  type BinanceConvert,
  type BinanceDeposit,
  type BinanceDividend,
  type BinanceDust,
  type BinanceEarnReward,
  type BinanceIncome,
  type BinanceP2P,
  type BinancePay,
  type BinanceTrade,
  type BinanceWithdrawal,
} from "@/lib/ledger/binance-build";
import { fetchBinanceBalances, makeCall, type Call } from "@/lib/sources/binance";
import { decrypt } from "@/lib/vault";
import type { XapiSyncResult } from "@/lib/ledger/xapi-sync";

const DAY = 86_400_000;
const BINANCE_START = Date.UTC(2017, 6, 1);
// 체결을 찾아볼 결제 통화. 바이낸스는 '내가 거래한 거래쌍' 목록을 주지 않아 코인 × 결제 통화로 찾아본다.
const QUOTES = ["USDT", "FDUSD", "USDC", "BTC", "ETH", "BNB"];

interface BinanceState {
  lastTime: number; // 마지막 동기화 시각
  trades: Record<string, number>; // 거래쌍 → 마지막으로 받은 체결 ID
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 바이낸스 요청 한도: 일반 조회는 간격 250ms, Convert·Pay는 계정당 1분 60회라 1.1초
function paced(call: Call): Call & { slow: Call } {
  let next = 0;
  const wait = async (ms: number) => {
    const now = Date.now();
    const slot = Math.max(now, next);
    next = slot + ms;
    if (slot > now) await sleep(slot - now);
  };
  const fast = (async <T,>(path: string, params?: Record<string, string>) => {
    await wait(250);
    return call<T>(path, params);
  }) as Call & { slow: Call };
  fast.slow = async <T,>(path: string, params?: Record<string, string>) => {
    await wait(1100);
    return call<T>(path, params);
  };
  return fast;
}

// [from, to)를 size 단위 구간으로 나눠 차례로 처리한다
async function eachWindow(from: number, to: number, size: number, fn: (start: number, end: number) => Promise<void>) {
  for (let start = from; start < to; start += size) await fn(start, Math.min(start + size - 1, to));
}

export async function syncBinanceHistory(source: BinanceSource, onProgress: (msg: string) => void = () => {}): Promise<XapiSyncResult> {
  const call = paced(makeCall(source.apiKey, await decrypt(source.encSecret)));
  const stateKey = `${source.id}:history`;
  const saved = await db.syncState.get(stateKey);
  const state: BinanceState = saved ? JSON.parse(saved.cursor) : { lastTime: 0, trades: {} };
  const now = Date.now();
  const from = state.lastTime ? state.lastTime - DAY : BINANCE_START;
  const warnings: string[] = [];
  const entries: LedgerEntry[] = [];
  const coins = new Set<string>();
  const section = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      warnings.push(`${name} 조회 실패: ${e instanceof Error ? e.message : e}`);
    }
  };

  // 1) 입출금 (90일 구간)
  const deposits: BinanceDeposit[] = [];
  const withdrawals: BinanceWithdrawal[] = [];
  await eachWindow(from, now, 90 * DAY, async (start, end) => {
    onProgress(`바이낸스 입출금 조회 중 (${new Date(start).toISOString().slice(0, 7)})`);
    const q = { startTime: String(start), endTime: String(end), limit: "1000" };
    deposits.push(...(await call<BinanceDeposit[]>("/sapi/v1/capital/deposit/hisrec", q)));
    withdrawals.push(...(await call<BinanceWithdrawal[]>("/sapi/v1/capital/withdraw/history", q)));
  });
  entries.push(...buildBinanceTransfers(source.id, deposits, withdrawals));

  // 2) Convert (30일 구간, 결과가 더 있으면 구간을 반으로 나눈다)
  await section("Convert 내역", async () => {
    const rows: BinanceConvert[] = [];
    const fetchRange = async (start: number, end: number): Promise<void> => {
      const r = await call.slow<{ list?: BinanceConvert[]; moreData?: boolean }>("/sapi/v1/convert/tradeFlow", { startTime: String(start), endTime: String(end), limit: "1000" });
      if (r.moreData && end - start > 60_000) {
        const mid = Math.floor((start + end) / 2);
        await fetchRange(start, mid);
        await fetchRange(mid + 1, end);
      } else rows.push(...(r.list ?? []));
    };
    await eachWindow(Math.max(from, Date.UTC(2020, 0, 1)), now, 30 * DAY, async (start, end) => {
      onProgress(`바이낸스 Convert 조회 중 (${new Date(start).toISOString().slice(0, 7)})`);
      await fetchRange(start, end);
    });
    entries.push(...buildBinanceConverts(source.id, rows));
  });

  // 3) 소액 BNB 전환 (90일 구간, 2020-12 이후만 제공)
  await section("소액 전환 내역", async () => {
    const logs: BinanceDust[] = [];
    await eachWindow(Math.max(from, Date.UTC(2020, 11, 1)), now, 90 * DAY, async (start, end) => {
      onProgress("바이낸스 소액 전환 조회 중");
      const r = await call<{ userAssetDribblets?: BinanceDust[] }>("/sapi/v1/asset/dribblet", { startTime: String(start), endTime: String(end) });
      logs.push(...(r.userAssetDribblets ?? []));
    });
    entries.push(...buildBinanceDust(source.id, logs));
  });

  // 4) 에어드랍·배당·보상 (180일 구간, 한 번에 500건까지라 넘치면 반으로 나눈다)
  let dividendEntries: LedgerEntry[] = [];
  await section("에어드랍·보상 내역", async () => {
    const rows: BinanceDividend[] = [];
    const fetchRange = async (start: number, end: number): Promise<void> => {
      const r = await call<{ rows?: BinanceDividend[] }>("/sapi/v1/asset/assetDividend", { startTime: String(start), endTime: String(end), limit: "500" });
      const list = r.rows ?? [];
      if (list.length >= 500 && end - start > 60_000) {
        const mid = Math.floor((start + end) / 2);
        await fetchRange(start, mid);
        await fetchRange(mid + 1, end);
      } else rows.push(...list);
    };
    await eachWindow(from, now, 180 * DAY, async (start, end) => {
      onProgress(`바이낸스 에어드랍·보상 조회 중 (${new Date(start).toISOString().slice(0, 7)})`);
      await fetchRange(start, end);
    });
    dividendEntries = buildBinanceDividends(source.id, rows);
    entries.push(...dividendEntries);
  });

  // 5) Simple Earn 이자 (90일 구간)
  await section("Simple Earn 이자 내역", async () => {
    const rewards: BinanceEarnReward[] = [];
    await eachWindow(Math.max(from, Date.UTC(2023, 0, 1)), now, 90 * DAY, async (start, end) => {
      onProgress(`바이낸스 Earn 이자 조회 중 (${new Date(start).toISOString().slice(0, 7)})`);
      const base = { startTime: String(start), endTime: String(end), size: "100" };
      for (const type of ["BONUS", "REALTIME", "REWARDS"]) {
        for (let current = 1; ; current++) {
          const r = await call<{ rows?: { asset: string; rewards: string; projectId?: string; type: string; time: number }[]; total?: number }>(
            "/sapi/v1/simple-earn/flexible/history/rewardsRecord",
            { ...base, type, current: String(current) },
          );
          const list = r.rows ?? [];
          for (const x of list) rewards.push({ asset: x.asset, amount: x.rewards, time: x.time, kind: "flexible", key: `f:${type}:${x.projectId ?? ""}:${x.asset}:${x.time}` });
          if (list.length < 100) break;
        }
      }
      for (let current = 1; ; current++) {
        const r = await call<{ rows?: { positionId: string | number; asset: string; amount: string; time: number }[] }>("/sapi/v1/simple-earn/locked/history/rewardsRecord", {
          ...base,
          current: String(current),
        });
        const list = r.rows ?? [];
        for (const x of list) rewards.push({ asset: x.asset, amount: x.amount, time: x.time, kind: "locked", key: `l:${x.positionId}:${x.asset}:${x.time}` });
        if (list.length < 100) break;
      }
    });
    entries.push(...buildBinanceEarn(source.id, rewards, dividendEntries));
  });

  // 6) 선물 손익 (최근 3개월만 제공, 7일 구간)
  let derivatives = 0;
  for (const [market, path, name] of [
    ["um", "/fapi/v1/income", "USDⓈ-M 선물"],
    ["cm", "/dapi/v1/income", "COIN-M 선물"],
  ] as const) {
    await section(`${name} 내역`, async () => {
      const rows: BinanceIncome[] = [];
      await eachWindow(Math.max(from, now - 89 * DAY), now, 7 * DAY, async (start, end) => {
        onProgress(`바이낸스 ${name} 조회 중`);
        let s = start;
        for (;;) {
          const page = await call<BinanceIncome[]>(path, { startTime: String(s), endTime: String(end), limit: "1000" });
          rows.push(...page);
          if (page.length < 1000) break;
          s = Math.max(...page.map((p) => p.time)) + 1;
        }
      });
      const built = buildBinanceIncome(source.id, market, rows);
      entries.push(...built.entries);
      derivatives += built.derivatives;
    });
  }

  // 7) Binance Pay (최근 18개월까지, 30일 구간)
  await section("Binance Pay 내역", async () => {
    const rows: BinancePay[] = [];
    await eachWindow(Math.max(from, now - 540 * DAY), now, 30 * DAY, async (start, end) => {
      onProgress("바이낸스 Pay 조회 중");
      const r = await call.slow<{ data?: BinancePay[] }>("/sapi/v1/pay/transactions", { startTime: String(start), endTime: String(end), limit: "100" });
      const list = r.data ?? [];
      if (list.length >= 100) warnings.push(`Binance Pay 기록이 한 달에 100건을 넘어 일부가 빠졌을 수 있습니다 (${new Date(start).toISOString().slice(0, 7)}).`);
      rows.push(...list);
    });
    entries.push(...buildBinancePay(source.id, rows));
  });

  // 8) P2P (30일 구간)
  await section("P2P 내역", async () => {
    const rows: BinanceP2P[] = [];
    await eachWindow(Math.max(from, Date.UTC(2021, 0, 1)), now, 30 * DAY, async (start, end) => {
      onProgress(`바이낸스 P2P 조회 중 (${new Date(start).toISOString().slice(0, 7)})`);
      for (const tradeType of ["BUY", "SELL"]) {
        for (let page = 1; ; page++) {
          const r = await call<{ data?: BinanceP2P[] }>("/sapi/v1/c2c/orderMatch/listUserOrderHistory", {
            tradeType,
            startTimestamp: String(start),
            endTimestamp: String(end),
            page: String(page),
            rows: "100",
          });
          const list = r.data ?? [];
          rows.push(...list);
          if (list.length < 100) break;
        }
      }
    });
    entries.push(...buildBinanceP2P(source.id, rows));
  });

  // 9) 현물 체결: 거래쌍별로 마지막 체결 ID 다음부터
  // 찾아볼 코인 = 현재 잔고 + 이번에 받은 기록 + 원장(같은 계정과 연결된 CSV 포함)에 나온 코인
  const balances = await fetchBinanceBalances(source, () => {});
  for (const b of balances) coins.add(b.asset.toUpperCase()); // 유연 Earn의 LD 표기는 잔고 조회에서 이미 걸러진다
  for (const e of entries) if (!e.assetKey.startsWith("fiat:")) coins.add(e.asset);
  const linked = (await db.sources.toArray()).filter((s) => s.kind === "csv" && s.linkedSourceId === source.id).map((s) => s.id);
  for (const id of [source.id, ...linked]) for (const e of await db.ledger.where("sourceId").equals(id).toArray()) if (!e.assetKey.startsWith("fiat:")) coins.add(e.asset);

  const pairs = new Map<string, { base: string; quote: string }>();
  for (const coin of coins) for (const quote of QUOTES) if (coin !== quote) pairs.set(`${coin}${quote}`, { base: coin, quote });
  // 이전에 체결이 있던 거래쌍은 코인 목록과 관계없이 이어 받는다
  for (const symbol of Object.keys(state.trades)) {
    const quote = QUOTES.find((q) => symbol.endsWith(q) && symbol.length > q.length);
    if (quote && !pairs.has(symbol)) pairs.set(symbol, { base: symbol.slice(0, -quote.length), quote });
  }
  const trades: { base: string; quote: string; trade: BinanceTrade }[] = [];
  const lastIds = { ...state.trades };
  let probed = 0;
  for (const [symbol, pair] of pairs) {
    onProgress(`바이낸스 체결 조회 중 (${++probed}/${pairs.size} 거래쌍)`);
    let fromId = (lastIds[symbol] ?? -1) + 1;
    for (;;) {
      let page: BinanceTrade[];
      try {
        page = await call<BinanceTrade[]>("/api/v3/myTrades", { symbol, fromId: String(fromId), limit: "1000" });
      } catch (e) {
        if ((e as { code?: number }).code === -1121) break; // 존재하지 않는 거래쌍
        throw e;
      }
      for (const trade of page) trades.push({ ...pair, trade });
      if (page.length) lastIds[symbol] = Math.max(...page.map((t) => t.id));
      if (page.length < 1000) break;
      fromId = lastIds[symbol] + 1;
    }
  }
  entries.push(...buildBinanceTrades(source.id, trades));

  const existing = await db.ledger.bulkGet(entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(entries);
    await db.syncState.put({ key: stateKey, cursor: JSON.stringify({ lastTime: now, trades: lastIds } satisfies BinanceState), syncedAt: now });
  });

  if (derivatives > 0) warnings.push(`선물 손익·펀딩비·수수료 기록 ${derivatives}건은 과세 여부 검토가 필요해 미분류로 두었습니다.`);
  if (state.lastTime && now - state.lastTime > 89 * DAY) warnings.push("마지막 동기화 후 3개월이 지나 그 사이 선물 내역 일부를 API로 받을 수 없습니다. 바이낸스 거래 명세서(CSV)로 보완하세요.");
  warnings.push(
    "바이낸스는 '거래한 거래쌍' 목록을 주지 않아, 보유·입출금 기록에 나온 코인의 USDT·FDUSD·USDC·BTC·ETH·BNB 거래쌍만 찾아봅니다. 사서 모두 판 코인은 빠질 수 있으니 잔고 대조에서 차이가 나면 거래 명세서(CSV)로 보완하세요.",
    "마진·법정화폐 카드 결제·듀얼 인베스트먼트·자동 투자 기록은 아직 가져오지 않습니다.",
  );
  return { added: existing.filter((x) => !x).length, unknownTypes: [], warnings };
}
