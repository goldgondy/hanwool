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
import { Badge, btn, Card, Empty, inputCls, PageHeader, Pill, Stat } from "@/components/ui";

const STATUS: Record<ClassificationStatus, { label: string; tone: "danger" | "warn" | "success" | "info" }> = {
  needs_review: { label: "검토 필요", tone: "danger" },
  suggested: { label: "추정", tone: "warn" },
  confirmed: { label: "확정", tone: "success" },
  user: { label: "사용자 지정", tone: "info" },
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

const input = `${inputCls} w-auto py-1.5`;

function txUrl(groupKey: string) {
  const [chain, hash] = groupKey.split(":");
  if (!hash) return undefined;
  if (chain === "btc") return `https://mempool.space/tx/${hash}`;
  if (chain === "ltc") return `https://litecoinspace.org/tx/${hash}`;
  if (chain === "tron") return `https://tronscan.org/#/transaction/${hash}`;
  if (chain === "sol") return hash === "reward" ? undefined : `https://solscan.io/tx/${hash}`;
  if (chain === "xrp") return `https://xrpscan.com/tx/${hash}`;
  if (chain === "aptos") return undefined; // 묶음 키는 거래 버전 번호
  if (chain === "ton") return undefined; // TON 묶음 키는 처리 흐름(trace) ID라 거래 링크가 아니다
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
    <Card as="li" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
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
            <tr key={e.id} className="border-t border-stone-100 dark:border-stone-800">
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
          <button onClick={() => save(c.category)} className={btn("secondary")}>
            맞아요
          </button>
        )}
        {changed && (
          <button onClick={() => save()} className={btn()}>
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
    </Card>
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
      <PageHeader
        step={3}
        title="분류 검토"
        description={
          <>
            거래마다 세금 관점의 분류를 붙입니다. 확실한 것은 &lsquo;확정&rsquo;, 추측한 것은 &lsquo;추정&rsquo;, 알 수 없는 것은 &lsquo;검토 필요&rsquo;로
            표시합니다. <b>검토 필요</b>만 처리하면 되고, 직접 정한 분류는 다시 동기화해도 유지됩니다.
          </>
        }
      />

      {groups && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["needs_review", "suggested", "confirmed", "user"] as ClassificationStatus[]).map((s) => (
            <Stat key={s} label={STATUS[s].label} value={count(s)} tone={s === "needs_review" && count(s) > 0 ? "danger" : s === "suggested" && count(s) > 0 ? "warn" : "neutral"} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Pill key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </Pill>
        ))}
      </div>

      {groups?.length === 0 && <Empty>거래 내역이 없습니다. 2단계 &lsquo;동기화·잔고 대사&rsquo;에서 먼저 내역을 가져오세요.</Empty>}
      {groups && groups.length > 0 && shown.length === 0 && <Empty>이 조건에 해당하는 거래가 없습니다.</Empty>}

      <ul className="space-y-3">
        {shown.slice(0, 200).map((g) => (
          <GroupCard key={`${g.key}:${g.classification.status}:${g.classification.category}`} group={g} sourceLabels={sourceLabels} />
        ))}
      </ul>
      {shown.length > 200 && <p className="text-xs text-stone-500">최근 200건만 표시합니다.</p>}
    </div>
  );
}
