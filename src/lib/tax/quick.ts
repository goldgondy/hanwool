import Decimal from "@/lib/decimal";
import { runEngine, type EngineResult, type TaxEvent } from "./engine";

// 가입 없는 간이 계산기 (화면: src/app/calculator). 코인마다 합계 금액만 받아 실제 계산과 같은 엔진(총평균법·의제취득가)으로 계산한다.
// 연중 순서는 총평균법에서 결과에 영향이 없으므로 대표 시각으로 이벤트를 만든다.

export interface QuickCoin {
  name: string;
  holdQty: string; // 2026년 말 보유 수량
  holdCost: string; // 그 수량의 실제 취득가 합계 (원)
  holdPrice: string; // 2026년 말 시가 (원/개) — 모르면 비움
  buyQty: string; // 그 해 매수 수량
  buyCost: string; // 그 해 매수 금액 합계 (원, 수수료 포함)
  sellQty: string; // 그 해 매도 수량
  sellAmount: string; // 그 해 매도 금액 합계 (원)
  sellFee: string; // 매도 수수료 (원)
}

export const emptyCoin = (name = ""): QuickCoin => ({ name, holdQty: "", holdCost: "", holdPrice: "", buyQty: "", buyCost: "", sellQty: "", sellAmount: "", sellFee: "" });

// "1,234.5", "" → Decimal 또는 0
export function num(s: string): Decimal {
  const t = s.replace(/[,\s원₩]/g, "");
  if (!t) return new Decimal(0);
  try {
    const d = new Decimal(t);
    return d.isNegative() ? new Decimal(0) : d;
  } catch {
    return new Decimal(0);
  }
}

const OPEN = Date.parse("2026-06-30T12:00:00+09:00");
const BUY = Date.parse("2027-03-01T12:00:00+09:00");
const SELL = Date.parse("2027-09-01T12:00:00+09:00");

export interface QuickResult {
  engine: EngineResult;
  perCoin: { name: string; proceeds: Decimal; cost: Decimal; fee: Decimal; gain: Decimal; deemedUsed: boolean; avgUnit: Decimal | null }[];
}

export function quickCalculate(coins: QuickCoin[]): QuickResult {
  const events: TaxEvent[] = [];
  const prices: Record<string, Decimal | undefined> = {};
  const used = coins.filter((c) => c.name.trim() || num(c.sellQty).gt(0) || num(c.buyQty).gt(0) || num(c.holdQty).gt(0));
  used.forEach((c, i) => {
    const asset = `${i}:${c.name.trim() || `코인 ${i + 1}`}`; // 이름이 같아도 줄마다 따로 계산
    if (num(c.holdQty).gt(0)) events.push({ type: "acquire", time: OPEN, asset, qty: num(c.holdQty), costKrw: num(c.holdCost), ref: `${i}:hold` });
    if (num(c.holdPrice).gt(0)) prices[asset] = num(c.holdPrice);
    if (num(c.buyQty).gt(0)) events.push({ type: "acquire", time: BUY, asset, qty: num(c.buyQty), costKrw: num(c.buyCost), ref: `${i}:buy` });
    if (num(c.sellQty).gt(0)) events.push({ type: "dispose", time: SELL, asset, qty: num(c.sellQty), proceedsKrw: num(c.sellAmount), feeKrw: num(c.sellFee), ref: `${i}:sell` });
  });
  const engine = runEngine(events, prices);
  const perCoin = used.map((c, i) => {
    const asset = `${i}:${c.name.trim() || `코인 ${i + 1}`}`;
    const d = engine.disposals.find((x) => x.asset === asset && x.taxable);
    const deemed = engine.deemed.find((x) => x.asset === asset);
    const qty = num(c.holdQty).plus(num(c.buyQty));
    const openCost = deemed ? deemed.appliedCostKrw : num(c.holdCost);
    return {
      name: c.name.trim() || `코인 ${i + 1}`,
      proceeds: d?.proceedsKrw ?? new Decimal(0),
      cost: d?.costKrw ?? new Decimal(0),
      fee: d?.feeKrw ?? new Decimal(0),
      gain: d?.gainKrw ?? new Decimal(0),
      deemedUsed: !!deemed && deemed.appliedCostKrw.gt(deemed.actualCostKrw),
      avgUnit: qty.gt(0) ? openCost.plus(num(c.buyCost)).div(qty) : null,
    };
  });
  return { engine, perCoin };
}
