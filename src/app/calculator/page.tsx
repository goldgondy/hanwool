"use client";

import Link from "next/link";
import { useState } from "react";
import Decimal from "@/lib/decimal";
import { formatKrw } from "@/lib/format";
import { emptyCoin, quickCalculate, type QuickCoin } from "@/lib/tax/quick";
import { btn, Callout, Card, inputCls, PageHeader } from "@/components/ui";

const won = (d: Decimal) => formatKrw(d.toFixed(0));
const tone = (d: Decimal) => (d.isNegative() ? "text-red-600" : d.isZero() ? "" : "text-emerald-600");

function Field({ label, value, onChange, placeholder, suffix }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; suffix?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-stone-500">{label}</span>
      <div className="relative">
        <input className={`${inputCls} pr-9 text-right tabular-nums`} value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" placeholder={placeholder} />
        {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-stone-400">{suffix}</span>}
      </div>
    </label>
  );
}

function CoinCard({ coin, index, onChange, onRemove }: { coin: QuickCoin; index: number; onChange: (c: QuickCoin) => void; onRemove?: () => void }) {
  const set = (k: keyof QuickCoin) => (v: string) => onChange({ ...coin, [k]: v });
  return (
    <Card className="space-y-4">
      <div className="flex items-center gap-2">
        <input className={`${inputCls} max-w-48 font-semibold`} value={coin.name} onChange={(e) => onChange({ ...coin, name: e.target.value })} placeholder={`코인 ${index + 1} (예: BTC)`} />
        {onRemove && (
          <button type="button" onClick={onRemove} className={`${btn("ghost", "sm")} ml-auto`}>
            삭제
          </button>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2 rounded-xl bg-stone-50 p-3 dark:bg-stone-800/40">
          <p className="text-xs font-semibold text-stone-600 dark:text-stone-300">① 2026년 말에 가지고 있던 것</p>
          <Field label="수량" value={coin.holdQty} onChange={set("holdQty")} suffix="개" />
          <Field label="실제로 산 금액 합계" value={coin.holdCost} onChange={set("holdCost")} suffix="원" placeholder="모르면 0" />
          <Field label="2026년 12월 31일 시세 (1개당)" value={coin.holdPrice} onChange={set("holdPrice")} suffix="원" placeholder="예상 가격" />
        </div>
        <div className="space-y-2 rounded-xl bg-stone-50 p-3 dark:bg-stone-800/40">
          <p className="text-xs font-semibold text-stone-600 dark:text-stone-300">② 2027년에 산 것</p>
          <Field label="수량" value={coin.buyQty} onChange={set("buyQty")} suffix="개" />
          <Field label="산 금액 합계 (수수료 포함)" value={coin.buyCost} onChange={set("buyCost")} suffix="원" />
        </div>
        <div className="space-y-2 rounded-xl bg-stone-50 p-3 dark:bg-stone-800/40">
          <p className="text-xs font-semibold text-stone-600 dark:text-stone-300">③ 2027년에 판 것</p>
          <Field label="수량" value={coin.sellQty} onChange={set("sellQty")} suffix="개" />
          <Field label="판 금액 합계" value={coin.sellAmount} onChange={set("sellAmount")} suffix="원" />
          <Field label="팔 때 낸 수수료" value={coin.sellFee} onChange={set("sellFee")} suffix="원" />
        </div>
      </div>
    </Card>
  );
}

export default function CalculatorPage() {
  const [coins, setCoins] = useState<QuickCoin[]>([emptyCoin("BTC")]);
  const { engine, perCoin } = quickCalculate(coins);
  const y = engine.years[0];
  const warnings = [...new Set(engine.warnings.filter((w) => !w.message.includes("2026년 말 시가가 없어")).map((w) => w.message.replace(/\d+:/, "")))];

  return (
    <div className="space-y-6">
      <PageHeader
        title="가상자산 세금 간이 계산기"
        description="가입 없이 2027년 가상자산 양도소득세를 어림해 봅니다. 코인마다 합계 금액만 넣으면 법령대로(총평균법, 2026년 말 보유분 의제취득가, 250만 원 공제, 22%) 계산합니다. 입력한 값은 어디에도 저장되지 않습니다."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          {coins.map((c, i) => (
            <CoinCard
              key={i}
              coin={c}
              index={i}
              onChange={(next) => setCoins(coins.map((x, j) => (j === i ? next : x)))}
              onRemove={coins.length > 1 ? () => setCoins(coins.filter((_, j) => j !== i)) : undefined}
            />
          ))}
          <button type="button" className={btn("secondary")} onClick={() => setCoins([...coins, emptyCoin()])}>
            + 코인 추가
          </button>
        </div>

        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <Card className="space-y-3">
            <h2 className="font-semibold">2027년 예상 세금</h2>
            {perCoin.map((p, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-stone-500">
                  {p.name}
                  {p.deemedUsed && <span className="ml-1 text-xs text-indigo-600">의제취득가</span>}
                </span>
                <span className={`tabular-nums ${tone(p.gain)}`}>{won(p.gain)}</span>
              </div>
            ))}
            <div className="space-y-1.5 border-t border-stone-200 pt-3 text-sm dark:border-stone-800">
              <Row label="손익 합계 (통산)" value={y ? won(y.netKrw) : "₩0"} />
              <Row label="기본공제" value={y ? won(y.deductionKrw.neg()) : "₩0"} />
              <Row label="과세표준" value={y ? won(y.taxableKrw) : "₩0"} />
              <Row label="소득세 20% + 지방소득세 2%" value={y ? won(y.totalTaxKrw) : "₩0"} />
            </div>
            <div className="rounded-xl bg-indigo-50 p-3 text-center dark:bg-indigo-950/40">
              <p className="text-xs text-indigo-700 dark:text-indigo-300">예상 세액</p>
              <p className="text-3xl font-bold tabular-nums text-indigo-700 dark:text-indigo-300">{y ? won(y.totalTaxKrw) : "₩0"}</p>
            </div>
            {warnings.map((w) => (
              <p key={w} className="text-xs text-amber-700 dark:text-amber-400">
                {w}
              </p>
            ))}
          </Card>

          <Callout tone="info" title="실제 거래로 정확하게 계산하려면">
            거래소·지갑을 연결하면 모든 거래를 불러와 거래마다 시세를 찾고, 거래소 사이 이체와 수수료까지 반영해 계산합니다.{" "}
            <Link href="/sources" className="font-medium underline">
              계정 연결 →
            </Link>
          </Callout>
        </div>
      </div>

      <Card className="space-y-2 text-sm leading-6 text-stone-600 dark:text-stone-400">
        <h2 className="font-semibold text-stone-900 dark:text-stone-100">계산 방법</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <b>의제취득가</b>: 2026년 말에 가지고 있던 코인은 실제로 산 금액과 2026년 12월 31일 시세 중 <b>큰 금액</b>을 취득가로 봅니다 (소득세법 제37조).
          </li>
          <li>
            <b>총평균법</b>: 코인마다 (2026년 말 보유분 취득가 + 2027년에 산 금액) ÷ 전체 수량으로 그 해 평균단가를 내고, 판 수량에 곱해 원가로 씁니다 (소득세법
            시행령 제88조). 같은 해 안에서는 사고판 순서와 상관없습니다.
          </li>
          <li>코인끼리 이익과 손실을 합친 뒤(손익 통산) 250만 원을 빼고, 남은 금액에 소득세 20%와 지방소득세 2%를 매깁니다. 남은 손실은 다음 해로 넘어가지 않습니다.</li>
          <li>코인끼리 교환, 거래소 사이 이체, 보상·에어드랍, 선물은 이 계산기에 넣지 않습니다. 이런 거래가 있다면 계정을 연결해 계산하세요.</li>
        </ul>
        <p className="text-xs text-stone-500">참고용 추정치입니다. 실제 신고 전에는 세무 전문가와 확인하세요.</p>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-stone-500">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
