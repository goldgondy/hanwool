"use client";

import Link from "next/link";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import Decimal from "@/lib/decimal";
import { db } from "@/lib/db";
import { ignoredDiffs } from "@/lib/reconcile/run";
import { CATEGORY_LABEL } from "@/lib/classify/types";
import { formatAmount, formatDateTime, formatKrw } from "@/lib/format";
import { calculate, type Mode, type Report } from "@/lib/tax/calculate";

// 금액을 누르면 숫자만(쉼표 없이) 복사된다. 홈택스 입력칸에 그대로 붙여넣을 수 있다.
function Row({ label, value, strong, copy }: { label: string; value: string; strong?: boolean; copy?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`flex justify-between gap-4 ${strong ? "font-semibold" : ""}`}>
      <span className="text-stone-500">{label}</span>
      {copy ? (
        <button
          type="button"
          title="눌러서 복사"
          className="tabular-nums underline decoration-dotted underline-offset-4 hover:text-stone-900 dark:hover:text-stone-100"
          onClick={async () => {
            await navigator.clipboard.writeText(copy);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "복사됨" : value}
        </button>
      ) : (
        <span className="tabular-nums">{value}</span>
      )}
    </div>
  );
}

async function downloadReport(report: Report) {
  const { buildTaxWorkbook } = await import("@/lib/tax/report-xlsx");
  const blob = await buildTaxWorkbook(report);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `가상자산-세금-${report.mode === "simulate" ? "모의계산" : "신고자료"}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function TaxPage() {
  const [mode, setMode] = useState<Mode>("actual");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  // 최근 잔고 대사 결과: 설명되지 않은 차이가 있으면 세액이 틀릴 수 있다 (무시한 차이는 제외)
  const reconcile = useLiveQuery(async () => {
    const records = await db.reconciliations.toArray();
    const ignored = await ignoredDiffs(records);
    const open = records.flatMap((r) =>
      r.status === "ok" ? r.rows.filter((row) => !new Decimal(row.diff).isZero() && !ignored.has(`${r.key}:${row.assetKey}`)) : [],
    );
    return { ran: records.length > 0, open: open.length, lastAt: records.length ? Math.max(...records.map((r) => r.at)) : null };
  }, []);

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
          연결한 모든 계정의 원장과 분류를 바탕으로 연도별 양도손익과 예상 세액을 계산합니다. 스테이블코인과
          교환한 거래는 실제로 주고받은 금액을, 그 밖에는 거래 직전에 마감된 1분 캔들 종가(업비트, 없으면
          바이낸스 × 환율)를 원화 시세로 씁니다.
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

      {reconcile && (!reconcile.ran || reconcile.open > 0) && (
        <section className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm dark:border-red-800 dark:bg-red-950/40">
          {reconcile.ran ? (
            <p>
              <b>잔고 대사에서 설명되지 않은 차이 {reconcile.open}건</b>이 있습니다 (마지막 대사 {formatDateTime(reconcile.lastAt!)}).
              빠진 거래가 있으면 세액이 틀릴 수 있으니{" "}
              <Link href="/reconcile" className="underline">
                잔고 대사
              </Link>
              에서 먼저 확인하세요.
            </p>
          ) : (
            <p>
              아직 잔고 대사를 하지 않았습니다. 빠진 거래가 없는지{" "}
              <Link href="/reconcile" className="underline">
                잔고 대사
              </Link>
              로 먼저 확인하는 것을 권합니다.
            </p>
          )}
        </section>
      )}

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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">연도별 예상 세액{report.mode === "simulate" && " (모의)"}</h3>
              <button
                type="button"
                onClick={() => downloadReport(report).catch((e) => setError(e instanceof Error ? e.message : String(e)))}
                className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm dark:border-stone-700"
              >
                {report.mode === "simulate" ? "모의 계산 엑셀 내려받기" : "신고 자료 엑셀 내려받기"}
              </button>
            </div>
            <p className="text-xs text-stone-500">
              엑셀에는 신고요약(연도별)·자산별손익·양도명세·의제취득가·확인필요 시트가 들어 있습니다. 아래 금액을 누르면 숫자만 복사됩니다.
            </p>
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
                    <Row label="양도 이익 합계" value={formatKrw(y.gainKrw.toFixed(0))} copy={y.gainKrw.toFixed(0)} />
                    <Row label="양도 손실 합계" value={formatKrw(y.lossKrw.toFixed(0))} copy={y.lossKrw.toFixed(0)} />
                    <Row label="소득금액 (손익 통산)" value={formatKrw(y.netKrw.toFixed(0))} copy={y.netKrw.toFixed(0)} />
                    <Row label="기본공제" value={formatKrw(y.deductionKrw.neg().toFixed(0))} copy={y.deductionKrw.toFixed(0)} />
                    <Row label="과세표준" value={formatKrw(y.taxableKrw.toFixed(0))} copy={y.taxableKrw.toFixed(0)} />
                    <Row label="소득세 (20%)" value={formatKrw(y.incomeTaxKrw.toFixed(0))} copy={y.incomeTaxKrw.toFixed(0)} />
                    <Row label="지방소득세 (2%)" value={formatKrw(y.localTaxKrw.toFixed(0))} copy={y.localTaxKrw.toFixed(0)} />
                    <div className="border-t border-stone-200 pt-1.5 dark:border-stone-800">
                      <Row label="예상 세액" value={formatKrw(y.totalTaxKrw.toFixed(0))} strong copy={y.totalTaxKrw.toFixed(0)} />
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

          {report.mode === "actual" && report.engine.years.length > 0 && (
            <section className="space-y-2 rounded-xl border border-stone-200 p-4 text-sm dark:border-stone-800">
              <h3 className="font-semibold">신고하는 방법 (스스로 신고하는 경우)</h3>
              <ol className="list-decimal space-y-1 pl-5 text-stone-600 dark:text-stone-400">
                <li>
                  신고 기간: 과세 기간(1~12월) 다음 해 <b>5월 1일~31일</b>. 2027년에 판 코인은 2028년 5월에 신고합니다.
                </li>
                <li>먼저 잔고 대사와 분류 검토에서 남은 항목이 없는지 확인하고, 위 &lsquo;신고 자료 엑셀&rsquo;을 내려받아 보관하세요.</li>
                <li>홈택스(또는 손택스)에 로그인해 종합소득세 신고 메뉴에서 가상자산 소득(기타소득 분리과세) 신고 화면으로 들어갑니다.</li>
                <li>
                  위 연도별 카드의 금액(소득금액·기본공제·과세표준·세액)을 눌러 복사한 뒤 같은 이름의 칸에 붙여넣습니다. 거래 내역 첨부를 요구하면 엑셀의
                  양도명세 시트를 씁니다.
                </li>
                <li>납부할 세액을 확인하고 제출·납부합니다. 지방소득세(2%)는 위택스에서 함께 신고·납부합니다.</li>
              </ol>
              <p className="text-xs text-stone-500">
                ※ 2028년 5월이 첫 신고라 홈택스 화면과 서식은 아직 정해지지 않았습니다. 국세청 안내가 나오면 이 안내를 갱신합니다. 해외 거래소에 둔 자산이
                어느 달 말일이든 합계 5억원을 넘었다면, 매년 6월 해외금융계좌 신고 대상인지도 확인하세요.
              </p>
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
