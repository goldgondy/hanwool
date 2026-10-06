import Decimal from "@/lib/decimal";
import {
  BASIC_DEDUCTION_KRW,
  INCOME_TAX_RATE,
  LOCAL_TAX_RATE,
  TAX_START,
  yearOf,
} from "./rules";

// 가상자산 양도소득 계산 엔진.
// 입력은 이미 원화로 환산된 이벤트다. 거래소 CSV·온체인 내역을 이벤트로 바꾸는 일은 이 모듈의 책임이 아니다.
//
// 취득가액 산정: 총평균법 (소득세법 시행령 제88조①, 2027-01-01 시행본: "거주자별로 제92조제2항제4호의 총평균법")
//   해마다 자산별로 평균단가 = (1월 1일 보유분 취득가액 + 그 해 취득분 취득가액) ÷ (1월 1일 보유 수량 + 그 해 취득 수량)
//   그 해의 모든 양도는 이 평균단가로 원가를 정한다 (양도 시점과 그 뒤의 매수 순서와 무관). 남은 수량도 이 단가로 다음 해로 넘어간다.
//   비교·검증용으로 이동평균법(costMethod: "moving-average")도 남겨 둔다.
// - 코인 간 교환(예: USDT→BTC)은 호출자가 dispose(USDT) + acquire(BTC) 두 이벤트로 넘긴다.
// - 과세 시작 전 이벤트도 모두 처리해 실제 취득가액을 구하고,
//   과세 시작 시점(2027-01-01)에 보유분의 취득가액을 max(실제 취득가액, 2026년 말 시가 × 수량)로 올린다 (의제취득가).
// - 자기 지갑 간 이체는 이벤트로 넘기지 않는다. 풀은 자산별로 납세자 전체에 하나다 (거주자별).

export type TaxEvent =
  | {
      type: "acquire";
      time: number;
      asset: string;
      qty: Decimal;
      costKrw: Decimal; // 취득가액 + 부대비용
      ref: string;
      costUnknown?: boolean; // 외부 입금 등 취득가를 알 수 없어 임의 값을 쓴 경우
    }
  | {
      type: "dispose";
      time: number;
      asset: string;
      qty: Decimal;
      proceedsKrw: Decimal; // 양도가액
      feeKrw: Decimal; // 양도 부대비용
      ref: string;
    }
  | {
      // 코인으로 지불한 수수료 (네트워크 가스비, BNB 거래 수수료 등)
      type: "fee";
      time: number;
      asset: string;
      qty: Decimal;
      ref: string;
    };

export interface EnginePolicy {
  // expense: 양도가액 0인 양도로 보아 해당 수량의 원가만큼 즉시 손실을 인식한다 (기본값)
  // carry: 수량만 줄이고 원가는 남은 보유분에 얹는다 (손실 인식을 이연)
  feeTreatment: "carry" | "expense";
  // total-average: 총평균법 (법령, 기본값) / moving-average: 이동평균법 (비교용)
  costMethod?: "total-average" | "moving-average";
}

export const DEFAULT_POLICY: EnginePolicy = { feeTreatment: "expense", costMethod: "total-average" };

export interface Disposal {
  ref: string;
  time: number;
  asset: string;
  qty: Decimal;
  proceedsKrw: Decimal;
  costKrw: Decimal;
  feeKrw: Decimal;
  gainKrw: Decimal;
  taxable: boolean; // 과세 시작 이후 양도인지
}

export interface DeemedAdjustment {
  asset: string;
  qty: Decimal;
  actualCostKrw: Decimal;
  fairValueKrw: Decimal | null; // 2026년 말 시가 × 수량 (시가가 없으면 null)
  appliedCostKrw: Decimal;
}

export interface YearSummary {
  year: number;
  gainKrw: Decimal; // 이익 합계
  lossKrw: Decimal; // 손실 합계 (음수)
  netKrw: Decimal; // 손익 통산
  deductionKrw: Decimal;
  taxableKrw: Decimal; // 과세표준
  incomeTaxKrw: Decimal;
  localTaxKrw: Decimal;
  totalTaxKrw: Decimal;
  disposalCount: number;
}

export interface EngineWarning {
  ref?: string;
  time?: number;
  asset?: string;
  message: string;
}

export interface Pool {
  qty: Decimal;
  costKrw: Decimal;
}

export interface EngineResult {
  disposals: Disposal[];
  years: YearSummary[];
  deemed: DeemedAdjustment[];
  pools: Map<string, Pool>;
  warnings: EngineWarning[];
}

const ZERO = new Decimal(0);

// 같은 시각이면 취득을 먼저 처리해, 동시에 체결된 매수·매도가 보유 부족으로 잡히지 않게 한다.
const ORDER: Record<TaxEvent["type"], number> = { acquire: 0, fee: 1, dispose: 2 };

