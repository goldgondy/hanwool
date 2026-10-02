import Decimal from "@/lib/decimal";
import { BASIC_DEDUCTION_KRW, INCOME_TAX_RATE, LOCAL_TAX_RATE } from "./rules";

// 절세 도구 계산 (순수 함수). 화면: src/app/plan/page.tsx
// - 연말 정리: 올해 실현 손익 + 팔 코인의 평가손익 → 세액 변화. 남은 기본공제만큼은 이익을 실현해도 세금이 없다.
// - 매도 플랜: 필요한 금액을 '받는 돈 1원당 이익'이 작은 코인부터 판다 (손실 코인이 먼저). 해를 나눠 팔면 공제를 두 번 받는다.
// 수수료·시세 변동은 고려하지 않은 추정이다.

export interface PlanHolding {
  asset: string;
  qty: Decimal;
  cost: Decimal; // 보유분 전체 취득가 (이동평균, 의제취득가 반영)
  price: Decimal | null; // 현재 원화 시세
}

const ZERO = new Decimal(0);
const TAX_RATE = INCOME_TAX_RATE.mul(LOCAL_TAX_RATE.plus(1)); // 22%

// 한 해 손익 통산 금액에 대한 세액 (소득세 + 지방소득세)
export const taxOf = (net: Decimal) => Decimal.max(ZERO, net.minus(BASIC_DEDUCTION_KRW)).mul(TAX_RATE).floor();

// 올해 남은 기본공제: 이만큼은 이익을 더 실현해도 세금이 없다
export const deductionRoom = (realizedNet: Decimal) => Decimal.max(ZERO, BASIC_DEDUCTION_KRW.minus(Decimal.max(ZERO, realizedNet)));

export const valueOf = (h: PlanHolding) => (h.price ? h.qty.mul(h.price) : null);
export const unrealized = (h: PlanHolding) => (h.price ? h.qty.mul(h.price).minus(h.cost) : null);

export function yearEndSim(realizedNet: Decimal, holdings: PlanHolding[], sellAll: Set<string>) {
  const extra = holdings.filter((h) => sellAll.has(h.asset)).reduce((s, h) => s.plus(unrealized(h) ?? 0), ZERO);
  const before = { net: realizedNet, tax: taxOf(realizedNet) };
  const after = { net: realizedNet.plus(extra), tax: taxOf(realizedNet.plus(extra)) };
  return { before, after, change: after.tax.minus(before.tax) };
}

export interface PlanLeg {
  asset: string;
  qty: Decimal;
  value: Decimal;
  gain: Decimal;
}

export function sellPlan(holdings: PlanHolding[], needKrw: Decimal, realizedNet: Decimal) {
  const priced = holdings.filter((h) => h.price && h.qty.gt(0) && h.price.gt(0));
  // 받는 돈 1원당 이익 = (현재가 − 평균 단가) / 현재가 = 평가손익 / 평가액
  const ratio = (h: PlanHolding) => unrealized(h)!.div(valueOf(h)!);
  const order = [...priced].sort((a, b) => ratio(a).comparedTo(ratio(b)));
  const legs: PlanLeg[] = [];
  let left = needKrw;
  for (const h of order) {
    if (left.lte(0)) break;
    const value = valueOf(h)!;
    const take = Decimal.min(value, left);
    const frac = take.div(value);
    legs.push({ asset: h.asset, qty: h.qty.mul(frac), value: take, gain: unrealized(h)!.mul(frac) });
    left = left.minus(take);
  }
  const gain = legs.reduce((s, l) => s.plus(l.gain), ZERO);
  const total = priced.reduce((s, h) => s.plus(valueOf(h)!), ZERO);
  // 비교 기준: 모든 코인을 가진 비율대로 판 경우
  const sold = Decimal.min(needKrw, total);
  const baselineGain = total.isZero() ? ZERO : priced.reduce((s, h) => s.plus(unrealized(h)!), ZERO).mul(sold.div(total));
  const extraTax = (g: Decimal) => taxOf(realizedNet.plus(g)).minus(taxOf(realizedNet));
  return {
    legs,
    gain,
    tax: extraTax(gain),
    baselineTax: extraTax(baselineGain),
    shortfall: Decimal.max(ZERO, left), // 팔 수 있는 것보다 필요한 금액이 큼
  };
}

// 이익을 올해와 내년으로 나눠 실현: 올해 남은 공제만큼만 올해, 나머지는 내년 1월 (내년 다른 손익은 없다고 가정)
export function splitYears(realizedNet: Decimal, gain: Decimal) {
  const thisYear = Decimal.min(gain, deductionRoom(realizedNet));
  const nextYear = gain.minus(thisYear);
  const oneYear = taxOf(realizedNet.plus(gain)).minus(taxOf(realizedNet));
  const split = taxOf(realizedNet.plus(thisYear)).minus(taxOf(realizedNet)).plus(taxOf(nextYear));
  return { thisYear, nextYear, oneYear, split, saving: oneYear.minus(split) };
}
