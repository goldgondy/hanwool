"use client";

import Link from "next/link";
import { useState } from "react";
import Decimal from "@/lib/decimal";
import { db } from "@/lib/db";
import { dailyTotals, summarizeDerivatives, type DerivativePart, type DerivativeRow } from "@/lib/derivatives";
import { formatAmount, formatKrw } from "@/lib/format";
import { applyCsvCoverage } from "@/lib/ledger/dedup";
import { priceKey } from "@/lib/tax/build-events";
import { fetchPrices } from "@/lib/tax/calculate";
import { btn, Callout, Card, Empty, ErrorText, inputCls, PageHeader, Progress, Stat } from "@/components/ui";

const PARTS: { key: DerivativePart; label: string }[] = [
  { key: "pnl", label: "실현 손익" },
  { key: "funding", label: "펀딩비" },
  { key: "fee", label: "거래 수수료" },
];

interface Result {
  year: number | null;
  years: number[];
  rows: DerivativeRow[];
  krw: Map<string, Record<DerivativePart, Decimal>>; // `${거래소}|${코인}` → 원화 추정
  months: { month: string; net: Decimal }[];
  unpriced: number;
}

const won = (d: Decimal) => formatKrw(d.toFixed(0));
const tone = (d: Decimal) => (d.isNegative() ? "text-red-600" : d.isZero() ? "" : "text-emerald-600");
const zero = () => ({ pnl: new Decimal(0), funding: new Decimal(0), fee: new Decimal(0) });

async function load(year: number | null, onProgress: (m: string) => void): Promise<Result> {
  onProgress("원장 불러오는 중");
  const [all, sources] = await Promise.all([db.ledger.toArray(), db.sources.toArray()]);
  const { entries } = applyCsvCoverage(all, sources);
  const { rows, years } = summarizeDerivatives(entries, year);
  const days = [...dailyTotals(entries, year).values()];
  const queries = new Map<string, { symbol: string; time: number }>();
  for (const d of days) queries.set(priceKey(d.asset, d.dayEnd), { symbol: d.asset, time: d.dayEnd });
  const prices = await fetchPrices([...queries.values()], onProgress);

  const krw = new Map<string, Record<DerivativePart, Decimal>>();
  const months = new Map<string, Decimal>();
  let unpriced = 0;
  for (const d of days) {
    const p = prices.get(priceKey(d.asset, d.dayEnd));
    if (!p) {
      unpriced++;
      continue;
    }
    const v = d.amount.mul(p);
    const k = `${d.exchange}|${d.asset}`;
    const cur = krw.get(k) ?? zero();
    cur[d.part] = cur[d.part].plus(v);
    krw.set(k, cur);
    const month = new Date(d.dayEnd + 9 * 3600_000).toISOString().slice(0, 7);
    months.set(month, (months.get(month) ?? new Decimal(0)).plus(v));
  }
  return { year, years, rows, krw, months: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, net]) => ({ month, net })), unpriced };
}