export interface EngineOptions {
  // 과세 시작 시각. 모의 계산("지금까지의 거래에 과세한다면")에서는 0으로 둔다.
  taxStart?: number;
  // 의제취득가 적용 여부. 모의 계산에서는 끈다.
  applyDeemed?: boolean;
}

export function runEngine(
  events: TaxEvent[],
  prices20261231: Record<string, Decimal | undefined>,
  policy: EnginePolicy = DEFAULT_POLICY,
  options: EngineOptions = {},
): EngineResult {
  return (policy.costMethod ?? "total-average") === "total-average"
    ? runTotalAverage(events, prices20261231, policy, options)
    : runMovingAverage(events, prices20261231, policy, options);
}

const sortEvents = (events: TaxEvent[]) =>
  events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.time - b.e.time || ORDER[a.e.type] - ORDER[b.e.type] || a.i - b.i)
    .map(({ e }) => e);

// 의제취득가: 과세 시작 시점 보유분의 취득가액을 max(실제 취득가액, 2026년 말 시가 × 수량)로
function deemPools(pools: Map<string, Pool>, prices20261231: Record<string, Decimal | undefined>, deemed: DeemedAdjustment[], warnings: EngineWarning[]) {
  for (const [asset, p] of pools) {
    if (p.qty.lte(0)) continue;
    const price = prices20261231[asset];
    const fairValue = price ? p.qty.mul(price) : null;
    if (!fairValue) warnings.push({ asset, message: "2026년 말 시가가 없어 실제 취득가액을 그대로 사용했습니다" });
    const applied = fairValue && fairValue.gt(p.costKrw) ? fairValue : p.costKrw;
    deemed.push({ asset, qty: p.qty, actualCostKrw: p.costKrw, fairValueKrw: fairValue, appliedCostKrw: applied });
    p.costKrw = applied;
  }
}

