"use client";

import Link from "next/link";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import Decimal from "@/lib/decimal";
import { db, isExchangeKind, type ReconciliationRecord } from "@/lib/db";
import { formatAmount, formatDateTime } from "@/lib/format";
import type { ReconcileRow } from "@/lib/ledger/reconcile";
import { buildAccounts } from "@/lib/reconcile/accounts";
import { judgeDiff, type DiffKind } from "@/lib/reconcile/diff";
import { applyAdjustment, ignoreDiff, ignoredDiffs, runReconciliation } from "@/lib/reconcile/run";
import { VaultPanel } from "@/components/VaultPanel";

type Row = ReconciliationRecord["rows"][number];

const toRow = (r: Row): ReconcileRow => ({
  assetKey: r.assetKey,
  asset: r.asset,
  location: r.location,
  ledger: new Decimal(r.ledger),
  actual: new Decimal(r.actual),
  diff: new Decimal(r.diff),
  entryCount: 0,
});

const KIND_CLS: Record<DiffKind, string> = {
  match: "text-emerald-700 dark:text-emerald-400",
  rebasing_gain: "text-sky-700 dark:text-sky-400",
  unexplained_gain: "text-amber-700 dark:text-amber-400",
  unexplained_loss: "text-red-600",
};

const smallBtn = "rounded-lg border border-stone-300 px-2.5 py-1 text-xs dark:border-stone-700";
const primaryBtn = "rounded-lg bg-stone-900 px-2.5 py-1 text-xs text-white dark:bg-stone-100 dark:text-stone-900";

function DiffRow({ record, row, onDone }: { record: ReconciliationRecord; row: Row; onDone: () => void }) {
  const j = judgeDiff(toRow(row));
  const [cost, setCost] = useState("");
  const [askCost, setAskCost] = useState(false);
  const gain = j.kind === "rebasing_gain" || j.kind === "unexplained_gain";
  const amount = new Decimal(row.diff);

  async function act(fn: () => Promise<void>) {
    await fn();
    onDone();
  }

  return (
    <li className="space-y-2 border-t border-stone-100 py-3 text-sm dark:border-stone-900">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">{row.asset}</span>
        <span className="text-xs text-stone-500">{row.location}</span>
        <span className={`text-xs font-medium ${KIND_CLS[j.kind]}`}>{j.title}</span>
        <span className="ml-auto tabular-nums">
          원장 {formatAmount(row.ledger)} · 실제 {formatAmount(row.actual)} ·{" "}
          <b className={KIND_CLS[j.kind]}>
            {amount.gt(0) ? "+" : ""}
            {formatAmount(row.diff)}
          </b>
        </span>
      </div>
      <p className="text-xs text-stone-500">{j.suggestion}</p>
      <div className="flex flex-wrap items-center gap-2">
        {gain && (
          <>
            <button
              className={j.kind === "rebasing_gain" ? primaryBtn : smallBtn}
              onClick={() => act(() => applyAdjustment(record, row, "reward", "잔고 대사: 기록되지 않은 보상"))}
            >
              보상으로 처리{j.kind === "rebasing_gain" ? " (추천)" : ""}
            </button>
            {!askCost ? (
              <button className={smallBtn} onClick={() => setAskCost(true)}>
                외부에서 받음으로 처리
              </button>
            ) : (
              <>
                <input
                  className="w-36 rounded-lg border border-stone-300 bg-transparent px-2 py-1 text-xs dark:border-stone-700"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder="취득가 (원, 선택)"
                  inputMode="numeric"
                />
                <button
                  className={primaryBtn}
                  onClick={() =>
                    act(() =>
                      applyAdjustment(record, row, "external_in", "잔고 대사: 기록되지 않은 입금", cost.replace(/[,\s원₩]/g, "") || undefined),
                    )
                  }
                >
                  저장
                </button>
              </>
            )}
          </>
        )}
        {!gain && (
          <button className={smallBtn} onClick={() => act(() => applyAdjustment(record, row, "external_out", "잔고 대사: 기록되지 않은 출금·손실"))}>
            외부로 보냄으로 처리
          </button>
        )}
        <button className="text-xs text-stone-500 underline" onClick={() => act(() => ignoreDiff(record, row))}>
          무시
        </button>
      </div>
    </li>
  );
}

