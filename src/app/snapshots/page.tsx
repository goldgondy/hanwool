"use client";

import Link from "next/link";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, isExchangeKind } from "@/lib/db";
import { takeSnapshot } from "@/lib/snapshot";
import { formatDateTime, formatKrw } from "@/lib/format";
import { useVaultUnlocked, VaultPanel } from "@/components/VaultPanel";
import { Badge, btn, Card, Empty, ErrorText, PageHeader } from "@/components/ui";

export default function SnapshotsPage() {
  const sources = useLiveQuery(() => db.sources.toArray(), []);
  const snapshots = useLiveQuery(() => db.snapshots.orderBy("takenAt").reverse().toArray(), []);
  const unlocked = useVaultUnlocked();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noSources = sources !== undefined && sources.length === 0;
  const needsUnlock = (sources?.some((s) => isExchangeKind(s.kind)) ?? false) && !unlocked;

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
    <div className="space-y-6">
      <PageHeader
        title="보유 기록"
        description="조회 시점에 모든 계정이 가진 코인 수량과 원화 평가액을 기록합니다. 2026년 12월 31일 기록은 의제취득가와 연초 잔고를 입증하는 자료가 됩니다. 인쇄하거나 PDF로 저장할 수 있습니다."
        actions={
          <button onClick={onSnapshot} disabled={busy || noSources || needsUnlock || sources === undefined} className={btn()}>
            {busy ? "조회 중…" : "지금 기록하기"}
          </button>
        }
      />
      {needsUnlock && <VaultPanel />}
      <ErrorText>{error}</ErrorText>

      {noSources && (
        <Empty>
          먼저{" "}
          <Link href="/sources" className="font-medium text-indigo-600 underline">
            계정 연결
          </Link>
          에서 거래소나 지갑을 추가하세요.
        </Empty>
      )}
      {snapshots?.length === 0 && !noSources && <Empty>아직 남긴 기록이 없습니다.</Empty>}

      {snapshots && snapshots.length > 0 && (
        <Card className="p-0">
          <ul className="divide-y divide-stone-100 dark:divide-stone-800">
            {snapshots.map((s) => (
              <li key={s.id}>
                <Link href={`/snapshots/${s.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-4 hover:bg-stone-50 dark:hover:bg-stone-800/40">
                  <span className="tabular-nums">{formatDateTime(s.takenAt)}</span>
                  <span className="text-sm text-stone-500">{s.holdings.length}개 항목</span>
                  {s.errors.length > 0 && <Badge tone="danger">오류 {s.errors.length}건</Badge>}
                  <span className="ml-auto text-lg font-semibold tabular-nums">{formatKrw(s.totalKrw)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