// 총평균법: 해마다 자산별 평균단가를 먼저 구한 뒤 그 해 양도에 적용한다.
function runTotalAverage(
  events: TaxEvent[],
  prices20261231: Record<string, Decimal | undefined>,
  policy: EnginePolicy,
  { taxStart = TAX_START, applyDeemed: deemedEnabled = true }: EngineOptions,
): EngineResult {
  const sorted = sortEvents(events);
  const pools = new Map<string, Pool>();
  const disposals: Disposal[] = [];
  const deemed: DeemedAdjustment[] = [];
  const warnings: EngineWarning[] = [];
  let deemedApplied = !deemedEnabled;
  const pool = (asset: string) => {
    let p = pools.get(asset);
    if (!p) {
      p = { qty: ZERO, costKrw: ZERO };
      pools.set(asset, p);
    }
    return p;
  };

  // 연도별로 나눈다 (한국 시각 기준)
  const byYear = new Map<number, TaxEvent[]>();
  for (const e of sorted) byYear.set(yearOf(e.time), [...(byYear.get(yearOf(e.time)) ?? []), e]);
  const taxYear = yearOf(taxStart);

  for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
    // 과세 시작 연도에 들어서면 1월 1일 보유분에 의제취득가를 적용한다
    if (!deemedApplied && year >= taxYear) {
      deemPools(pools, prices20261231, deemed, warnings);
      deemedApplied = true;
    }
    const list = byYear.get(year)!;

    // 1) 자산별 평균단가 = (기초 원가 + 그 해 취득 원가) ÷ (기초 수량 + 그 해 취득 수량 − 원가를 남기는 수수료 수량)
    const totals = new Map<string, { qty: Decimal; cost: Decimal; carryFee: Decimal }>();
    const total = (asset: string) => {
      let t = totals.get(asset);
      if (!t) {
        const p = pool(asset);
        t = { qty: p.qty, cost: p.costKrw, carryFee: ZERO };
        totals.set(asset, t);
      }
      return t;
    };
    for (const e of list) {
      const t = total(e.asset);
      if (e.type === "acquire") {
        t.qty = t.qty.plus(e.qty);
        t.cost = t.cost.plus(e.costKrw);
      } else if (e.type === "fee" && policy.feeTreatment === "carry") {
        t.carryFee = t.carryFee.plus(e.qty);
      }
    }
    // 평균단가는 (원가 합계, 수량) 그대로 두고 원가 = 원가 합계 × 수량 ÷ 총수량으로 계산한다 (나눗셈 반올림 오차 방지)
    const unit = new Map<string, { cost: Decimal; qty: Decimal }>();
    for (const [asset, t] of totals) unit.set(asset, { cost: t.cost, qty: t.qty.minus(t.carryFee) });

    // 2) 시간 순서대로 처리: 원가는 그 해 평균단가로, 보유 부족은 그 해 전체 가용 수량으로 판단한다
    const used = new Map<string, Decimal>(); // 그 해에 꺼낸 수량 (양도 + 수수료)
    const running = new Map<string, Decimal>(); // 시간 순 보유 수량 (마이너스면 기록 누락 신호)
    const warnedRunning = new Set<string>();
    for (const e of list) {
      const t = total(e.asset);
      const u = unit.get(e.asset) ?? { cost: ZERO, qty: ZERO };
      const run = (running.get(e.asset) ?? pool(e.asset).qty).plus(e.type === "acquire" ? e.qty : e.qty.neg());
      running.set(e.asset, run);
      if (e.type === "acquire") {
        if (e.costUnknown) warnings.push({ ref: e.ref, time: e.time, asset: e.asset, message: "취득가액을 알 수 없는 입금입니다. 취득 내역을 확인해 주세요." });
        continue;
      }
      if (run.lt(0) && !warnedRunning.has(e.asset)) {
        warnedRunning.add(e.asset);
        if (!(e.qty.gt(t.qty.minus(used.get(e.asset) ?? ZERO)))) {
          warnings.push({ ref: e.ref, time: e.time, asset: e.asset, message: "그 시점 보유 수량보다 많이 처분했습니다 (같은 해 뒤에 입금·매수 기록이 있음). 입금 기록이 늦게 잡혔거나 누락되었을 수 있습니다." });
        }
      }
      const available = t.qty.minus(used.get(e.asset) ?? ZERO);
      let costQty = e.qty;
      if (e.qty.gt(available)) {
        warnings.push({
          ref: e.ref,
          time: e.time,
          asset: e.asset,
          message: `보유 수량 부족: ${Decimal.max(available, 0).toString()} 보유, ${e.qty.toString()} 처분. 입금·매수 내역이 누락되었을 수 있습니다. 부족분의 취득가액은 0으로 계산했습니다.`,
        });
        costQty = Decimal.max(available, 0);
      }
      used.set(e.asset, (used.get(e.asset) ?? ZERO).plus(e.qty));
      if (e.type === "fee" && policy.feeTreatment === "carry") continue; // 원가를 남은 보유분에 남긴다
      const cost = u.qty.gt(0) ? u.cost.mul(costQty).div(u.qty) : ZERO;
      const proceeds = e.type === "dispose" ? e.proceedsKrw : ZERO;
      const feeKrw = e.type === "dispose" ? e.feeKrw : ZERO;
      t.cost = t.cost.minus(cost);
      disposals.push({ ref: e.ref, time: e.time, asset: e.asset, qty: e.qty, proceedsKrw: proceeds, costKrw: cost, feeKrw, gainKrw: proceeds.minus(cost).minus(feeKrw), taxable: e.time >= taxStart });
    }

    // 3) 다음 해로 넘기는 보유분 = 남은 수량 × 그 해 평균단가 (남은 원가)
    for (const [asset, t] of totals) {
      const p = pool(asset);
      const qty = Decimal.max(t.qty.minus(used.get(asset) ?? ZERO), 0);
      p.qty = qty;
      p.costKrw = qty.isZero() ? ZERO : Decimal.max(t.cost, 0);
    }
  }

  // 과세 시작 이후 이벤트가 없어도 보유분의 의제취득가는 계산해 둔다.
  if (!deemedApplied) deemPools(pools, prices20261231, deemed, warnings);

  return { disposals, years: summarize(disposals), deemed, pools, warnings };
}

