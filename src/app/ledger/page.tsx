"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type BinanceSource, type BtcSource, type CsvSource, type EvmChain, type EvmSource, type LedgerEntry, type OkxSource, type SolanaSource, type TronSource, type TonSource, type XapiSource, type XrpSource } from "@/lib/db";
import { fetchTonBalances, syncTonHistory } from "@/lib/ledger/ton-sync";
import { fetchXrpBalances, syncXrpHistory } from "@/lib/ledger/xrp-sync";
import { fetchSolanaBalances, syncSolanaHistory } from "@/lib/ledger/solana-sync";
import { syncOkxHistory } from "@/lib/ledger/okx-sync";
import { syncBinanceHistory } from "@/lib/ledger/binance-sync";
import { fetchBinanceBalances } from "@/lib/sources/binance";
import { fetchOkxBalances } from "@/lib/sources/okx";
import { fetchTronBalances, syncTronHistory } from "@/lib/ledger/tron-sync";
import { HISTORY_SUPPORTED, syncXapiHistory } from "@/lib/ledger/xapi-sync";
import { API_EXCHANGES, fetchXapiBalances } from "@/lib/sources/exchanges";
import { VaultPanel } from "@/components/VaultPanel";
import { formatAmount, formatDateTime } from "@/lib/format";
import { fetchBtcBalances, syncBtcHistory } from "@/lib/ledger/btc-sync";
import { syncEvmHistory } from "@/lib/ledger/evm-sync";
import { reconcile, type ReconcileRow } from "@/lib/ledger/reconcile";
import { EVM_CHAINS, fetchEvmBalances } from "@/lib/sources/evm";
import type { RawBalance } from "@/lib/sources/types";
import { btn, Callout, Card, Empty, ErrorText, PageHeader, Pill, Progress, trCls } from "@/components/ui";

type LedgerSource = EvmSource | BtcSource | TronSource | SolanaSource | XrpSource | TonSource | CsvSource | XapiSource | OkxSource | BinanceSource;
type SyncableSource = EvmSource | BtcSource | TronSource | SolanaSource | XrpSource | TonSource | XapiSource | OkxSource | BinanceSource;

// 동기화 결과 한 줄 (EVM은 체인별, 비트코인은 지갑 하나)
interface SyncLine {
  title: string;
  summary: string;
  alert?: string;
  notes: string[];
}

async function syncSource(source: SyncableSource, onProgress: (msg: string) => void): Promise<SyncLine[]> {
  if (source.kind === "tron") {
    const r = await syncTronHistory(source, onProgress);
    const notes = [...r.warnings];
    if (r.unknownTypes.length) notes.push(`처음 보는 거래 유형: ${r.unknownTypes.join(", ")}`);
    return [{ title: "Tron", summary: `새 항목 ${r.added}건 반영`, notes }];
  }
  if (source.kind === "solana") {
    const r = await syncSolanaHistory(source, onProgress);
    return [{ title: "Solana", summary: `새 항목 ${r.added}건 반영`, notes: r.warnings }];
  }
  if (source.kind === "ton") {
    const r = await syncTonHistory(source, onProgress);
    return [{ title: "TON", summary: `새 항목 ${r.added}건 반영`, notes: r.warnings }];
  }
  if (source.kind === "xrp") {
    const r = await syncXrpHistory(source, onProgress);
    return [{ title: "XRP", summary: `새 항목 ${r.added}건 반영`, notes: r.warnings }];
  }
  if (source.kind === "binance") {
    const r = await syncBinanceHistory(source, onProgress);
    return [{ title: "Binance", summary: `새 항목 ${r.added}건 반영`, notes: r.warnings }];
  }
  if (source.kind === "okx") {
    const r = await syncOkxHistory(source, onProgress);
    const notes = [...r.warnings];
    if (r.unknownTypes.length) notes.push(`처음 보는 유형(검토 필요로 들어감): ${r.unknownTypes.join(", ")}`);
    return [{ title: "OKX", summary: `새 항목 ${r.added}건 반영`, notes }];
  }
  if (source.kind === "xapi") {
    const r = await syncXapiHistory(source, onProgress);
    const notes = [...r.warnings];
    if (r.unknownTypes.length) notes.push(`처음 보는 유형(검토 필요로 들어감): ${r.unknownTypes.join(", ")}`);
    return [{ title: API_EXCHANGES[source.exchange].name, summary: `새 항목 ${r.added}건 반영`, notes }];
  }
  if (source.kind === "btc") {
    const r = await syncBtcHistory(source, onProgress);
    return [{ title: "Bitcoin", summary: `사용된 주소 ${r.addressCount}개, 항목 ${r.added}건 반영`, notes: r.warnings }];
  }
  const results = await syncEvmHistory(source, onProgress);
  return results.map((r) => {
    const gap = r.sentTxCount === null ? 0 : r.sentTxCount - r.gasRecordedCount;
    return {
      title: EVM_CHAINS[r.chain].name,
      summary: `항목 ${r.added}건 반영`,
      alert: gap > 0 ? `보낸 트랜잭션 ${r.sentTxCount}건 중 ${gap}건의 가스비가 원장에 없습니다` : undefined,
      notes: r.warnings,
    };
  });
}

