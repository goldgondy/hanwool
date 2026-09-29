"use client";

import Link from "next/link";
import { useState } from "react";
import Decimal from "@/lib/decimal";
import { loadClassifiedGroups } from "@/lib/classify/load";
import { CATEGORY_LABEL } from "@/lib/classify/types";
import { formatAmount, formatDateTime, formatKrw } from "@/lib/format";
import { buildTaxEvents, DEEMED_PRICE_TIME, poolOf, priceKey, priceQueries, type BuildEventsResult } from "@/lib/tax/build-events";
import { DEFAULT_POLICY, runEngine, type EngineResult } from "@/lib/tax/engine";

type Mode = "actual" | "simulate";

interface Report {
  mode: Mode;
  engine: EngineResult;
  built: BuildEventsResult;
  priceCount: number;
}

async function fetchPrices(queries: { symbol: string; time: number }[], onProgress: (m: string) => void) {
  const out = new Map<string, Decimal | null>();
  for (let i = 0; i < queries.length; i += 500) {
    const chunk = queries.slice(i, i + 500);
    onProgress(`원화 시세 조회 중 (${Math.min(i + 500, queries.length)}/${queries.length})`);
    const res = await fetch("/api/prices/at", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: chunk }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `시세 조회 실패 (HTTP ${res.status})`);
    (body.results as { krw: string | null }[]).forEach((r, j) =>
      out.set(priceKey(chunk[j].symbol, chunk[j].time), r.krw ? new Decimal(r.krw) : null),
    );
  }
  return out;
}

