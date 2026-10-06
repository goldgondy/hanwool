"use client";

import Link from "next/link";
import { useState } from "react";
import Decimal from "@/lib/decimal";
import { db } from "@/lib/db";
import { foreignAccounts, monthEndQuantities, monthEnds, priceSymbol, REPORT_THRESHOLD_KRW, type ForeignAccount } from "@/lib/foreign";
import { formatDateTime, formatKrw } from "@/lib/format";
import { applyCsvCoverage } from "@/lib/ledger/dedup";
import { priceKey } from "@/lib/tax/build-events";
import { fetchPrices } from "@/lib/tax/calculate";
import { btn, Callout, Card, Empty, ErrorText, inputCls, PageHeader, Progress } from "@/components/ui";

interface Result {
  year: number;
  accounts: ForeignAccount[];
  months: { end: number; perAccount: (Decimal | null)[]; total: Decimal | null }[];
  warnings: string[];
}

async function compute(year: number, onProgress: (m: string) => void): Promise<Result> {
  onProgress("계정·원장 불러오는 중");
  const [sources, records, all] = await Promise.all([db.sources.toArray(), db.reconciliations.toArray(), db.ledger.toArray()]);
  const { entries } = applyCsvCoverage(all, sources);
  const accounts = foreignAccounts(sources, records);
  const ends = monthEnds(year);
  const quantities = accounts.map((a) => monthEndQuantities(a, entries, ends));
  const warnings: string[] = [];

  // 필요한 월말 시세만 모아 한 번에 조회
  const queries = new Map<string, { symbol: string; time: number }>();
  quantities.forEach((perMonth) =>
    perMonth.forEach((m, i) =>
      m?.forEach((v, key) => {
        if (v.qty.gt(0)) {
          const symbol = priceSymbol(key, v.asset);
          queries.set(priceKey(symbol, ends[i]), { symbol, time: ends[i] });
        }
      }),
    ),
  );
  const prices = await fetchPrices([...queries.values()], onProgress);

  const months = ends.map((end, i) => {
    let total: Decimal | null = null;
    const perAccount = accounts.map((a, j) => {
      const m = quantities[j][i];
      if (!m) return null;
      let sum = new Decimal(0);
      for (const [key, v] of m) {
        if (v.qty.lt(0)) {
          if (v.qty.abs().gt("0.00000001")) warnings.push(`${a.label} ${v.asset}: ${new Date(end).toISOString().slice(0, 7)} 말 잔고가 음수로 계산되어 0으로 봤습니다 (그 사이 기록이 빠졌을 수 있음).`);
          continue;
        }
        if (v.qty.isZero()) continue;
        const p = prices.get(priceKey(priceSymbol(key, v.asset), end));
        if (p) sum = sum.plus(v.qty.mul(p));
        else warnings.push(`${a.label} ${v.asset}: ${new Date(end).toISOString().slice(0, 7)} 말 시세가 없어 0원으로 봤습니다.`);
      }
      total = (total ?? new Decimal(0)).plus(sum);
      return sum;
    });
    return { end, perAccount, total };
  });
  return { year, accounts, months, warnings: [...new Set(warnings)] };
}

