"use client";

import { useState } from "react";
import Decimal from "@/lib/decimal";
import { formatAmount, formatKrw } from "@/lib/format";
import { calculate, currentPrices } from "@/lib/tax/calculate";
import { deductionRoom, sellPlan, splitYears, unrealized, valueOf, yearEndSim, type PlanHolding } from "@/lib/tax/planner";
import { TAX_START, yearOf } from "@/lib/tax/rules";

const button = "rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900";
const input = "rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm dark:border-stone-700";
const won = (d: Decimal) => formatKrw(d.toFixed(0));
const tone = (d: Decimal) => (d.isNegative() ? "text-red-600" : d.isZero() ? "" : "text-emerald-600");

interface Loaded {
  holdings: PlanHolding[];
  realizedNet: Decimal;
  year: number;
  beforeTax: boolean; // 과세 시작(2027년) 전인지
}

export default function PlanPage() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [need, setNeed] = useState("");

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const report = await calculate("actual", setProgress);
      const pools = [...report.engine.pools.entries()].filter(([, p]) => p.qty.gt(0));
      setProgress("현재 시세 조회 중");
      const prices = await currentPrices(pools.map(([a]) => a));
      const year = yearOf(Date.now());
      setData({
        holdings: pools.map(([asset, p]) => ({ asset, qty: p.qty, cost: p.costKrw, price: prices.get(asset) ?? null })),
        realizedNet: report.engine.years.find((y) => y.year === year)?.netKrw ?? new Decimal(0),
        year,
        beforeTax: Date.now() < TAX_START,
      });
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const holdings = data ? [...data.holdings].sort((a, b) => (unrealized(a) ?? new Decimal(0)).comparedTo(unrealized(b) ?? new Decimal(0))) : [];
  const sim = data ? yearEndSim(data.realizedNet, data.holdings, selected) : null;
  const room = data ? deductionRoom(data.realizedNet) : null;
  const needKrw = /^\d+$/.test(need.replace(/,/g, "")) ? new Decimal(need.replace(/,/g, "")) : null;
  const plan = data && needKrw?.gt(0) ? sellPlan(data.holdings, needKrw, data.realizedNet) : null;
  const split = data && plan && plan.gain.gt(0) ? splitYears(data.realizedNet, plan.gain) : null;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">절세 도구</h2>
        <p className="text-sm text-stone-500">
          지금 보유한 코인의 평가손익과 올해 이미 확정된 손익으로, 연말에 무엇을 팔면 세금이 어떻게 달라지는지, 돈이 필요할 때 무엇부터 팔아야
          세금이 적은지 계산합니다. 취득가는 이동평균(2026년 말 보유분은 의제취득가 반영)이고, 수수료와 시세 변동은 고려하지 않은 추정입니다.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button className={button} disabled={busy} onClick={load}>
          {busy ? "불러오는 중…" : data ? "다시 불러오기" : "보유 현황 불러오기"}
        </button>
        <span className="text-sm text-stone-500">{progress}</span>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {data?.beforeTax && (
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          과세는 2027년부터라 올해({data.year}년) 판 것은 세금이 없습니다. 아래 계산은 2027년에 같은 상황이라면 어떻게 되는지 미리 보는 용도입니다.
        </p>
      )}

      {data && sim && room && (
        <section className="space-y-3">
          <h3 className="font-semibold">연말 정리 시뮬레이션</h3>
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
              <p className="text-xs text-stone-500">{data.year}년 확정 손익</p>
              <p className={`font-semibold tabular-nums ${tone(data.realizedNet)}`}>{won(data.realizedNet)}</p>
            </div>
            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
              <p className="text-xs text-stone-500">남은 기본공제 (이만큼 이익 실현은 세금 0)</p>
              <p className="font-semibold tabular-nums">{won(room)}</p>
            </div>
            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
              <p className="text-xs text-stone-500">선택한 코인을 모두 팔면 세금</p>
              <p className="font-semibold tabular-nums">
                {won(sim.before.tax)} → {won(sim.after.tax)}{" "}
                <span className={`text-xs ${sim.change.isNegative() ? "text-emerald-600" : sim.change.isZero() ? "" : "text-red-600"}`}>
                  ({sim.change.isNegative() ? "" : "+"}
                  {won(sim.change)})
                </span>
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs text-stone-500">
                <tr className="border-b border-stone-200 dark:border-stone-800">
                  <th className="py-2 pr-3 font-medium">팔기</th>
                  <th className="py-2 pr-3 font-medium">자산</th>
                  <th className="py-2 pr-3 text-right font-medium">수량</th>
                  <th className="py-2 pr-3 text-right font-medium">취득가</th>
                  <th className="py-2 pr-3 text-right font-medium">평가액</th>
                  <th className="py-2 text-right font-medium">평가손익</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => {
                  const u = unrealized(h);
                  return (
                    <tr key={h.asset} className="border-b border-stone-100 dark:border-stone-900">
                      <td className="py-1.5 pr-3">
                        <input
                          type="checkbox"
                          disabled={!h.price}
                          checked={selected.has(h.asset)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(h.asset);
                            else next.delete(h.asset);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td className="py-1.5 pr-3">{h.asset}</td>
                      <td className="py-1.5 pr-3 text-right">{formatAmount(h.qty.toString())}</td>
                      <td className="py-1.5 pr-3 text-right">{won(h.cost)}</td>
                      <td className="py-1.5 pr-3 text-right">{h.price ? won(valueOf(h)!) : "시세 없음"}</td>
                      <td className={`py-1.5 text-right ${u ? tone(u) : ""}`}>{u ? won(u) : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-stone-500">
            <li>같은 해 안의 손익은 모두 합쳐 계산하고, 남은 손실은 다음 해로 넘어가지 않습니다. 이익이 난 해에 손실 코인을 정리하면 세금이 줄어듭니다.</li>
            <li>남은 기본공제만큼은 이익 난 코인을 팔았다 다시 사도 세금이 없고, 다시 산 값이 새 취득가가 되어 나중 세금이 줄어듭니다.</li>
            <li>판 뒤 바로 다시 사는 거래의 세법상 취급은 신고 전에 세무 전문가와 확인하세요.</li>
          </ul>
        </section>
      )}

      {data && (
        <section className="space-y-3">
          <h3 className="font-semibold">매도 플랜: 필요한 금액을 세금 적게 마련하기</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input className={`${input} w-56`} value={need} onChange={(e) => setNeed(e.target.value)} placeholder="필요한 금액 (원)" inputMode="numeric" />
            <span className="text-xs text-stone-500">손실 난 코인 → 이익이 적은 코인 순으로 팝니다 (받는 돈 1원당 이익이 작은 순).</span>
          </div>
          {plan && (
            <div className="space-y-2 text-sm">
              {plan.shortfall.gt(0) && <p className="text-xs text-amber-700">보유 코인을 모두 팔아도 {won(plan.shortfall)}이 모자랍니다.</p>}
              <div className="overflow-x-auto">
                <table className="w-full tabular-nums">
                  <thead className="text-left text-xs text-stone-500">
                    <tr className="border-b border-stone-200 dark:border-stone-800">
                      <th className="py-2 pr-3 font-medium">순서</th>
                      <th className="py-2 pr-3 font-medium">자산</th>
                      <th className="py-2 pr-3 text-right font-medium">팔 수량</th>
                      <th className="py-2 pr-3 text-right font-medium">받는 금액</th>
                      <th className="py-2 text-right font-medium">실현 손익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.legs.map((l, i) => (
                      <tr key={l.asset} className="border-b border-stone-100 dark:border-stone-900">
                        <td className="py-1.5 pr-3">{i + 1}</td>
                        <td className="py-1.5 pr-3">{l.asset}</td>
                        <td className="py-1.5 pr-3 text-right">{formatAmount(l.qty.toDecimalPlaces(8).toString())}</td>
                        <td className="py-1.5 pr-3 text-right">{won(l.value)}</td>
                        <td className={`py-1.5 text-right ${tone(l.gain)}`}>{won(l.gain)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                이 순서로 팔면 추가 세금 <b>{won(plan.tax)}</b> · 모든 코인을 가진 비율대로 팔면 {won(plan.baselineTax)}
                {plan.baselineTax.gt(plan.tax) && <span className="text-emerald-600"> ({won(plan.baselineTax.minus(plan.tax))} 절약)</span>}
              </p>
              {split && split.saving.gt(0) && (
                <p className="rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                  해를 나눠 팔면 더 줄어듭니다: 이익 {won(split.thisYear)}어치는 올해, 나머지 {won(split.nextYear)}어치는 내년 1월에 팔면 세금 {won(split.oneYear)} →{" "}
                  {won(split.split)} ({won(split.saving)} 절약, 기본공제를 두 해 모두 사용). 내년에 다른 손익이 없다고 가정했습니다.
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
