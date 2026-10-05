import Decimal from "@/lib/decimal";
import { db } from "@/lib/db";
import { loadClassifiedGroups } from "@/lib/classify/load";
import { ignoredDiffs } from "@/lib/reconcile/run";
import { missingFiles } from "@/lib/importers/kits";
import { lastBackupAt } from "@/lib/backup";

// 신고 준비 현황: 홈 화면의 단계별 점검과 메뉴의 표시에 쓴다.

export interface ReconcileStatus {
  ran: boolean;
  open: number; // 처리하지 않은 차이 (무시한 것 제외)
  lastAt: number | null;
}

export async function reconcileStatus(): Promise<ReconcileStatus> {
  const records = await db.reconciliations.toArray();
  const ignored = await ignoredDiffs(records);
  const open = records.flatMap((r) =>
    r.status === "ok" ? r.rows.filter((row) => !new Decimal(row.diff).isZero() && !ignored.has(`${r.key}:${row.assetKey}`)) : [],
  );
  return { ran: records.length > 0, open: open.length, lastAt: records.length ? Math.max(...records.map((r) => r.at)) : null };
}

export interface Readiness {
  sources: number;
  missingFiles: string[]; // 거래소 파일 준비 목록에서 빠진 파일 (예: "OKX (파일): 입금 내역")
  lastSync: number | null;
  reconcile: ReconcileStatus;
  review: { needsReview: number; suggested: number; total: number };
  latestSnapshot: { id: string; takenAt: number; totalKrw: string } | null;
  backup: { lastAt: number | null; stale: boolean }; // stale: 데이터가 있는데 백업이 없거나 30일 넘음
}

export async function loadReadiness(): Promise<Readiness> {
  const [sources, states, reconcile, groups, snapshot, lastBackup] = await Promise.all([
    db.sources.toArray(),
    db.syncState.toArray(),
    reconcileStatus(),
    loadClassifiedGroups(),
    db.snapshots.orderBy("takenAt").last(),
    lastBackupAt(),
  ]);
  return {
    sources: sources.length,
    missingFiles: missingFiles(sources),
    lastSync: states.length ? Math.max(...states.map((s) => s.syncedAt)) : null,
    reconcile,
    review: {
      needsReview: groups.filter((g) => g.classification.status === "needs_review").length,
      suggested: groups.filter((g) => g.classification.status === "suggested").length,
      total: groups.length,
    },
    latestSnapshot: snapshot ? { id: snapshot.id, takenAt: snapshot.takenAt, totalKrw: snapshot.totalKrw } : null,
    backup: { lastAt: lastBackup, stale: sources.length > 0 && (!lastBackup || Date.now() - lastBackup > 30 * 86_400_000) },
  };
}