export default function DerivativesPage() {
  const [year, setYear] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function run(y: number | null = year) {
    setBusy(true);
    setError(null);
    try {
      setResult(await load(y, setProgress));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const total = result ? [...result.krw.values()].reduce((s, r) => ({ pnl: s.pnl.plus(r.pnl), funding: s.funding.plus(r.funding), fee: s.fee.plus(r.fee) }), zero()) : null;
  const net = total ? total.pnl.plus(total.funding).plus(total.fee) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="선물 손익"
        description="거래소 선물·무기한 계약에서 생긴 실현 손익, 펀딩비, 거래 수수료를 거래소별로 모아 보여 줍니다. 원화는 날마다 그날 마지막 시세로 환산한 추정치입니다."
      />
      <Callout tone="warn" title="세금 계산에는 아직 들어가지 않습니다">
        선물 손익을 가상자산 소득으로 볼지, 해외파생상품 양도소득으로 따로 과세할지, 과세 대상이 아닌지 정해지지 않아 세금 계산에서는 빼 두었습니다. 이
        화면의 금액은 판단과 상담을 위한 참고 자료입니다.
      </Callout>

      <Card className="flex flex-wrap items-center gap-3">
        <select
          className={inputCls.replace("w-full", "w-auto")}
          value={year ?? ""}
          onChange={(e) => {
            const y = e.target.value ? Number(e.target.value) : null;
            setYear(y);
            if (result) void run(y);
          }}
        >
          <option value="">전체 기간</option>
          {(result?.years ?? []).map((y) => (
            <option key={y} value={y}>
              {y}년
            </option>
          ))}
        </select>
        <button className={btn()} disabled={busy} onClick={() => run()}>
          {busy ? "계산 중…" : result ? "다시 계산" : "집계하기"}
        </button>
        <Progress text={progress} />
      </Card>
      <ErrorText>{error}</ErrorText>

      {result && result.rows.length === 0 && (
        <Empty>
          선물 기록이 없습니다. 선물을 거래한 거래소를{" "}
          <Link href="/sources" className="font-medium text-indigo-600 underline">
            계정 연결
          </Link>
          에서 API로 연결하고 동기화하세요 (바이낸스·OKX·바이비트·비트겟·게이트·MEXC 지원).
        </Empty>
      )}

      {result && total && net && result.rows.length > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="실현 손익" value={<span className={tone(total.pnl)}>{won(total.pnl)}</span>} />
            <Stat label="펀딩비" value={<span className={tone(total.funding)}>{won(total.funding)}</span>} hint="받으면 +, 내면 −" />
            <Stat label="거래 수수료" value={<span className={tone(total.fee)}>{won(total.fee)}</span>} />
            <Stat label={`순손익${result.year ? ` (${result.year}년)` : ""}`} value={<span className={tone(net)}>{won(net)}</span>} tone="info" />
          </div>

          <Card className="overflow-x-auto">
            <h2 className="pb-3 font-semibold">거래소·정산 코인별</h2>
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs text-stone-500">
                <tr className="border-b border-stone-200 dark:border-stone-800">
                  <th className="py-2 pr-3 font-medium">거래소</th>
                  <th className="py-2 pr-3 font-medium">정산 코인</th>
                  {PARTS.map((p) => (
                    <th key={p.key} className="py-2 pr-3 text-right font-medium">
                      {p.label}
                    </th>
                  ))}
                  <th className="py-2 text-right font-medium">순손익 (원화 추정)</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => {
                  const k = result.krw.get(`${r.exchange}|${r.asset}`) ?? zero();
                  const n = k.pnl.plus(k.funding).plus(k.fee);
                  return (
                    <tr key={`${r.exchange}|${r.asset}`} className="border-b border-stone-100 last:border-0 dark:border-stone-800/60">
                      <td className="py-2 pr-3">{r.exchange}</td>
                      <td className="py-2 pr-3">
                        {r.asset} <span className="text-xs text-stone-400">{r.count}건</span>
                      </td>
                      {PARTS.map((p) => (
                        <td key={p.key} className={`py-2 pr-3 text-right ${tone(r[p.key])}`}>
                          {formatAmount(r[p.key].toDecimalPlaces(8).toString())}
                          <span className="block text-xs text-stone-400">{won(k[p.key])}</span>
                        </td>
                      ))}
                      <td className={`py-2 text-right font-semibold ${tone(n)}`}>{won(n)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {result.months.length > 1 && (
            <Card className="overflow-x-auto">
              <h2 className="pb-3 font-semibold">월별 순손익 (원화 추정)</h2>
              <table className="w-full text-sm tabular-nums">
                <tbody>
                  {result.months.map((m) => (
                    <tr key={m.month} className="border-b border-stone-100 last:border-0 dark:border-stone-800/60">
                      <td className="py-1.5 pr-3">{m.month}</td>
                      <td className={`py-1.5 text-right ${tone(m.net)}`}>{won(m.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-stone-500">
            <li>거래소마다 손익을 기록하는 방식이 달라, 바이비트·OKX 일부 기록은 실현 손익에 수수료가 함께 들어 있을 수 있습니다.</li>
            <li>미실현 손익(아직 정리하지 않은 포지션)은 포함하지 않습니다. 계정 사이 이동(현물 ↔ 선물)은 손익이 아니라 제외했습니다.</li>
            {result.unpriced > 0 && <li className="text-amber-700 dark:text-amber-400">시세를 찾지 못한 날 {result.unpriced}건은 원화 추정에서 빠졌습니다.</li>}
          </ul>
        </>
      )}
    </div>
  );
}
