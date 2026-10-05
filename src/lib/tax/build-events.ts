import Decimal from "@/lib/decimal";
import { STABLECOINS } from "@/lib/assets";
import type { GroupView } from "@/lib/classify/classifier";
import type { Category } from "@/lib/classify/types";
import type { LedgerEntry } from "@/lib/db";
import type { TaxEvent } from "./engine";

// 분류된 원장 그룹 → 엔진 과세 이벤트 (docs/classification.md §3, §6)
// - 원가 풀은 심볼 단위로 계정·체인을 넘어 하나다. 래핑 토큰은 원래 코인의 풀을 쓴다 (래핑은 비과세).
// - 그룹 안에서 풀별 순수량으로 판단하므로, 내 계정으로 되돌아온 부분은 자연히 상쇄된다.
// - 법정화폐(원화 등)는 원가 풀이 아니다. 원화 매수·매도에서는 실제 지불·수령한 원화(수수료 포함)가 취득가·양도가다.

const POOL_ALIASES: Record<string, string> = { WETH: "ETH", WPOL: "POL", WMATIC: "POL", MATIC: "POL", WAVAX: "AVAX", WXPL: "XPL" };
export const poolOf = (symbol: string) => POOL_ALIASES[symbol.toUpperCase()] ?? symbol.toUpperCase();

// 의제취득가 기준 시점의 시세 조회 시각 (2026-12-31 24:00 KST 직전)
export const DEEMED_PRICE_TIME = Date.parse("2026-12-31T23:59:59+09:00");

export const priceKey = (pool: string, time: number) => `${pool}@${time}`;

const VALUED: Category[] = ["trade", "external_out", "external_in", "buy_fiat", "sell_fiat"];

const isFiatEntry = (e: LedgerEntry) => e.assetKey.startsWith("fiat:");
const fiatCode = (e: LedgerEntry) => e.assetKey.slice("fiat:".length);

// 가상자산 풀별 순수량 (수수료·법정화폐 제외)
function netsOf(g: GroupView) {
  const nets = new Map<string, Decimal>();
  for (const e of g.entries) {
    if (e.kind === "fee" || isFiatEntry(e)) continue;
    const p = poolOf(e.asset);
    nets.set(p, (nets.get(p) ?? new Decimal(0)).plus(e.amount));
  }
  return [...nets.entries()].filter(([, q]) => !q.isZero());
}

// 법정화폐 통화별 순수량 (법정화폐 수수료 포함)
function fiatNetsOf(g: GroupView) {
  const nets = new Map<string, Decimal>();
  for (const e of g.entries) {
    if (!isFiatEntry(e)) continue;
    nets.set(fiatCode(e), (nets.get(fiatCode(e)) ?? new Decimal(0)).plus(e.amount));
  }
  return [...nets.entries()].filter(([, q]) => !q.isZero());
}

// 원화 시세가 필요한 (풀 또는 통화, 시각) 목록. 원화(KRW)는 시세가 필요 없다.
export function priceQueries(groups: GroupView[]): { symbol: string; time: number }[] {
  const out = new Map<string, { symbol: string; time: number }>();
  for (const g of groups) {
    if (!VALUED.includes(g.classification.category)) continue;
    for (const [pool] of netsOf(g)) out.set(priceKey(pool, g.time), { symbol: pool, time: g.time });
    for (const [code] of fiatNetsOf(g)) if (code !== "KRW") out.set(priceKey(code, g.time), { symbol: code, time: g.time });
  }
  return [...out.values()];
}

export interface Unresolved {
  key: string;
  time: number;
  category: Category;
  reason: string;
  valueKrw: Decimal | null; // 시세로 추정한 금액 (알 수 없으면 null)
}

export interface BuildEventsResult {
  events: TaxEvent[];
  unresolved: Unresolved[]; // 사용자 검토가 남은 그룹 (계산에는 기본 정책대로 반영됨)
  unpriced: { key: string; pool: string; time: number }[]; // 시세가 없어 0원으로 계산된 항목
  pools: Set<string>;
}

