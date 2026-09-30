"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, isExchangeKind } from "@/lib/db";
import { takeSnapshot } from "@/lib/snapshot";
import { DEEMED_COST_DEADLINE, formatDateTime, formatKrw } from "@/lib/format";
import { useVaultUnlocked, VaultPanel } from "@/components/VaultPanel";

function daysLeft() {
  return Math.max(0, Math.ceil((DEEMED_COST_DEADLINE - Date.now()) / 86_400_000));
}

// 서버 렌더링 시점의 날짜로 고정되지 않도록 클라이언트에서만 계산한다.
const noopSubscribe = () => () => {};

function useDaysLeft() {
  return useSyncExternalStore(noopSubscribe, daysLeft, () => null);
}

export default function Home() {
  const sources = useLiveQuery(() => db.sources.toArray(), []);
  const snapshots = useLiveQuery(
    () => db.snapshots.orderBy("takenAt").reverse().toArray(),
    [],
  );
  const days = useDaysLeft();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const unlocked = useVaultUnlocked();
  const noSources = sources !== undefined && sources.length === 0;
  const hasExchange = sources?.some((s) => isExchangeKind(s.kind)) ?? false;
  const needsUnlock = hasExchange && !unlocked;

  return (
    <div className="space-y-10">
      <section className="rounded-xl border border-amber-300 bg-amber-50 p-6 dark:border-amber-700 dark:bg-amber-950/40">
        <p className="text-sm text-amber-800 dark:text-amber-300">
          의제취득가 기준일 (2026년 12월 31일)까지
        </p>
        <p className="mt-1 text-4xl font-bold tabular-nums">D-{days ?? "…"}</p>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-stone-600 dark:text-stone-400">
          2026년 말 이전에 보유한 가상자산은 <b>2026년 말 시가</b>와{" "}
          <b>실제 취득가액</b> 중 큰 금액을 취득가로 인정받을 수 있습니다. 해외
          거래소와 개인 지갑 보유분은 스스로 입증해야 하므로, 연말 보유 내역을
          미리 기록해 두세요.
        </p>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">보유 자산 스냅샷</h2>
          <button
            onClick={onSnapshot}
            disabled={busy || noSources || needsUnlock || sources === undefined}
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
          >
            {busy ? "조회 중…" : "지금 스냅샷 찍기"}
          </button>
        </div>

        {hasExchange && <VaultPanel />}

        {noSources && (
          <p className="text-sm text-stone-500">
            먼저{" "}
            <Link href="/sources" className="underline">
              연결 계정
            </Link>
            에서 바이낸스 API 키나 지갑 주소를 추가하세요.
          </p>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {snapshots && snapshots.length > 0 && (
          <ul className="divide-y divide-stone-200 rounded-xl border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
            {snapshots.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/snapshots/${s.id}`}
                  className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3 hover:bg-stone-100 dark:hover:bg-stone-900"
                >
                  <span className="tabular-nums">{formatDateTime(s.takenAt)}</span>
                  <span className="text-sm text-stone-500">
                    {s.holdings.length}개 항목
                  </span>
                  {s.errors.length > 0 && (
                    <span className="text-sm text-red-600">
                      오류 {s.errors.length}건
                    </span>
                  )}
                  <span className="ml-auto font-semibold tabular-nums">
                    {formatKrw(s.totalKrw)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {snapshots && snapshots.length === 0 && !noSources && (
          <p className="text-sm text-stone-500">아직 찍은 스냅샷이 없습니다.</p>
        )}
      </section>
    </div>
  );
}
