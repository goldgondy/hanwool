"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, isExchangeKind } from "@/lib/db";
import { takeSnapshot } from "@/lib/snapshot";
import { loadReadiness, type Readiness } from "@/lib/readiness";
import { DEEMED_COST_DEADLINE, formatDateTime, formatKrw } from "@/lib/format";
import { useVaultUnlocked, VaultPanel } from "@/components/VaultPanel";
import { Badge, btn, Callout, Card, ErrorText } from "@/components/ui";

function daysLeft() {
  return Math.max(0, Math.ceil((DEEMED_COST_DEADLINE - Date.now()) / 86_400_000));
}

// 서버 렌더링 시점의 날짜로 고정되지 않도록 클라이언트에서만 계산한다.
const noopSubscribe = () => () => {};

function useDaysLeft() {
  return useSyncExternalStore(noopSubscribe, daysLeft, () => null);
}

type State = "done" | "warn" | "todo";

interface Step {
  n: number;
  title: string;
  href: string;
  state: State;
  detail: string;
  action: string;
}

function steps(r: Readiness): Step[] {
  const { reconcile, review } = r;
  return [
    {
      n: 1,
      title: "계정 연결",
      href: "/sources",
      state: r.sources === 0 ? "todo" : r.missingFiles.length ? "warn" : "done",
      detail:
        r.sources === 0
          ? "거래소 API 키, 지갑 주소, 거래내역 파일을 연결하세요"
          : r.missingFiles.length
            ? `빠진 파일: ${r.missingFiles.slice(0, 2).join(", ")}${r.missingFiles.length > 2 ? ` 외 ${r.missingFiles.length - 2}개` : ""}`
            : `거래소·지갑 ${r.sources}개 연결됨`,
      action: r.sources === 0 ? "연결하기" : r.missingFiles.length ? "파일 올리기" : "계정 추가",
    },
    {
      n: 2,
      title: "동기화·잔고 대사",
      href: "/reconcile",
      state: !reconcile.ran ? "todo" : reconcile.open > 0 ? "warn" : "done",
      detail: !reconcile.ran
        ? "최신 내역을 가져와 실제 잔고와 맞는지 확인합니다"
        : reconcile.open > 0
          ? `설명되지 않은 차이 ${reconcile.open}건 · 마지막 ${formatDateTime(reconcile.lastAt!)}`
          : `모두 일치 · 마지막 ${formatDateTime(reconcile.lastAt!)}`,
      action: !reconcile.ran ? "대사 실행" : reconcile.open > 0 ? "차이 확인" : "다시 대사",
    },
    {
      n: 3,
      title: "분류 검토",
      href: "/review",
      state: review.total === 0 ? "todo" : review.needsReview > 0 ? "warn" : "done",
      detail:
        review.total === 0
          ? "거래 내역을 가져오면 자동으로 분류합니다"
          : review.needsReview > 0
            ? `검토 필요 ${review.needsReview}건${review.suggested ? ` · 추정 ${review.suggested}건` : ""}`
            : `거래 ${review.total}건 분류 완료${review.suggested ? ` (추정 ${review.suggested}건 확인 권장)` : ""}`,
      action: review.needsReview > 0 ? "검토하기" : "살펴보기",
    },
    {
      n: 4,
      title: "세금 계산·신고",
      href: "/tax",
      state: "todo",
      detail: "연도별 세액, 신고용 엑셀, 홈택스 입력 안내",
      action: "계산하기",
    },
  ];
}

const DOT: Record<State, string> = {
  done: "bg-emerald-500 text-white",
  warn: "bg-amber-400 text-white",
  todo: "bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-300",
};