async function calculate(mode: Mode, onProgress: (m: string) => void): Promise<Report> {
  onProgress("분류 불러오는 중");
  const groups = await loadClassifiedGroups();

  const queries = priceQueries(groups);
  if (mode === "actual") {
    // 의제취득가용 2026년 말 시세
    const pools = new Set(groups.flatMap((g) => (g.classification.category === "spam" ? [] : g.entries.map((e) => poolOf(e.asset)))));
    for (const p of pools) queries.push({ symbol: p, time: DEEMED_PRICE_TIME });
  }
  const prices = await fetchPrices(queries, onProgress);

  onProgress("계산 중");
  const built = buildTaxEvents(groups, prices);
  const prices2026: Record<string, Decimal | undefined> = {};
  for (const p of built.pools) prices2026[p] = prices.get(priceKey(p, DEEMED_PRICE_TIME)) ?? undefined;

  const engine = runEngine(
    built.events,
    prices2026,
    DEFAULT_POLICY,
    mode === "simulate" ? { taxStart: 0, applyDeemed: false } : {},
  );
  return { mode, engine, built, priceCount: queries.length };
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? "font-semibold" : ""}`}>
      <span className="text-stone-500">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

export default function TaxPage() {
  const [mode, setMode] = useState<Mode>("actual");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setReport(await calculate(mode, setProgress));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const unresolvedValue = report?.built.unresolved.reduce((s, u) => (u.valueKrw ? s.plus(u.valueKrw) : s), new Decimal(0));
  const unresolvedUnknown = report?.built.unresolved.filter((u) => !u.valueKrw).length ?? 0;
  const taxable = report?.engine.disposals.filter((d) => d.taxable).sort((a, b) => b.time - a.time) ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">세금 계산</h2>
        <p className="text-sm text-stone-500">
          연결한 모든 계정의 원장과 분류를 바탕으로 연도별 양도손익과 예상 세액을 계산합니다. 원화 시세는 거래
          시각의 1시간 캔들 종가(업비트, 없으면 바이낸스 × 환율)를 씁니다.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {(
          [
            ["actual", "실제 계산 (2027년부터 과세)"],
            ["simulate", "모의 계산 (모든 거래에 과세한다면)"],
          ] as [Mode, string][]
        ).map(([m, label]) => (
          <label key={m} className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={mode === m} onChange={() => setMode(m)} />
            {label}
          </label>
        ))}
        <button
          onClick={run}
          disabled={busy}
          className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
        >
          {busy ? "계산 중…" : "계산하기"}
        </button>
        <span className="text-sm text-stone-500">{progress}</span>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {report && (
        <>
          {report.built.unresolved.length > 0 && (
            <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/40">
              <p className="font-medium">
                확인하지 않은 거래 {report.built.unresolved.length}건
                {unresolvedValue && !unresolvedValue.isZero() && <> (시가 기준 약 {formatKrw(unresolvedValue.toFixed(0))}</>}
                {unresolvedValue && !unresolvedValue.isZero() && (unresolvedUnknown > 0 ? ` + 금액 미상 ${unresolvedUnknown}건)` : ")")}
              </p>
              <p className="mt-1 text-stone-600 dark:text-stone-400">
                기본 정책대로 계산에 넣었습니다 (외부로 보냄 = 시가로 양도, 외부에서 받음 = 취득가 0원). 실제와 다르면
                세액이 달라지므로{" "}
                <Link href="/review" className="underline">
                  분류 검토
                </Link>
                에서 확인하세요.
              </p>
              <ul className="mt-2 space-y-0.5 text-xs text-stone-600 dark:text-stone-400">
                {report.built.unresolved.slice(0, 5).map((u) => (
                  <li key={u.key}>
                    {formatDateTime(u.time)} · {CATEGORY_LABEL[u.category]} · {u.valueKrw ? formatKrw(u.valueKrw.toFixed(0)) : "금액 미상"}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-3">
            <h3 className="font-semibold">연도별 예상 세액{report.mode === "simulate" && " (모의)"}</h3>
            {report.engine.years.length === 0 ? (
              <p className="text-sm text-stone-500">
                {report.mode === "actual"
                  ? "2027년 이후 양도한 내역이 없어 과세 대상이 없습니다. 현재 거래로 결과를 보려면 모의 계산을 선택하세요."
                  : "양도한 내역이 없습니다."}
              </p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {report.engine.years.map((y) => (
                  <div key={y.year} className="space-y-1.5 rounded-xl border border-stone-200 p-4 text-sm dark:border-stone-800">
                    <p className="text-base font-semibold">{y.year}년 귀속 · 양도 {y.disposalCount}건</p>
                    <Row label="양도 이익 합계" value={formatKrw(y.gainKrw.toFixed(0))} />
                    <Row label="양도 손실 합계" value={formatKrw(y.lossKrw.toFixed(0))} />
                    <Row label="손익 통산" value={formatKrw(y.netKrw.toFixed(0))} />
                    <Row label="기본공제" value={formatKrw(y.deductionKrw.neg().toFixed(0))} />
                    <Row label="과세표준" value={formatKrw(y.taxableKrw.toFixed(0))} />
                    <Row label="소득세 (20%)" value={formatKrw(y.incomeTaxKrw.toFixed(0))} />
                    <Row label="지방소득세 (2%)" value={formatKrw(y.localTaxKrw.toFixed(0))} />
                    <div className="border-t border-stone-200 pt-1.5 dark:border-stone-800">
                      <Row label="예상 세액" value={formatKrw(y.totalTaxKrw.toFixed(0))} strong />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {report.mode === "actual" && report.engine.deemed.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-semibold">의제취득가 적용 (2026년 말 보유분)</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums">
                  <thead className="text-left text-xs text-stone-500">
                    <tr className="border-b border-stone-200 dark:border-stone-800">
                      <th className="py-2 pr-4 font-medium">자산</th>
                      <th className="py-2 pr-4 text-right font-medium">수량</th>
                      <th className="py-2 pr-4 text-right font-medium">실제 취득가</th>
                      <th className="py-2 pr-4 text-right font-medium">2026년 말 시가</th>
                      <th className="py-2 text-right font-medium">적용 취득가</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.engine.deemed.map((d) => (
                      <tr key={d.asset} className="border-b border-stone-100 dark:border-stone-900">
                        <td className="py-1.5 pr-4">{d.asset}</td>
                        <td className="py-1.5 pr-4 text-right">{formatAmount(d.qty.toString())}</td>
                        <td className="py-1.5 pr-4 text-right">{formatKrw(d.actualCostKrw.toFixed(0))}</td>
                        <td className="py-1.5 pr-4 text-right">{d.fairValueKrw ? formatKrw(d.fairValueKrw.toFixed(0)) : "아직 없음"}</td>
                        <td className="py-1.5 text-right">{formatKrw(d.appliedCostKrw.toFixed(0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-stone-500">2026년 말 시가는 연말이 지나면 채워집니다. 그 전까지는 실제 취득가를 씁니다.</p>
            </section>
          )}

          {taxable.length > 0 && (
            <section className="space-y-2">
              <h3 className="font-semibold">양도 내역 ({taxable.length}건)</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums">
                  <thead className="text-left text-xs text-stone-500">
                    <tr className="border-b border-stone-200 dark:border-stone-800">
                      <th className="py-2 pr-4 font-medium">시각</th>
                      <th className="py-2 pr-4 font-medium">자산</th>
                      <th className="py-2 pr-4 text-right font-medium">수량</th>
                      <th className="py-2 pr-4 text-right font-medium">양도가</th>
                      <th className="py-2 pr-4 text-right font-medium">취득가</th>
                      <th className="py-2 text-right font-medium">손익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {taxable.slice(0, 200).map((d, i) => (
                      <tr key={`${d.ref}:${i}`} className="border-b border-stone-100 dark:border-stone-900">
                        <td className="whitespace-nowrap py-1.5 pr-4">{formatDateTime(d.time)}</td>
                        <td className="py-1.5 pr-4">
                          {d.asset}
                          {d.ref.endsWith(":gas") || d.proceedsKrw.isZero() ? <span className="text-xs text-stone-500"> 수수료</span> : null}
                        </td>
                        <td className="py-1.5 pr-4 text-right">{formatAmount(d.qty.toString())}</td>
                        <td className="py-1.5 pr-4 text-right">{formatKrw(d.proceedsKrw.toFixed(0))}</td>
                        <td className="py-1.5 pr-4 text-right">{formatKrw(d.costKrw.toFixed(0))}</td>
                        <td className={`py-1.5 text-right ${d.gainKrw.isNegative() ? "text-red-600" : "text-emerald-600"}`}>
                          {formatKrw(d.gainKrw.toFixed(0))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {taxable.length > 200 && <p className="text-xs text-stone-500">최근 200건만 표시합니다.</p>}
            </section>
          )}

          {(report.engine.warnings.length > 0 || report.built.unpriced.length > 0) && (
            <section className="space-y-1 text-sm">
              <h3 className="font-semibold">확인이 필요한 점</h3>
              {report.built.unpriced.length > 0 && (
                <p className="text-amber-700 dark:text-amber-400">
                  원화 시세를 찾지 못해 0원으로 계산한 항목 {report.built.unpriced.length}건 (
                  {[...new Set(report.built.unpriced.map((u) => u.pool))].slice(0, 8).join(", ")})
                </p>
              )}
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-stone-600 dark:text-stone-400">
                {report.engine.warnings.slice(0, 20).map((w, i) => (
                  <li key={i}>
                    {w.time ? `${formatDateTime(w.time)} · ` : ""}
                    {w.asset ? `${w.asset}: ` : ""}
                    {w.message}
                  </li>
                ))}
              </ul>
              {report.engine.warnings.length > 20 && (
                <p className="text-xs text-stone-500">외 {report.engine.warnings.length - 20}건</p>
              )}
            </section>
          )}

          <p className="text-xs leading-5 text-stone-500">
            예상 세액은 연결한 계정의 데이터와 현재 분류·정책에 따른 추정치입니다. 연결하지 않은 계정, 해석하지 못한
            DeFi 거래, 세법 해석이 정해지지 않은 항목(보상·에어드랍·브릿지 등)에 따라 실제 세액과 다를 수 있으니, 신고
            전에 세무 전문가의 검토를 받으세요. 시세 조회 {report.priceCount}건.
          </p>
        </>
      )}
    </div>
  );
}