function fetchBalances(source: SyncableSource, onProgress: (msg: string) => void): Promise<RawBalance[]> {
  if (source.kind === "xapi") return fetchXapiBalances(source);
  if (source.kind === "okx") return fetchOkxBalances(source);
  if (source.kind === "binance") return fetchBinanceBalances(source, () => {});
  if (source.kind === "tron") return fetchTronBalances(source);
  if (source.kind === "solana") return fetchSolanaBalances(source);
  if (source.kind === "xrp") return fetchXrpBalances(source);
  if (source.kind === "ton") return fetchTonBalances(source);
  return source.kind === "btc" ? fetchBtcBalances(source, onProgress) : fetchEvmBalances(source);
}

const KIND_LABEL: Record<LedgerEntry["kind"], string> = {
  trade: "스왑",
  transfer: "이체",
  fee: "수수료",
  income: "수익",
  other: "기타",
};

const button = btn();

function short(addr?: string) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "-";
}

function txUrl(e: LedgerEntry) {
  const chain = e.groupId.split(":")[0];
  if (!e.txHash) return undefined;
  if (chain === "btc") return `https://mempool.space/tx/${e.txHash}`;
  if (chain === "tron") return `https://tronscan.org/#/transaction/${e.txHash}`;
  if (chain === "sol") return `https://solscan.io/tx/${e.txHash}`;
  if (chain === "xrp") return `https://xrpscan.com/tx/${e.txHash}`;
  if (chain === "ton") return `https://tonviewer.com/transaction/${e.txHash}`;
  const evm = EVM_CHAINS[chain as EvmChain];
  return evm ? `${evm.explorer}/tx/${e.txHash}` : undefined;
}