export default function ForeignPage() {
  const [thisYear] = useState(() => new Date(Date.now() + 9 * 3600_000).getUTCFullYear());
  const [year, setYear] = useState(thisYear - 1);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await compute(year, setProgress));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const peak = result?.months.reduce<{ end: number; total: Decimal } | null>((best, m) => (m.total && (!best || m.total.gt(best.total)) ? { end: m.end, total: m.total } : best), null);
  const over = peak?.total.gt(REPORT_THRESHOLD_KRW);
  const missing = result?.accounts.filter((a) => !a.anchor) ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        title="해외금융계좌 신고 확인"
        description={
          <>
            해외 거래소(바이낸스·OKX 등)에 둔 자산의 합계가 그해 <b>어느 달이든 말일에 5억원을 넘으면</b> 다음 해 6월에 해외금융계좌를 신고해야 합니다.
            연결한 해외 거래소 계정의 월말 잔고를 원화로 추정해 대상인지 알려 드립니다. 은행·증권 등 다른 해외계좌는 포함하지 않으니 함께 더해 판단하세요.
          </>
        }
      />

      <Card className="flex flex-wrap items-center gap-3">
        <select className={inputCls.replace("w-full", "w-auto")} value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[thisYear, thisYear - 1, thisYear - 2].map((y) => (
            <option key={y} value={y}>
              {y}년 ({y + 1}년 6월 신고분)
            </option>
          ))}
        </select>
        <button className={btn()} disabled={busy} onClick={run}>
          {busy ? "계산 중…" : "확인하기"}
        </button>
        <Progress text={progress} />
      </Card>
      <ErrorText>{error}</ErrorText>

      {result && (
        <>
          {result.accounts.length === 0 && <Empty>연결한 해외 거래소 계정이 없습니다.</Empty>}
          {missing.length > 0 && (
            <Callout tone="warn">
              {missing.map((a) => a.label).join(", ")}은(는) 아직 잔고 대사 결과가 없어 계산하지 못했습니다.{" "}
              <Link href="/reconcile" className="underline">
                잔고 대사
              </Link>
              를 먼저 실행하세요 (실제 잔고를 기준으로 과거 월말 잔고를 거꾸로 구합니다).
            </Callout>
          )}

          {peak && (
            <section
              className={`rounded-2xl border p-5 text-sm ${over ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40" : "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40"}`}
            >
              <p className="font-semibold">
                {result.year}년 월말 잔고 최대 {formatKrw(peak.total.toFixed(0))} ({new Date(peak.end).toISOString().slice(0, 7)} 말) →{" "}
                {over ? `5억원 초과: ${result.year + 1}년 6월 해외금융계좌 신고 대상으로 보입니다` : "5억원 이하: 연결한 해외 거래소 기준으로는 신고 대상이 아닙니다"}
              </p>
              <p className="mt-1 text-xs text-stone-600 dark:text-stone-400">
                신고 기준 금액은 계좌별 월말 잔액을 그날의 시세·환율로 환산한 합계입니다. 여기서는 월말 직전 1분 시세(업비트, 없으면 바이낸스 × 환율)로 추정했습니다.
                기준선 근처라면 세무 전문가와 함께 확인하세요.
              </p>
            </section>
          )}

          {result.accounts.length > 0 && (
            <Card className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead className="text-left text-xs text-stone-500">
                  <tr className="border-b border-stone-200 dark:border-stone-800">
                    <th className="py-2 pr-3 font-medium">월말</th>
                    {result.accounts.map((a) => (
                      <th key={a.key} className="py-2 pr-3 text-right font-medium">
                        {a.label}
                      </th>
                    ))}
                    <th className="py-2 text-right font-medium">합계</th>
                  </tr>
                </thead>
                <tbody>
                  {result.months.map((m) => (
                    <tr key={m.end} className="border-b border-stone-100 last:border-0 dark:border-stone-800/60">
                      <td className="py-1.5 pr-3">{new Date(m.end).toISOString().slice(0, 7)}</td>
                      {m.perAccount.map((v, i) => (
                        <td key={i} className="py-1.5 pr-3 text-right">
                          {v ? formatKrw(v.toFixed(0)) : "-"}
                        </td>
                      ))}
                      <td className={`py-1.5 text-right ${m.total?.gt(REPORT_THRESHOLD_KRW) ? "font-semibold text-red-600" : ""}`}>{m.total ? formatKrw(m.total.toFixed(0)) : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="pt-1 text-xs text-stone-500">
                &lsquo;-&rsquo;는 기준 잔고 대사 이후라 아직 계산할 수 없는 달입니다. 기준 대사:{" "}
                {result.accounts
                  .filter((a) => a.anchor)
                  .map((a) => `${a.label} ${formatDateTime(a.anchor!.at)}`)
                  .join(", ")}
              </p>
            </Card>
          )}

          {result.warnings.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-700 dark:text-amber-400">
              {result.warnings.slice(0, 15).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
