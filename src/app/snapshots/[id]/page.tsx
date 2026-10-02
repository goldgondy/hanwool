"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type Holding } from "@/lib/db";
import { formatAmount, formatDateTime, formatKrw } from "@/lib/format";
import { btn, Callout, Card, Table, td, th, trCls } from "@/components/ui";

function HoldingTable({ rows }: { rows: Holding[] }) {
  return (
    <Table>
        <thead>
          <tr className="border-b border-stone-200 dark:border-stone-800">
            <th className={th}>계정 / 위치</th>
            <th className={th}>자산</th>
            <th className={`${th} text-right`}>수량</th>
            <th className={`${th} text-right`}>원화 단가</th>
            <th className={`${th} text-right`}>평가액</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h, i) => (
            <tr key={i} className={trCls}>
              <td className={td}>
                {h.sourceLabel}
                <span className="block text-xs text-stone-500">{h.location}</span>
              </td>
              <td className={td}>
                {h.asset}
                {h.rawAsset !== h.asset && (
                  <span className="block max-w-48 truncate font-mono text-xs text-stone-500" title={h.rawAsset}>
                    {h.rawAsset}
                  </span>
                )}
              </td>
              <td className={`${td} text-right`}>{formatAmount(h.amount)}</td>
              <td className={`${td} text-right`}>
                {formatKrw(h.priceKrw)}
                {h.priceVia && h.priceVia !== "Upbit" && (
                  <span className="block text-xs text-stone-500">{h.priceVia}</span>
                )}
              </td>
              <td className={`${td} text-right`}>{formatKrw(h.valueKrw)}</td>
            </tr>
          ))}
        </tbody>
    </Table>
  );
}

export default function SnapshotPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  // undefined = 로딩 중, null = 없음
  const snapshot = useLiveQuery(
    async () => (await db.snapshots.get(id)) ?? null,
    [id],
  );

  if (snapshot === undefined) {
    return <p className="text-sm text-stone-500">불러오는 중…</p>;
  }
  if (snapshot === null) {
    return <p className="text-sm text-stone-500">스냅샷을 찾을 수 없습니다.</p>;
  }

  const priced = snapshot.holdings.filter((h) => h.priceKrw !== null);
  const unpriced = snapshot.holdings.filter((h) => h.priceKrw === null);

  function exportJson() {
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `snapshot-${new Date(snapshot!.takenAt).toISOString().slice(0, 19)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function remove() {
    if (!window.confirm("이 스냅샷을 삭제할까요?")) return;
    await db.snapshots.delete(id);
    router.push("/snapshots");
  }

  return (
    <div className="space-y-8">
      <div className="no-print flex flex-wrap gap-2 text-sm">
        <Link href="/snapshots" className="mr-auto text-stone-500 hover:underline">
          ← 보유 기록
        </Link>
        <button onClick={() => window.print()} className={btn("secondary", "sm")}>
          인쇄 / PDF 저장
        </button>
        <button onClick={exportJson} className={btn("secondary", "sm")}>
          JSON 내보내기
        </button>
        <button onClick={remove} className={btn("danger", "sm")}>
          삭제
        </button>
      </div>

      <header className="space-y-1">
        <h1 className="text-2xl font-bold">가상자산 보유 내역 기록</h1>
        <p className="text-sm text-stone-500">
          조회 시각 {formatDateTime(snapshot.takenAt)} (KST) · 시세 출처{" "}
          {snapshot.priceSource}
        </p>
        <p className="pt-2 text-3xl font-bold tabular-nums">
          {formatKrw(snapshot.totalKrw)}
        </p>
      </header>

      {snapshot.errors.length > 0 && (
        <Callout tone="danger" title="일부 계정이나 항목을 조회하지 못했습니다. 해당 부분은 이 기록에 포함되지 않았습니다.">
          <ul className="list-disc pl-5">
            {snapshot.errors.map((e, i) => (
              <li key={i}>
                {e.sourceLabel}: {e.message}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <Card>
        <HoldingTable rows={priced} />
      </Card>

      {unpriced.length > 0 && (
        <Card as="section" className="space-y-2">
          <h2 className="font-semibold">원화 시세를 찾지 못한 자산 ({unpriced.length})</h2>
          <p className="text-xs text-stone-500">
            업비트에 상장되지 않은 토큰입니다. 수량은 기록되었으며, 스팸 토큰일 수
            있습니다. 평가액 합계에서는 제외됩니다.
          </p>
          <HoldingTable rows={unpriced} />
        </Card>
      )}

      <p className="text-xs leading-5 text-stone-500">
        이 기록은 조회 시점의 거래소 API 응답과 온체인 잔고를 기준으로 사용자가
        직접 생성한 참고 자료입니다. 원화 평가액은 업비트 현재가 기준 근사치이며,
        세법상 의제취득가액 산정 기준과 다를 수 있습니다.
      </p>
    </div>
  );
}
