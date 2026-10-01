"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import type { GroupView } from "@/lib/classify/classifier";
import { loadClassifiedGroups } from "@/lib/classify/load";
import { CATEGORY_LABEL, USER_SELECTABLE, type Category, type ClassificationStatus } from "@/lib/classify/types";
import { formatAmount, formatDateTime } from "@/lib/format";
import { EVM_CHAINS } from "@/lib/sources/evm";
import type { EvmChain } from "@/lib/db";

const STATUS: Record<ClassificationStatus, { label: string; cls: string }> = {
  needs_review: { label: "검토 필요", cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  suggested: { label: "추정", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  confirmed: { label: "확정", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  user: { label: "사용자 지정", cls: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
};

type Filter = "todo" | ClassificationStatus | "all";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "todo", label: "검토할 것" },
  { key: "needs_review", label: "검토 필요" },
  { key: "suggested", label: "추정" },
  { key: "confirmed", label: "확정" },
  { key: "user", label: "사용자 지정" },
  { key: "all", label: "전체" },
];

const input = "rounded-lg border border-stone-300 bg-transparent px-2 py-1 text-sm dark:border-stone-700";

function txUrl(groupKey: string) {
  const [chain, hash] = groupKey.split(":");
  if (!hash) return undefined;
  if (chain === "btc") return `https://mempool.space/tx/${hash}`;
  if (chain === "tron") return `https://tronscan.org/#/transaction/${hash}`;
  if (chain === "sol") return hash === "reward" ? undefined : `https://solscan.io/tx/${hash}`;
  const evm = EVM_CHAINS[chain as EvmChain];
  return evm ? `${evm.explorer}/tx/${hash}` : undefined;
}

function GroupCard({ group, sourceLabels }: { group: GroupView; sourceLabels: Map<string, string> }) {
  const c = group.classification;
  const [category, setCategory] = useState<Category>(c.category);
  const [costKrw, setCostKrw] = useState(c.decision?.costKrw ?? "");
  const [note, setNote] = useState(c.decision?.note ?? "");
  const changed = category !== c.category || costKrw !== (c.decision?.costKrw ?? "") || note !== (c.decision?.note ?? "");

  async function save(cat: Category = category) {
    await db.decisions.put({
      key: group.key,
      category: cat,
      costKrw: cat === "external_in" && costKrw.trim() ? costKrw.replace(/[,\s원₩]/g, "") : undefined,
      note: note.trim() || undefined,
      decidedAt: Date.now(),
    });
  }

  const url = txUrl(group.key);

  return (
    <li className="space-y-3 rounded-xl border border-stone-200 p-4 dark:border-stone-800">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS[c.status].cls}`}>{STATUS[c.status].label}</span>
        <span className="font-semibold">{CATEGORY_LABEL[c.category]}</span>
        <span className="text-stone-500">{c.reason}</span>
        <span className="ml-auto text-xs tabular-nums text-stone-500">
          {formatDateTime(group.time)}
          {url && (
            <>
              {" · "}
              <a href={url} target="_blank" rel="noreferrer" className="underline">
                tx
              </a>
            </>
          )}
        </span>
      </div>

      <table className="w-full text-sm tabular-nums">
        <tbody>
          {group.entries.map((e) => (
            <tr key={e.id} className="border-t border-stone-100 dark:border-stone-900">
              <td className="py-1 pr-3">{sourceLabels.get(e.sourceId) ?? "?"}</td>
              <td className="py-1 pr-3 text-stone-500">{e.location}</td>
              <td className="py-1 pr-3">{e.kind === "fee" ? `${e.asset} (수수료)` : e.asset}</td>
              <td className={`py-1 text-right ${e.amount.startsWith("-") ? "text-red-600" : "text-emerald-600"}`}>
                {e.amount.startsWith("-") ? "" : "+"}
                {formatAmount(e.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex flex-wrap items-center gap-2">
        <select className={input} value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          {!USER_SELECTABLE.includes(c.category) && <option value={c.category}>{CATEGORY_LABEL[c.category]}</option>}
          {USER_SELECTABLE.map((k) => (
            <option key={k} value={k}>
              {CATEGORY_LABEL[k]}
            </option>
          ))}
        </select>
        {category === "external_in" && (
          <input className={`${input} w-40`} value={costKrw} onChange={(e) => setCostKrw(e.target.value)} placeholder="취득가 (원, 선택)" inputMode="numeric" />
        )}
        <input className={`${input} min-w-40 flex-1`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="메모 (예: 친구 A에게 선물)" />
        {c.status === "suggested" && !changed && (
          <button onClick={() => save(c.category)} className="rounded-lg border border-stone-300 px-3 py-1 text-sm dark:border-stone-700">
            맞아요
          </button>
        )}
        {changed && (
          <button onClick={() => save()} className="rounded-lg bg-stone-900 px-3 py-1 text-sm text-white dark:bg-stone-100 dark:text-stone-900">
            저장
          </button>
        )}
        {c.status === "user" && (
          <button onClick={() => db.decisions.delete(group.key)} className="text-xs text-stone-500 underline">
            자동 분류로 되돌리기
          </button>
        )}
      </div>
      {category === "external_in" && (
        <p className="text-xs text-stone-500">취득가를 비워 두면 0원으로 계산합니다 (세금이 가장 크게 나오는 쪽).</p>
      )}
    </li>
  );
}

export default function ReviewPage() {
  const groups = useLiveQuery(loadClassifiedGroups, []);
  const sources = useLiveQuery(() => db.sources.toArray(), []);
  const [filter, setFilter] = useState<Filter>("todo");

  const sourceLabels = new Map((sources ?? []).map((s) => [s.id, s.label]));
  const count = (s: ClassificationStatus) => groups?.filter((g) => g.classification.status === s).length ?? 0;
  const shown = (groups ?? []).filter((g) => {
    const s = g.classification.status;
    if (filter === "all") return true;
    if (filter === "todo") return s === "needs_review" || s === "suggested";
    return s === filter;
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">거래 분류 검토</h2>
        <p className="text-sm text-stone-500">
          원장의 거래마다 세금 관점의 분류를 붙입니다. 앱이 확실히 판단한 것은 &lsquo;확정&rsquo;, 추측한 것은
          &lsquo;추정&rsquo;, 알 수 없는 것은 &lsquo;검토 필요&rsquo;로 표시합니다. 직접 정한 분류는 다시 동기화해도
          유지됩니다.
        </p>
      </div>

      {groups && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["needs_review", "suggested", "confirmed", "user"] as ClassificationStatus[]).map((s) => (
            <div key={s} className="rounded-xl border border-stone-200 p-3 dark:border-stone-800">
              <p className="text-xs text-stone-500">{STATUS[s].label}</p>
              <p className="text-2xl font-bold tabular-nums">{count(s)}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3 py-1 text-sm ${
              filter === f.key
                ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900"
                : "border-stone-300 dark:border-stone-700"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {groups?.length === 0 && (
        <p className="text-sm text-stone-500">원장이 비어 있습니다. 원장 화면에서 먼저 내역을 동기화하세요.</p>
      )}
      {groups && groups.length > 0 && shown.length === 0 && (
        <p className="text-sm text-stone-500">이 조건에 해당하는 거래가 없습니다.</p>
      )}

      <ul className="space-y-3">
        {shown.slice(0, 200).map((g) => (
          <GroupCard key={`${g.key}:${g.classification.status}:${g.classification.category}`} group={g} sourceLabels={sourceLabels} />
        ))}
      </ul>
      {shown.length > 200 && <p className="text-xs text-stone-500">최근 200건만 표시합니다.</p>}
    </div>
  );
}