export default function ReconcilePage() {
  const records = useLiveQuery(() => db.reconciliations.toArray(), []);
  const sources = useLiveQuery(() => db.sources.toArray(), []);
  const ignored = useLiveQuery(async () => ignoredDiffs(await db.reconciliations.toArray()), [records]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [handled, setHandled] = useState<Set<string>>(new Set());

  const csvOnly = sources ? buildAccounts(sources).csvOnly : [];
  const hasExchange = sources?.some((s) => isExchangeKind(s.kind)) ?? false;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await runReconciliation(setProgress);
      setHandled(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const isZero = (row: Row) => new Decimal(row.diff).isZero();
  const open = (r: ReconciliationRecord) =>
    r.rows.filter((row) => !isZero(row) && !ignored?.has(`${r.key}:${row.assetKey}`) && !handled.has(`${r.key}:${row.assetKey}`));
  const all = (records ?? []).filter((r) => r.status === "ok");
  const counts = all.flatMap((r) => open(r).map((row) => judgeDiff(toRow(row)).kind));
  const matched = all.reduce((n, r) => n + r.rows.filter(isZero).length, 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">잔고 대사</h2>
        <p className="text-sm text-stone-500">
          거래 내역으로 계산한 잔고와 실제 잔고를 계정·자산별로 비교합니다. 모두 일치하면 빠진 거래가 없다는 가장 강력한
          근거가 되고, 차이가 있으면 놓친 보상·입출금·손실이 있다는 신호입니다.
        </p>
      </div>

      {hasExchange && <VaultPanel />}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={busy}
          className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
        >
          {busy ? "대사 중…" : "전체 대사 실행"}
        </button>
        <span className="text-sm text-stone-500">{progress}</span>
        {records && records.length > 0 && !busy && (
          <span className="text-xs text-stone-400">마지막 실행 {formatDateTime(Math.max(...records.map((r) => r.at)))}</span>
        )}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {all.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["일치", matched, "text-emerald-700 dark:text-emerald-400"],
            ["리베이스 증가", counts.filter((k) => k === "rebasing_gain").length, "text-sky-700 dark:text-sky-400"],
            ["설명되지 않는 증가", counts.filter((k) => k === "unexplained_gain").length, "text-amber-700 dark:text-amber-400"],
            ["설명되지 않는 감소", counts.filter((k) => k === "unexplained_loss").length, "text-red-600"],
          ].map(([label, n, cls]) => (
            <div key={label as string} className="rounded-xl border border-stone-200 p-3 dark:border-stone-800">
              <p className="text-xs text-stone-500">{label}</p>
              <p className={`text-2xl font-bold tabular-nums ${cls}`}>{n}</p>
            </div>
          ))}
        </div>
      )}

      {records?.length === 0 && <p className="text-sm text-stone-500">아직 대사를 실행하지 않았습니다.</p>}

      <ul className="space-y-4">
        {(records ?? []).map((r) => {
          const diffs = open(r);
          return (
            <li key={r.key} className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="font-semibold">{r.label}</h3>
                {r.status === "ok" && (
                  <span className={`text-sm ${diffs.length ? "text-red-600" : "text-emerald-600"}`}>
                    {diffs.length ? `차이 ${diffs.length}건` : "모두 일치"} · 자산 {r.rows.length}개
                  </span>
                )}
              </div>
              {r.status === "no_history" && (
                <p className="mt-1 text-sm text-stone-500">
                  거래 내역이 없어 대사할 수 없습니다. 원장 화면에서 내역을 동기화하거나, 같은 거래소의 CSV를 &lsquo;같은 계정&rsquo;으로
                  연결하세요.
                </p>
              )}
              {r.status === "error" && <p className="mt-1 text-sm text-red-600">{r.error}</p>}
              {diffs.length > 0 && (
                <ul className="mt-2">
                  {diffs.map((row) => (
                    <DiffRow
                      key={row.assetKey}
                      record={r}
                      row={row}
                      onDone={() => setHandled((h) => new Set(h).add(`${r.key}:${row.assetKey}`))}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {csvOnly.length > 0 && (
        <section className="rounded-xl border border-stone-200 p-4 text-sm dark:border-stone-800">
          <p className="font-medium">대사할 수 없는 CSV 계정</p>
          <p className="mt-1 text-stone-500">
            실제 잔고를 조회할 방법이 없습니다. 같은 거래소의 API 키를 추가하고{" "}
            <Link href="/sources" className="underline">
              연결 계정
            </Link>
            에서 &lsquo;같은 계정&rsquo;으로 연결하면 대사할 수 있습니다: {csvOnly.map((c) => c.label).join(", ")}
          </p>
        </section>
      )}

      {handled.size > 0 && (
        <p className="text-xs text-stone-500">
          처리한 차이는 조정 항목으로 원장에 추가되었습니다. 다시 대사하면 일치로 표시되고,{" "}
          <Link href="/review" className="underline">
            분류 검토
          </Link>
          와 세금 계산에도 반영됩니다.
        </p>
      )}
    </div>
  );
}