function ReconcileTable({
  rows,
  selected,
  onSelect,
  synced,
}: {
  rows: ReconcileRow[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  synced: boolean; // 대조 직전에 내역을 동기화했는지
}) {
  const mismatches = rows.filter((r) => !r.diff.isZero()).length;
  return (
    <Card as="section" className="space-y-2">
      {mismatches > 0 && !synced && (
        <Callout tone="warn">
          마지막 동기화 이후에 새 거래가 생겼다면 그만큼 차이가 납니다. 먼저 <b>내역 동기화</b>로 최신 거래를 가져온 뒤 다시
          확인하세요.
        </Callout>
      )}
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
    </Card>
  );
}

function SourceLedger({ source }: { source: LedgerSource }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SyncLine[] | null>(null);
  const [rows, setRows] = useState<ReconcileRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);

  const entries = useLiveQuery(
    () => db.ledger.where("sourceId").equals(source.id).reverse().sortBy("time"),
    [source.id],
  );
  // 이 계정의 마지막 내역 동기화 시각 (체인별·종류별 동기화 상태 중 가장 최근)
  const lastSync = useLiveQuery(async () => {
    const states = await db.syncState.where("key").startsWith(`${source.id}:`).toArray();
    return states.length ? Math.max(...states.map((s) => s.syncedAt)) : null;
  }, [source.id]);
  const shown = (entries ?? []).filter((e) => !selected || e.assetKey === selected).slice(0, 300);

  async function run(withSync: boolean) {
    if (source.kind === "csv") return;
    setBusy(true);
    setError(null);
    try {
      if (withSync) setResults(await syncSource(source, setProgress));
      setProgress("실제 잔고 조회 중");
      const balances = await fetchBalances(source, setProgress);
      const all = await db.ledger.where("sourceId").equals(source.id).toArray();
      setRows(reconcile(all, balances));
      setSynced(withSync);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  return (
    <div className="space-y-6">
      {source.kind === "csv" ? (
        <div className="space-y-1 text-sm">
          <p className="text-stone-500">
            CSV로 가져온 계정입니다. 새 거래가 생기면 연결 계정 화면에서 파일을 다시 올리세요 (겹치는 거래는 자동으로 건너뜁니다).
            거래소 잔고를 직접 조회할 수 없어 잔고 대조는 하지 않습니다.
          </p>
          <ul className="text-xs text-stone-500">
            {source.imports.map((im, i) => (
              <li key={i}>
                {formatDateTime(im.at)} · {im.fileName} · {im.rows}줄 · 새 거래 {im.added}건
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {(source.kind === "xapi" || source.kind === "okx" || source.kind === "binance") && (
            <div className="w-full">
              <VaultPanel />
            </div>
          )}
          {!(source.kind === "xapi" && !HISTORY_SUPPORTED.has(source.exchange)) && (
            <button className={button} disabled={busy} onClick={() => run(true)}>
              {busy ? "처리 중…" : "내역 동기화"}
            </button>
          )}
          {source.kind === "xapi" && !HISTORY_SUPPORTED.has(source.exchange) && (
            <span className="text-sm text-stone-500">
              {API_EXCHANGES[source.exchange].name} 거래 내역 API는 준비 중입니다. 잔고 조회만 가능합니다.
            </span>
          )}
          <button className={btn("secondary")} disabled={busy} onClick={() => run(false)}>
            잔고 대조만
          </button>
          <span className="text-sm text-stone-500">
            {progress ? <Progress text={progress} /> : (lastSync ? `마지막 동기화 ${formatDateTime(lastSync)}` : lastSync === null ? "아직 동기화하지 않았습니다" : "")}
          </span>
        </div>
      )}
      <ErrorText>{error}</ErrorText>

      {results && (
        <ul className="space-y-1 text-sm">
          {results.map((r) => (
            <li key={r.title}>
              <b>{r.title}</b>: {r.summary}
              {r.alert && <span className="text-amber-700 dark:text-amber-400"> · {r.alert}</span>}
              {r.notes.map((w, i) => (
                <span key={i} className="block text-xs text-amber-700 dark:text-amber-400">
                  {w}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}

      {rows && <ReconcileTable rows={rows} selected={selected} onSelect={setSelected} synced={synced} />}

      <Card as="section" className="space-y-2">
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
                  <tr key={e.id} className={trCls}>
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
      </Card>
    </div>
  );
}

export default function LedgerPage() {
  const sources = useLiveQuery(() => db.sources.orderBy("createdAt").toArray(), []);
  const wallets = (sources ?? []).filter(
    (s): s is LedgerSource => s.kind === "evm" || s.kind === "btc" || s.kind === "tron" || s.kind === "solana" || s.kind === "xrp" || s.kind === "ton" || s.kind === "csv" || s.kind === "xapi" || s.kind === "okx" || s.kind === "binance",
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = wallets.find((s) => s.id === activeId) ?? wallets[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="거래 원장"
        description="계정 하나씩 모든 입출금·거래·수수료 기록을 보고, 그 계정만 따로 동기화하거나 잔고를 맞춰 볼 수 있습니다. 전체를 한 번에 하려면 2단계 ‘동기화·잔고 대사’를 쓰세요."
      />

      {sources && wallets.length === 0 && <Empty>계정 연결에서 지갑이나 거래소를 먼저 추가하세요.</Empty>}

      {wallets.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {wallets.map((s) => (
            <Pill key={s.id} active={s.id === active?.id} onClick={() => setActiveId(s.id)}>
              {s.label}{" "}
              <span className="opacity-60">
                {s.kind === "evm" || s.kind === "tron" || s.kind === "solana" || s.kind === "xrp" ? short(s.address) : s.kind === "ton" ? short(s.display ?? s.address) : s.kind === "btc" ? "₿" : s.kind === "csv" ? "CSV" : "API"}
              </span>
            </Pill>
          ))}
        </div>
      )}

      {active && <SourceLedger key={active.id} source={active} />}
    </div>
  );
}