function StepRow({ s, next }: { s: Step; next: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-4 py-4 first:pt-0 last:pb-0">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${DOT[s.state]}`}>
        {s.state === "done" ? "✓" : s.state === "warn" ? "!" : s.n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-semibold">
          {s.title}
          {next && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">다음 할 일</span>}
        </p>
        <p className={`text-sm ${s.state === "warn" ? "text-amber-700 dark:text-amber-400" : "text-stone-500"}`}>{s.detail}</p>
      </div>
      <Link href={s.href} className={btn(next ? "primary" : "secondary", "sm")}>
        {s.action} →
      </Link>
    </li>
  );
}

export default function Home() {
  const readiness = useLiveQuery(loadReadiness, []);
  const sources = useLiveQuery(() => db.sources.toArray(), []);
  const days = useDaysLeft();
  const unlocked = useVaultUnlocked();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasExchange = sources?.some((s) => isExchangeKind(s.kind)) ?? false;
  const list = readiness ? steps(readiness) : [];
  const checks = list.slice(0, 3);
  const nextStep = list.find((s) => s.state !== "done")?.n;
  const percent = checks.length ? Math.round((checks.filter((s) => s.state === "done").length / checks.length) * 100) : 0;
  const beforeTax = days !== null && days > 0;

  async function onSnapshot() {
    setBusy(true);
    setError(null);
    try {
      await takeSnapshot();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">가상자산 세금 준비</h1>
        <p className="text-sm text-stone-500">2027년부터 가상자산 소득에 22% 세금이 붙습니다. 아래 순서대로 진행하면 2028년 5월 신고 자료가 준비됩니다.</p>
      </div>

      {readiness?.backup.stale && (
        <Callout tone="warn" title={readiness.backup.lastAt ? "백업한 지 30일이 넘었습니다" : "아직 백업 파일이 없습니다"}>
          데이터는 이 브라우저에만 있어 브라우저 데이터를 지우면 사라집니다.{" "}
          <Link href="/backup" className="font-medium underline">
            백업 내려받기 →
          </Link>
        </Callout>
      )}

      <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
        {/* 기준일 카드 */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 p-6 text-white shadow-sm">
          {beforeTax || days === null ? (
            <>
              <p className="text-sm text-indigo-100">의제취득가 기준일 2026년 12월 31일까지</p>
              <p className="mt-1 text-5xl font-bold tabular-nums tracking-tight">D-{days ?? "…"}</p>
              <p className="mt-4 text-sm leading-6 text-indigo-50">
                연말에 가진 코인은 <b>실제 산 값과 2026년 말 시가 중 큰 금액</b>을 취득가로 인정받습니다. 해외 거래소·개인 지갑 보유분은 스스로
                입증해야 하니 연말 보유 내역을 기록해 두세요.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-indigo-100">과세 기간 진행 중</p>
              <p className="mt-1 text-3xl font-bold tracking-tight">2027년 거래는 2028년 5월 신고</p>
              <p className="mt-4 text-sm leading-6 text-indigo-50">일부 거래소는 기록을 1~3개월만 보관합니다. 한 달에 한 번은 동기화하세요.</p>
            </>
          )}
        </div>

        {/* 준비도 */}
        <Card className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">신고 준비도</h2>
            <span className="text-2xl font-bold tabular-nums text-indigo-600 dark:text-indigo-400">{readiness ? `${percent}%` : "…"}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
            <div className="h-full rounded-full bg-indigo-600 transition-all dark:bg-indigo-500" style={{ width: `${percent}%` }} />
          </div>
          <ol className="divide-y divide-stone-100 dark:divide-stone-800">
            {list.map((s) => (
              <StepRow key={s.n} s={s} next={s.n === nextStep} />
            ))}
          </ol>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">보유 기록</h2>
            <Link href="/snapshots" className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-stone-100">
              전체 보기 →
            </Link>
          </div>
          <p className="text-xs leading-5 text-stone-500">지금 모든 계정의 보유 수량과 원화 평가액을 기록합니다. 2026년 12월 31일에 한 번 꼭 남겨 두세요.</p>
          {readiness?.latestSnapshot ? (
            <Link
              href={`/snapshots/${readiness.latestSnapshot.id}`}
              className="flex items-center justify-between rounded-xl bg-stone-50 px-4 py-3 hover:bg-stone-100 dark:bg-stone-800/50 dark:hover:bg-stone-800"
            >
              <span className="text-sm text-stone-500">{formatDateTime(readiness.latestSnapshot.takenAt)}</span>
              <span className="text-lg font-bold tabular-nums">{formatKrw(readiness.latestSnapshot.totalKrw)}</span>
            </Link>
          ) : (
            <p className="rounded-xl bg-stone-50 px-4 py-3 text-sm text-stone-500 dark:bg-stone-800/50">아직 기록이 없습니다.</p>
          )}
          {hasExchange && !unlocked && <VaultPanel compact />}
          <button onClick={onSnapshot} disabled={busy || !sources?.length || (hasExchange && !unlocked)} className={btn("secondary")}>
            {busy ? "조회 중…" : "지금 기록하기"}
          </button>
          <ErrorText>{error}</ErrorText>
        </Card>

        <Card className="space-y-3">
          <h2 className="font-semibold">도구</h2>
          <ul className="space-y-2">
            {[
              ["/plan", "절세 도구", "연말 손실 정리, 남은 공제, 세금이 적은 매도 순서", "절세"],
              ["/foreign", "해외계좌 신고 확인", "해외 거래소 월말 잔고가 5억원을 넘었는지", "6월 신고"],
              ["/ledger", "거래 원장", "계정별 모든 입출금·거래 기록", ""],
            ].map(([href, title, desc, tag]) => (
              <li key={href}>
                <Link href={href} className="flex items-center gap-3 rounded-xl border border-stone-200 px-4 py-3 hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-stone-800 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/20">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{title}</p>
                    <p className="truncate text-xs text-stone-500">{desc}</p>
                  </div>
                  {tag && <Badge tone="info">{tag}</Badge>}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