// 이동평균법 (비교용). 살 때마다 평균단가를 다시 낸다.
function runMovingAverage(
  events: TaxEvent[],
  prices20261231: Record<string, Decimal | undefined>,
  policy: EnginePolicy,
  { taxStart = TAX_START, applyDeemed: deemedEnabled = true }: EngineOptions,
): EngineResult {
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.time - b.e.time || ORDER[a.e.type] - ORDER[b.e.type] || a.i - b.i)
    .map(({ e }) => e);

  const pools = new Map<string, Pool>();
  const disposals: Disposal[] = [];
  const deemed: DeemedAdjustment[] = [];
  const warnings: EngineWarning[] = [];
  let deemedApplied = !deemedEnabled;

  const pool = (asset: string) => {
    let p = pools.get(asset);
    if (!p) {
      p = { qty: ZERO, costKrw: ZERO };
      pools.set(asset, p);
    }
    return p;
  };

  function applyDeemed() {
    deemedApplied = true;
    for (const [asset, p] of pools) {
      if (p.qty.lte(0)) continue;
      const price = prices20261231[asset];
      const fairValue = price ? p.qty.mul(price) : null;
      if (!fairValue) {
        warnings.push({
          asset,
          message: "2026년 말 시가가 없어 실제 취득가액을 그대로 사용했습니다",
        });
      }
      const applied = fairValue && fairValue.gt(p.costKrw) ? fairValue : p.costKrw;
      deemed.push({
        asset,
        qty: p.qty,
        actualCostKrw: p.costKrw,
        fairValueKrw: fairValue,
        appliedCostKrw: applied,
      });
      p.costKrw = applied;
    }
  }

  // 평균 원가로 qty만큼 꺼낸다. 보유가 부족하면 있는 만큼만 원가를 배정하고 경고한다.
  function withdraw(e: TaxEvent, p: Pool): Decimal {
    if (e.qty.gt(p.qty)) {
      warnings.push({
        ref: e.ref,
        time: e.time,
        asset: e.asset,
        message: `보유 수량 부족: ${p.qty.toString()} 보유, ${e.qty.toString()} 처분. 입금·매수 내역이 누락되었을 수 있습니다. 부족분의 취득가액은 0으로 계산했습니다.`,
      });
      const cost = p.costKrw;
      p.qty = ZERO;
      p.costKrw = ZERO;
      return cost;
    }
    const cost = p.costKrw.mul(e.qty).div(p.qty);
    p.qty = p.qty.minus(e.qty);
    p.costKrw = p.qty.isZero() ? ZERO : p.costKrw.minus(cost);
    return cost;
  }

  for (const e of sorted) {
    if (!deemedApplied && e.time >= taxStart) applyDeemed();
    const p = pool(e.asset);

    if (e.type === "acquire") {
      p.qty = p.qty.plus(e.qty);
      p.costKrw = p.costKrw.plus(e.costKrw);
      if (e.costUnknown) {
        warnings.push({
          ref: e.ref,
          time: e.time,
          asset: e.asset,
          message: "취득가액을 알 수 없는 입금입니다. 취득 내역을 확인해 주세요.",
        });
      }
      continue;
    }

    if (e.type === "fee") {
      if (policy.feeTreatment === "carry") {
        if (e.qty.gt(p.qty)) {
          warnings.push({
            ref: e.ref,
            time: e.time,
            asset: e.asset,
            message: "수수료로 지불한 수량이 보유 수량보다 많습니다",
          });
          p.qty = ZERO;
          p.costKrw = ZERO;
        } else {
          p.qty = p.qty.minus(e.qty);
          if (p.qty.isZero()) p.costKrw = ZERO;
        }
        continue;
      }
      const cost = withdraw(e, p);
      disposals.push({
        ref: e.ref,
        time: e.time,
        asset: e.asset,
        qty: e.qty,
        proceedsKrw: ZERO,
        costKrw: cost,
        feeKrw: ZERO,
        gainKrw: cost.neg(),
        taxable: e.time >= taxStart,
      });
      continue;
    }

    const cost = withdraw(e, p);
    disposals.push({
      ref: e.ref,
      time: e.time,
      asset: e.asset,
      qty: e.qty,
      proceedsKrw: e.proceedsKrw,
      costKrw: cost,
      feeKrw: e.feeKrw,
      gainKrw: e.proceedsKrw.minus(cost).minus(e.feeKrw),
      taxable: e.time >= taxStart,
    });
  }

  // 과세 시작 이후 이벤트가 없어도 보유분의 의제취득가는 계산해 둔다.
  if (!deemedApplied) applyDeemed();

  return { disposals, years: summarize(disposals), deemed, pools, warnings };
}

function summarize(disposals: Disposal[]): YearSummary[] {
  const byYear = new Map<number, Disposal[]>();
  for (const d of disposals) {
    if (!d.taxable) continue;
    const y = yearOf(d.time);
    byYear.set(y, [...(byYear.get(y) ?? []), d]);
  }

  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, list]) => {
      const gain = list.reduce((s, d) => (d.gainKrw.gt(0) ? s.plus(d.gainKrw) : s), ZERO);
      const loss = list.reduce((s, d) => (d.gainKrw.lt(0) ? s.plus(d.gainKrw) : s), ZERO);
      const net = gain.plus(loss);
      // 원 미만 절사
      const taxable = Decimal.max(0, net.minus(BASIC_DEDUCTION_KRW)).floor();
      const incomeTax = taxable.mul(INCOME_TAX_RATE).floor();
      const localTax = incomeTax.mul(LOCAL_TAX_RATE).floor();
      return {
        year,
        gainKrw: gain,
        lossKrw: loss,
        netKrw: net,
        deductionKrw: Decimal.min(BASIC_DEDUCTION_KRW, Decimal.max(0, net)),
        taxableKrw: taxable,
        incomeTaxKrw: incomeTax,
        localTaxKrw: localTax,
        totalTaxKrw: incomeTax.plus(localTax),
        disposalCount: list.length,
      };
    });
}
