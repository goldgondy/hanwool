"use client";

import Link from "next/link";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { loadClassifiedGroups } from "@/lib/classify/load";
import { derivativeInfo } from "@/lib/derivatives";
import { PLANS, planOf, requiredPlan, requiredPlanFor, REVIEW_BASE, REVIEW_TIERS, reviewQuote, type PlanId } from "@/lib/plans";
import { Badge, btn, Callout, Card, PageHeader, Pill } from "@/components/ui";

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export default function PricingPage() {
  const [yearly, setYearly] = useState(false);
  const sources = useLiveQuery(() => db.sources.toArray(), []);
  // 세무사 검토 예상: 거래 건수(분류 묶음 수, 수수료만 있는 묶음 제외)와 선물·DeFi 여부
  const usage = useLiveQuery(async () => {
    const groups = await loadClassifiedGroups();
    return {
      transactions: groups.filter((g) => g.classification.category !== "fee_only").length,
      derivatives: groups.some((g) => g.entries.some((e) => derivativeInfo(e))),
      defi: groups.some((g) => g.classification.category === "defi_unsupported"),
    };
  }, []);
  const need: PlanId | null = sources ? requiredPlan(sources) : null;
  const quote = usage ? reviewQuote(usage.transactions, usage) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="요금제"
        description="쓰는 거래소와 지갑에 맞춰 고르세요. 국내 거래소만 쓰면 무료입니다. 세금 신고를 세무사에게 맡기고 싶으면 세무사 검토를 따로 신청할 수 있습니다."
      />
      <Callout tone="success" title="지금은 베타 기간이라 모든 기능이 무료입니다">
        정식 출시 후 아래 요금이 적용됩니다. 베타 기간에 연결한 계정과 기록은 그대로 이어집니다.
      </Callout>

      <div className="flex items-center gap-2">
        <Pill active={!yearly} onClick={() => setYearly(false)}>
          월 결제
        </Pill>
        <Pill active={yearly} onClick={() => setYearly(true)}>
          연 결제 <span className="text-xs opacity-80">2개월 할인</span>
        </Pill>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {PLANS.map((p) => {
          const mine = need === p.id;
          return (
            <Card key={p.id} className={`flex flex-col gap-4 ${mine ? "border-indigo-500 ring-2 ring-indigo-500/20" : ""}`}>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold">{p.name}</h2>
                  {mine && <Badge tone="info">내 연결 기준</Badge>}
                </div>
                <p className="text-sm text-stone-500">{p.summary}</p>
              </div>
              <div>
                {p.monthly === 0 ? (
                  <p className="text-3xl font-bold">무료</p>
                ) : yearly ? (
                  <>
                    <p className="text-3xl font-bold tabular-nums">
                      {won(p.yearly)}
                      <span className="text-base font-medium text-stone-500"> / 년</span>
                    </p>
                    <p className="text-xs text-stone-500">월 {won(Math.round(p.yearly / 12))}꼴 · 월 결제보다 {won(p.monthly * 12 - p.yearly)} 저렴</p>
                  </>
                ) : (
                  <p className="text-3xl font-bold tabular-nums">
                    {won(p.monthly)}
                    <span className="text-base font-medium text-stone-500"> / 월</span>
                  </p>
                )}
              </div>
              <ul className="flex-1 space-y-1.5 text-sm">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="text-emerald-600">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>

      {sources && sources.length > 0 && need && (
        <Card className="space-y-3">
          <h2 className="font-semibold">내 연결 계정 기준</h2>
          <p className="text-sm text-stone-500">
            지금 연결한 계정으로는 <b className="text-stone-900 dark:text-stone-100">{planOf(need).name}</b> 요금제가 필요합니다.
          </p>
          <ul className="flex flex-wrap gap-2">
            {sources.map((s) => (
              <li key={s.id}>
                <Badge tone={requiredPlanFor(s) === "domestic" ? "neutral" : requiredPlanFor(s) === "overseas" ? "info" : "warn"}>
                  {s.label} · {planOf(requiredPlanFor(s)).name}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="space-y-4 border-indigo-200 dark:border-indigo-900">
        <div className="space-y-1">
          <h2 className="text-lg font-bold">세무사 검토</h2>
          <p className="text-sm text-stone-500">
            현직 세무사가 연결한 기록과 분류를 검토하고 신고서를 확정합니다. 원하면 신고까지 대리합니다. 요금은 신고 1회 기준이며, 이용 중인 요금제와 별도입니다.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-left text-xs text-stone-500">
              <tr className="border-b border-stone-200 dark:border-stone-800">
                <th className="py-2 pr-3 font-medium">거래 건수</th>
                <th className="py-2 text-right font-medium">요금</th>
              </tr>
            </thead>
            <tbody>
              {REVIEW_TIERS.map((t) => (
                <tr key={t.label} className="border-b border-stone-100 last:border-0 dark:border-stone-800/60">
                  <td className="py-2 pr-3">{t.label}</td>
                  <td className="py-2 text-right">{t.upTo === null ? "개별 견적" : won(REVIEW_BASE + t.add)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-stone-500">선물·파생상품이나 DeFi 거래가 있으면 검토 범위가 넓어 개별 견적으로 안내합니다.</p>
        {quote && usage && usage.transactions > 0 && (
          <div className="rounded-xl bg-indigo-50 p-4 text-sm dark:bg-indigo-950/40">
            <p>
              내 기록: 거래 <b>{usage.transactions.toLocaleString("ko-KR")}건</b> ({quote.tierLabel})
            </p>
            <p className="mt-1 text-lg font-bold text-indigo-700 dark:text-indigo-300">
              {quote.price !== null ? `예상 검토 요금 ${won(quote.price)}` : `개별 견적 (${quote.needsQuote.join(", ")})`}
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <span className={`${btn()} cursor-not-allowed opacity-60`} title="정식 출시 후 열립니다">
            검토 신청 (준비 중)
          </span>
          <Link href="/calculator" className={btn("secondary")}>
            먼저 간이 계산해 보기
          </Link>
        </div>
      </Card>
    </div>
  );
}
