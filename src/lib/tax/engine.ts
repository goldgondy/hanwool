import Decimal from "@/lib/decimal";
import {
  BASIC_DEDUCTION_KRW,
  INCOME_TAX_RATE,
  LOCAL_TAX_RATE,
  TAX_START,
  yearOf,
} from "./rules";

// 가상자산 양도소득 계산 엔진 (이동평균법).
// 입력은 이미 원화로 환산된 이벤트다. 거래소 CSV·온체인 내역을 이벤트로 바꾸는 일은 이 모듈의 책임이 아니다.
//
// - 코인 간 교환(예: USDT→BTC)은 호출자가 dispose(USDT) + acquire(BTC) 두 이벤트로 넘긴다.
// - 과세 시작 전 이벤트도 모두 처리해 실제 취득가액(이동평균)을 구하고,
//   과세 시작 시점에 보유분의 취득가액을 max(실제 취득가액, 2026년 말 시가 × 수량)로 올린다.
//   의제취득가는 시행일 이전 보유분에만 적용하며, 이후 취득분은 실제 취득가액으로만 풀에 더해진다.
// - 자기 지갑 간 이체는 이벤트로 넘기지 않는다. 풀은 자산별로 납세자 전체에 하나다.

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
}

export const DEFAULT_POLICY: EnginePolicy = { feeTreatment: "expense" };

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

export function runEngine(
  events: TaxEvent[],
  prices20261231: Record<string, Decimal | undefined>,
  policy: EnginePolicy = DEFAULT_POLICY,
): EngineResult {
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.time - b.e.time || ORDER[a.e.type] - ORDER[b.e.type] || a.i - b.i)
    .map(({ e }) => e);

  const pools = new Map<string, Pool>();
  const disposals: Disposal[] = [];
  const deemed: DeemedAdjustment[] = [];
  const warnings: EngineWarning[] = [];
  let deemedApplied = false;

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
    if (!deemedApplied && e.time >= TAX_START) applyDeemed();
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
        taxable: e.time >= TAX_START,
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
      taxable: e.time >= TAX_START,
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
