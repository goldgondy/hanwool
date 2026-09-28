"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type EvmChain, type EvmSource, type LedgerEntry } from "@/lib/db";
import { formatAmount, formatDateTime } from "@/lib/format";
import { syncEvmHistory, type ChainSyncResult } from "@/lib/ledger/evm-sync";
import { reconcile, type ReconcileRow } from "@/lib/ledger/reconcile";
import { EVM_CHAINS, fetchEvmBalances } from "@/lib/sources/evm";

const KIND_LABEL: Record<LedgerEntry["kind"], string> = {
  trade: "스왑",
  transfer: "이체",
  fee: "수수료",
  income: "수익",
  other: "기타",
};

const button =
  "rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900";

function short(addr?: string) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "-";
}

function txUrl(e: LedgerEntry) {
  const chain = e.groupId.split(":")[0] as EvmChain;
  return e.txHash && EVM_CHAINS[chain] ? `${EVM_CHAINS[chain].explorer}/tx/${e.txHash}` : undefined;
}

function ReconcileTable({
  rows,
  selected,
  onSelect,
}: {
  rows: ReconcileRow[];
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const mismatches = rows.filter((r) => !r.diff.isZero()).length;
  return (
    <section className="space-y-2">
      <h3 className="font-semibold">
        수량 대사{" "}
        <span className={mismatches ? "text-red-600" : "text-emerald-600"}>
          {mismatches ? `불일치 ${mismatches}건` : "모두 일치"}
        </span>
      </h3>
      <p className="text-xs text-stone-500">
        원장 합계와 현재 실제 잔고를 비교합니다. 차이가 양수면 원장에 입금이, 음수면 출금이 빠진
        것입니다. 행을 누르면 해당 자산의 원장만 봅니다.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-stone-500">
            <tr className="border-b border-stone-200 dark:border-stone-800">
              <th className="py-2 pr-4 font-medium">체인</th>
              <th className="py-2 pr-4 font-medium">자산</th>
              <th className="py-2 pr-4 text-right font-medium">원장 합계</th>
              <th className="py-2 pr-4 text-right font-medium">실제 잔고</th>
              <th className="py-2 text-right font-medium">차이</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr
                key={r.assetKey}
                onClick={() => onSelect(selected === r.assetKey ? null : r.assetKey)}
                className={`cursor-pointer border-b border-stone-100 hover:bg-stone-100 dark:border-stone-900 dark:hover:bg-stone-900 ${
                  selected === r.assetKey ? "bg-stone-100 dark:bg-stone-900" : ""
                }`}
              >
                <td className="py-2 pr-4">{r.location}</td>
                <td className="py-2 pr-4">
                  {r.asset}
                  <span className="block font-mono text-xs text-stone-500">
                    {r.assetKey.split(":")[1] === "native" ? "native" : short(r.assetKey.split(":")[1])}
                  </span>
                </td>
                <td className="py-2 pr-4 text-right">{formatAmount(r.ledger.toString())}</td>
                <td className="py-2 pr-4 text-right">{formatAmount(r.actual.toString())}</td>
                <td className={`py-2 text-right ${r.diff.isZero() ? "text-emerald-600" : "text-red-600"}`}>
                  {r.diff.isZero() ? "✓" : `${r.diff.gt(0) ? "+" : ""}${formatAmount(r.diff.toString())}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EvmLedger({ source }: { source: EvmSource }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ChainSyncResult[] | null>(null);
  const [rows, setRows] = useState<ReconcileRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const entries = useLiveQuery(
    () => db.ledger.where("sourceId").equals(source.id).reverse().sortBy("time"),
    [source.id],
  );
  const shown = (entries ?? []).filter((e) => !selected || e.assetKey === selected).slice(0, 300);

  async function run(withSync: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (withSync) setResults(await syncEvmHistory(source, setProgress));
      setProgress("실제 잔고 조회 중");
      const balances = await fetchEvmBalances(source);
      const all = await db.ledger.where("sourceId").equals(source.id).toArray();
      setRows(reconcile(all, balances));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button className={button} disabled={busy} onClick={() => run(true)}>
          {busy ? "처리 중…" : "내역 동기화"}
        </button>
        <button
          className="rounded-lg border border-stone-300 px-4 py-2 text-sm disabled:opacity-40 dark:border-stone-700"
          disabled={busy}
          onClick={() => run(false)}
        >
          잔고 대조만
        </button>
        <span className="text-sm text-stone-500">{progress}</span>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {results && (
        <ul className="space-y-1 text-sm">
          {results.map((r) => {
            const gap = r.sentTxCount === null ? 0 : r.sentTxCount - r.gasRecordedCount;
            return (
              <li key={r.chain}>
                <b>{EVM_CHAINS[r.chain].name}</b>: 항목 {r.added}건 반영
                {gap > 0 && (
                  <span className="text-amber-700 dark:text-amber-400">
                    {" "}
                    · 보낸 트랜잭션 {r.sentTxCount}건 중 {gap}건의 가스비가 원장에 없습니다
                  </span>
                )}
                {r.warnings.map((w, i) => (
                  <span key={i} className="block text-xs text-amber-700 dark:text-amber-400">
                    {w}
                  </span>
                ))}
              </li>
            );
          })}
        </ul>
      )}

      {rows && <ReconcileTable rows={rows} selected={selected} onSelect={setSelected} />}

      <section className="space-y-2">
        <h3 className="font-semibold">
          원장 {entries ? `(${entries.length}건${selected ? ", 필터 적용" : ""})` : ""}
        </h3>
        {entries?.length === 0 && (
          <p className="text-sm text-stone-500">아직 가져온 내역이 없습니다. 내역 동기화를 누르세요.</p>
        )}
        {shown.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-stone-500">
                <tr className="border-b border-stone-200 dark:border-stone-800">
                  <th className="py-2 pr-4 font-medium">시각</th>
                  <th className="py-2 pr-4 font-medium">체인</th>
                  <th className="py-2 pr-4 font-medium">유형</th>
                  <th className="py-2 pr-4 font-medium">자산</th>
                  <th className="py-2 pr-4 text-right font-medium">수량</th>
                  <th className="py-2 font-medium">상대방 / Tx</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {shown.map((e) => (
                  <tr key={e.id} className="border-b border-stone-100 dark:border-stone-900">
                    <td className="py-1.5 pr-4 whitespace-nowrap">{formatDateTime(e.time)}</td>
                    <td className="py-1.5 pr-4">{e.location}</td>
                    <td className="py-1.5 pr-4">{KIND_LABEL[e.kind]}</td>
                    <td className="py-1.5 pr-4">{e.asset}</td>
                    <td className={`py-1.5 pr-4 text-right ${e.amount.startsWith("-") ? "text-red-600" : "text-emerald-600"}`}>
                      {e.amount.startsWith("-") ? "" : "+"}
                      {formatAmount(e.amount)}
                    </td>
                    <td className="py-1.5 font-mono text-xs">
                      {short(e.counterparty)}{" "}
                      {txUrl(e) && (
                        <a href={txUrl(e)} target="_blank" rel="noreferrer" className="text-stone-500 underline">
                          tx
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {entries && shown.length < (selected ? entries.filter((e) => e.assetKey === selected).length : entries.length) && (
              <p className="pt-2 text-xs text-stone-500">최근 300건만 표시합니다.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export default function LedgerPage() {
  const sources = useLiveQuery(() => db.sources.orderBy("createdAt").toArray(), []);
  const evm = (sources ?? []).filter((s): s is EvmSource => s.kind === "evm");
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = evm.find((s) => s.id === activeId) ?? evm[0];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">원장</h2>
        <p className="text-sm text-stone-500">
          연결한 계정의 모든 입출금·스왑·수수료 내역입니다. 현재는 EVM 지갑을 지원하며, 거래소는 준비
          중입니다.
        </p>
      </div>

      {sources && evm.length === 0 && (
        <p className="text-sm text-stone-500">연결 계정에서 EVM 지갑을 먼저 추가하세요.</p>
      )}

      {evm.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {evm.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveId(s.id)}
              className={`rounded-full border px-3 py-1 text-sm ${
                s.id === active?.id
                  ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
                  : "border-stone-300 dark:border-stone-700"
              }`}
            >
              {s.label} {short(s.address)}
            </button>
          ))}
        </div>
      )}

      {active && <EvmLedger key={active.id} source={active} />}
    </div>
  );
}