const sum = (vs: (Decimal | null)[]) => vs.reduce<Decimal>((s, v) => (v ? s.plus(v) : s), new Decimal(0));

// 총액을 각 항목의 시가 비율로 나눈다 (시가를 모르면 균등하게)
function allocate(total: Decimal, own: (Decimal | null)[]) {
  const ownSum = sum(own);
  return own.every((v) => v) && ownSum.gt(0) ? own.map((v) => total.mul(v!).div(ownSum)) : own.map(() => total.div(own.length));
}

export function buildTaxEvents(groups: GroupView[], prices: Map<string, Decimal | null>): BuildEventsResult {
  const events: TaxEvent[] = [];
  const unresolved: Unresolved[] = [];
  const unpriced: BuildEventsResult["unpriced"] = [];
  const pools = new Set<string>();

  for (const g of groups) {
    const { category, status, decision, reason } = g.classification;
    if (category === "spam") continue;

    // 가상자산으로 낸 수수료는 모든 분류에서 동일하게 처리한다 (정책: 즉시 손실 인식).
    // 법정화폐 수수료는 원화 매수·매도의 취득가·양도가에 반영한다.
    for (const e of g.entries) {
      if (e.kind !== "fee" || isFiatEntry(e)) continue;
      const pool = poolOf(e.asset);
      pools.add(pool);
      events.push({ type: "fee", time: e.time, asset: pool, qty: new Decimal(e.amount).abs(), ref: e.id });
    }

    const nets = netsOf(g);
    nets.forEach(([p]) => pools.add(p));
    const priceOf = (sym: string) => prices.get(priceKey(sym, g.time)) ?? null;
    const valueOf = (pool: string, qty: Decimal) => {
      const p = priceOf(pool);
      return p ? qty.abs().mul(p) : null;
    };
    const ref = (pool: string) => `${g.key}:${pool}`;
    const acquire = (pool: string, qty: Decimal, cost: Decimal) =>
      events.push({ type: "acquire", time: g.time, asset: pool, qty: qty.abs(), costKrw: cost, ref: ref(pool) });
    const dispose = (pool: string, qty: Decimal, proceeds: Decimal) =>
      events.push({ type: "dispose", time: g.time, asset: pool, qty: qty.abs(), proceedsKrw: proceeds, feeKrw: new Decimal(0), ref: ref(pool) });
    const missingPrice = (pool: string) => unpriced.push({ key: g.key, pool, time: g.time });

    if (status === "needs_review") {
      const values = nets.map(([p, q]) => valueOf(p, q));
      unresolved.push({
        key: g.key,
        time: g.time,
        category,
        reason,
        valueKrw:
          values.length > 0 && values.every((v) => v) ? values.reduce<Decimal>((s, v) => s.plus(v!), new Decimal(0)) : null,
      });
    }

    switch (category) {
      case "trade": {
        const outs = nets.filter(([, q]) => q.isNegative());
        const ins = nets.filter(([, q]) => q.isPositive());
        const outVals = outs.map(([p, q]) => valueOf(p, q));
        const inVals = ins.map(([p, q]) => valueOf(p, q));
        const priced = (vals: (Decimal | null)[]) => vals.length > 0 && vals.every((v) => v !== null);
        const allStable = (legs: [string, Decimal][]) => legs.length > 0 && legs.every(([p]) => STABLECOINS.has(p));

        let outFinal: (Decimal | null)[];
        let inFinal: (Decimal | null)[];
        if (allStable(outs) && priced(outVals) && !allStable(ins)) {
          // 스테이블코인으로 산 경우: 실제로 지불한 금액이 취득가다
          outFinal = outVals;
          inFinal = allocate(sum(outVals), inVals);
        } else if (allStable(ins) && priced(inVals) && !allStable(outs)) {
          // 스테이블코인을 받고 판 경우: 실제로 받은 금액이 양도가다
          inFinal = inVals;
          outFinal = allocate(sum(inVals), outVals);
        } else {
          // 각자 시가. 한쪽 시세가 전혀 없으면 다른 쪽 총액을 나눠 쓴다 (교환이므로 양쪽 가치가 같다고 본다)
          outFinal = outVals.every((v) => v === null) && priced(inVals) ? allocate(sum(inVals), outVals) : outVals;
          inFinal = inVals.every((v) => v === null) && priced(outVals) ? allocate(sum(outVals), inVals) : inVals;
        }
        outs.forEach(([p, q], i) => {
          if (!outFinal[i]) missingPrice(p);
          dispose(p, q, outFinal[i] ?? new Decimal(0));
        });
        ins.forEach(([p, q], i) => {
          if (!inFinal[i]) missingPrice(p);
          acquire(p, q, inFinal[i] ?? new Decimal(0));
        });
        break;
      }
      case "buy_fiat":
      case "sell_fiat": {
        // 실제 거래가액: 지불·수령한 법정화폐를 원화로 환산 (수수료 포함). 원화는 그대로.
        let fiatKrw: Decimal | null = new Decimal(0);
        for (const [code, q] of fiatNetsOf(g)) {
          const rate = code === "KRW" ? new Decimal(1) : priceOf(code);
          if (!rate) {
            missingPrice(code);
            fiatKrw = null;
            break;
          }
          fiatKrw = fiatKrw!.plus(q.mul(rate));
        }
        const outs = nets.filter(([, q]) => q.isNegative());
        const ins = nets.filter(([, q]) => q.isPositive());
        if (category === "buy_fiat") {
          const paid = fiatKrw ? fiatKrw.neg() : null; // 법정화폐 순유출 = 취득가
          const alloc = paid ? allocate(paid, ins.map(([p, q]) => valueOf(p, q))) : ins.map(() => null);
          ins.forEach(([p, q], i) => acquire(p, q, alloc[i] ?? new Decimal(0)));
          outs.forEach(([p, q]) => dispose(p, q, valueOf(p, q) ?? new Decimal(0)));
        } else {
          const received = fiatKrw; // 법정화폐 순유입 (수수료 차감 후) = 양도가
          const alloc = received ? allocate(received, outs.map(([p, q]) => valueOf(p, q))) : outs.map(() => null);
          outs.forEach(([p, q], i) => dispose(p, q, alloc[i] ?? new Decimal(0)));
          ins.forEach(([p, q]) => acquire(p, q, valueOf(p, q) ?? new Decimal(0)));
        }
        break;
      }
      case "external_out":
      case "external_in": {
        const ins = nets.filter(([, q]) => q.isPositive());
        const userCost = decision?.costKrw ? new Decimal(decision.costKrw) : new Decimal(0);
        for (const [p, q] of nets) {
          if (q.isNegative()) {
            // 외부로 보낸 코인: 당시 시가로 양도 (정책)
            const v = valueOf(p, q);
            if (!v) missingPrice(p);
            dispose(p, q, v ?? new Decimal(0));
          } else {
            // 외부에서 받은 코인: 사용자가 입력한 취득가, 없으면 0원
            acquire(p, q, userCost.div(ins.length));
          }
        }
        break;
      }
      case "reward":
      case "airdrop":
        // 정책: 취득가 0원 (팔 때 과세)
        for (const [p, q] of nets) if (q.isPositive()) acquire(p, q, new Decimal(0));
        break;
      case "internal_transfer": {
        // R11로 짝지은 이체에서 받은 수량이 보낸 수량보다 적은 만큼은 이체 수수료 (classifier.ts matchUnhashedTransfers)
        const pair = g.classification.pair;
        if (pair?.feeQty && pair.feeAsset) {
          const pool = poolOf(pair.feeAsset);
          pools.add(pool);
          events.push({ type: "fee", time: g.time, asset: pool, qty: new Decimal(pair.feeQty), ref: `${g.key}:pairfee` });
        }
        break;
      }
      // wrap, fee_only, fiat_transfer: 수수료 외 과세 없음
      // unknown, defi_unsupported: 해석하지 못해 계산에서 제외 (unresolved로 표시됨)
      default:
        break;
    }
  }

  return { events, unresolved, unpriced, pools };
}
