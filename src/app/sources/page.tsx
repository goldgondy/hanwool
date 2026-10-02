"use client";

import { useState, type FormEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, exchangeIdOf, getSetting, isExchangeKind, setSetting, type BtcSource, type CsvSource, type EvmChain, type LedgerEntry, type Source } from "@/lib/db";
import { ADAPTERS, detect, detectRows, PLANNED_EXCHANGES } from "@/lib/importers";
import { KITS, kitStatus, partsOf, type KitRow, type PartState } from "@/lib/importers/kits";
import { decodeText } from "@/lib/importers/csv";
import { isOldXls, isXlsx, readXlsxRows } from "@/lib/importers/xlsx";
import { parseUpbitPaste, upbitHistory } from "@/lib/importers/upbit";
import { buildManualEntries, MANUAL_TYPES, validateManual, type ManualInput, type ManualType } from "@/lib/manual";
import { formatDateTime } from "@/lib/format";
import { API_EXCHANGES, type ApiExchange } from "@/lib/sources/exchanges";
import type { CsvAdapter, CsvTable, ImportResult } from "@/lib/importers/types";
import { detectActiveChains, EVM_CHAINS, type ChainActivity } from "@/lib/sources/evm";
import { discoverWallets, requestAddresses, type WalletDetail } from "@/lib/wallet/eip6963";
import { isTronAddress } from "@/lib/tron/address";
import { isSolanaAddress } from "@/lib/solana/address";
import { deriveAddress, parseWalletInput, SCRIPT_LABEL, type ScriptType } from "@/lib/btc/descriptor";
import { DEFAULT_ESPLORA } from "@/lib/btc/esplora";
import { DEFAULT_GAP_LIMIT } from "@/lib/btc/scan";
import { encrypt } from "@/lib/vault";
import { useVaultUnlocked, VaultPanel } from "@/components/VaultPanel";
import { Badge, btn, Card, Empty, inputCls, PageHeader, Pill } from "@/components/ui";

const input = inputCls;
const button = btn();
// 입력 양식은 "계정 추가" 카드 안에 들어가므로 테두리 없이 간격만 둔다
const card = "space-y-3";

function mask(s: string) {
  return s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function LockedHint({ unlocked }: { unlocked: boolean }) {
  if (unlocked) return null;
  return <p className="text-xs text-amber-700 dark:text-amber-400">위에서 잠금을 해제해야 추가할 수 있습니다.</p>;
}

// 같은 거래소 API 키를 두 번 등록하면 잔고가 이중으로 잡힌다.
async function exchangeKeyExists(kind: "binance" | "okx", apiKey: string) {
  return (await db.sources.toArray()).some((s) => s.kind === kind && s.apiKey === apiKey.trim());
}

function BinanceForm() {
  const unlocked = useVaultUnlocked();
  const [label, setLabel] = useState("Binance");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [dup, setDup] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const exists = await exchangeKeyExists("binance", apiKey);
    setDup(exists);
    if (exists) return;
    await db.sources.add({
      id: crypto.randomUUID(),
      kind: "binance",
      label: label.trim() || "Binance",
      apiKey: apiKey.trim(),
      encSecret: await encrypt(apiSecret.trim()),
      createdAt: Date.now(),
    });
    setApiKey("");
    setApiSecret("");
  }

  return (
    <form onSubmit={onSubmit} className={card}>
      <h3 className="font-semibold">바이낸스 API 키</h3>
      <p className="text-xs leading-5 text-stone-500">
        반드시 <b>읽기 전용(Enable Reading)</b> 권한만 켠 키를 만드세요. Secret은
        암호화되어 이 브라우저에만 저장되고, 요청 서명도 브라우저에서 이루어집니다.
      </p>
      <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="이름" />
      <input className={input} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key" required />
      <input className={input} type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} placeholder="Secret Key" required />
      <LockedHint unlocked={unlocked} />
      {dup && <p className="text-xs text-red-600">이미 등록된 API 키입니다.</p>}
      <button className={button} disabled={!unlocked}>추가</button>
    </form>
  );
}

function OkxForm() {
  const unlocked = useVaultUnlocked();
  const [label, setLabel] = useState("OKX");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [dup, setDup] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const exists = await exchangeKeyExists("okx", apiKey);
    setDup(exists);
    if (exists) return;
    await db.sources.add({
      id: crypto.randomUUID(),
      kind: "okx",
      label: label.trim() || "OKX",
      apiKey: apiKey.trim(),
      encSecret: await encrypt(apiSecret.trim()),
      encPassphrase: await encrypt(passphrase),
      createdAt: Date.now(),
    });
    setApiKey("");
    setApiSecret("");
    setPassphrase("");
  }

  return (
    <form onSubmit={onSubmit} className={card}>
      <h3 className="font-semibold">OKX API 키</h3>
      <p className="text-xs leading-5 text-stone-500">
        권한은 <b>Read만</b> 선택하세요. Secret과 Passphrase는 암호화되어 저장됩니다.
        Passphrase는 OKX 인증 헤더로 보내야 해서 요청할 때 중계 서버를 거치지만,
        서버에 저장되지 않습니다.
      </p>
      <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="이름" />
      <input className={input} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key" required />
      <input className={input} type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} placeholder="Secret Key" required />
      <input className={input} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="Passphrase" required />
      <LockedHint unlocked={unlocked} />
      {dup && <p className="text-xs text-red-600">이미 등록된 API 키입니다.</p>}
      <button className={button} disabled={!unlocked}>추가</button>
    </form>
  );
}

const KIND_LABEL = { binance: "Binance", okx: "OKX", xapi: "API", evm: "EVM", btc: "Bitcoin", tron: "Tron", solana: "Solana", csv: "파일", manual: "직접 입력" } as const;

function SolanaForm() {
  const [label, setLabel] = useState("솔라나 지갑");
  const [address, setAddress] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState("");
  const savedKey = useLiveQuery(() => getSetting("heliusKey"), []);
  const valid = isSolanaAddress(address);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    const addr = address.trim();
    const existing = (await db.sources.toArray()).find((s) => s.kind === "solana" && s.address === addr);
    if (existing) {
      setNotice(`이미 연결된 주소입니다 (${existing.label}).`);
      return;
    }
    await db.sources.add({ id: crypto.randomUUID(), kind: "solana", label: label.trim() || "솔라나 지갑", address: addr, createdAt: Date.now() });
    setNotice(`${label} (${addr.slice(0, 4)}…${addr.slice(-4)})를 연결했습니다.`);
    setAddress("");
  }

  return (
    <form onSubmit={onSubmit} className={card}>
      <h3 className="font-semibold">솔라나 지갑 (팬텀, 솔플레어 등)</h3>
      <p className="text-xs leading-5 text-stone-500">
        지갑 주소를 입력하세요. SOL·토큰·스테이킹(보상 포함)을 함께 불러옵니다. 공식 솔라나 노드가 브라우저 조회를 막고 있어
        조회 요청이 이 서비스의 중계 서버를 거칩니다 (주소는 저장하지 않음). Helius 무료 키를 넣으면 브라우저에서 바로 조회하고 더
        빠릅니다. <b>복구 문구나 개인키는 절대 입력하지 마세요.</b>
      </p>
      <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="이름" />
      <input className={input} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="지갑 주소" required />
      {address && !valid && <p className="text-xs text-red-600">솔라나 주소 형식이 아닙니다.</p>}
      {notice && <p className="text-xs text-amber-700 dark:text-amber-400">{notice}</p>}
      <button className={button} disabled={!valid}>
        추가
      </button>
      <button type="button" className="block text-xs text-stone-500 underline" onClick={() => setShowKey(!showKey)}>
        Helius API 키 (선택{savedKey ? ", 저장됨" : ""})
      </button>
      {showKey && (
        <div className="flex gap-2">
          <input className={input} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="helius.dev에서 무료 키를 받아 넣으세요. 비우고 저장하면 지웁니다" />
          <button
            type="button"
            className="shrink-0 rounded-lg border border-stone-300 px-3 text-xs dark:border-stone-700"
            onClick={async () => {
              await setSetting("heliusKey", key.trim());
              setKey("");
            }}
          >
            저장
          </button>
        </div>
      )}
    </form>
  );
}

function TronForm() {
  const [label, setLabel] = useState("트론 지갑");
  const [address, setAddress] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState("");
  const savedKey = useLiveQuery(() => getSetting("trongridKey"), []);
  const valid = isTronAddress(address);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    const addr = address.trim();
    const existing = (await db.sources.toArray()).find((s) => s.kind === "tron" && s.address === addr);
    if (existing) {
      setNotice(`이미 연결된 주소입니다 (${existing.label}).`);
      return;
    }
    await db.sources.add({ id: crypto.randomUUID(), kind: "tron", label: label.trim() || "트론 지갑", address: addr, createdAt: Date.now() });
    setNotice(`${label} (${addr.slice(0, 6)}…${addr.slice(-4)})를 연결했습니다.`);
    setAddress("");
  }

  return (
    <form onSubmit={onSubmit} className={card}>
      <h3 className="font-semibold">트론 지갑 (TRC-20 USDT 등)</h3>
      <p className="text-xs leading-5 text-stone-500">
        업비트·빗썸에서 해외 거래소로 USDT를 보낼 때 많이 쓰는 네트워크입니다. T로 시작하는 주소를 입력하세요. 공개 블록체인
        데이터(TronGrid)를 이 브라우저에서 직접 조회합니다. <b>복구 문구나 개인키는 절대 입력하지 마세요.</b>
      </p>
      <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="이름" />
      <input className={input} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="T…" required />
      {address && !valid && <p className="text-xs text-red-600">트론 주소 형식이 아닙니다 (T로 시작하는 34자, 체크섬 확인).</p>}
      {notice && <p className="text-xs text-amber-700 dark:text-amber-400">{notice}</p>}
      <button className={button} disabled={!valid}>
        추가
      </button>
      <button type="button" className="block text-xs text-stone-500 underline" onClick={() => setShowKey(!showKey)}>
        TronGrid API 키 (선택{savedKey ? ", 저장됨" : ""})
      </button>
      {showKey && (
        <div className="flex gap-2">
          <input className={input} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="키 없이도 동작합니다. 거래가 많아 느리면 trongrid.io에서 무료 키를 받아 넣으세요" />
          <button
            type="button"
            className="shrink-0 rounded-lg border border-stone-300 px-3 text-xs dark:border-stone-700"
            onClick={async () => {
              await setSetting("trongridKey", key.trim());
              setKey("");
            }}
          >
            저장
          </button>
        </div>
      )}
    </form>
  );
}

function XapiForm({ preset }: { preset: ApiExchange }) {
  const unlocked = useVaultUnlocked();
  const exchange = preset;
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [dup, setDup] = useState(false);
  const info = API_EXCHANGES[exchange];

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const exists = (await db.sources.toArray()).some((s) => s.kind === "xapi" && s.exchange === exchange && s.apiKey === apiKey.trim());
    setDup(exists);
    if (exists) return;
    await db.sources.add({
      id: crypto.randomUUID(),
      kind: "xapi",
      exchange,
      label: label.trim() || info.name,
      apiKey: apiKey.trim(),
      encSecret: await encrypt(apiSecret.trim()),
      encPassphrase: info.needsPassphrase ? await encrypt(passphrase) : undefined,
      createdAt: Date.now(),
    });
    setApiKey("");
    setApiSecret("");
    setPassphrase("");
    setLabel("");
  }

  return (
    <form onSubmit={onSubmit} className={card}>
      <h3 className="font-semibold">{info.name} API 키</h3>
      <p className="text-xs leading-5 text-stone-500">
        {info.keyHelp}. Secret은 암호화되어 이 브라우저에만 저장되고, 요청 서명도 브라우저에서 합니다.{" "}
        <span className="text-amber-700 dark:text-amber-400">실제 키로 검증 전인 연결입니다.</span>
      </p>
      <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`이름 (기본: ${info.name})`} />
      <input className={input} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={info.keyLabel ?? "API Key"} required />
      {info.multilineSecret ? (
        <textarea
          className={`${input} font-mono text-xs`}
          rows={4}
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          placeholder={info.secretLabel}
          required
          autoComplete="off"
          spellCheck={false}
        />
      ) : (
        <input className={input} type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} placeholder={info.secretLabel ?? "Secret Key"} required />
      )}
      {info.needsPassphrase && (
        <input className={input} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="Passphrase" required />
      )}
      <LockedHint unlocked={unlocked} />
      {dup && <p className="text-xs text-red-600">이미 등록된 API 키입니다.</p>}
      <button className={button} disabled={!unlocked}>
        추가
      </button>
    </form>
  );
}

// ── 직접 입력 ── (lib/manual.ts)
const EMPTY_MANUAL = { type: "buy" as ManualType, when: "", place: "", coin: "", qty: "", krw: "", coin2: "", qty2: "", fee: "", feeAsset: "", memo: "" };

function ManualEntryCard() {
  const manualSources = useLiveQuery(() => db.sources.where("kind").equals("manual").toArray(), []);
  const ids = (manualSources ?? []).map((s) => s.id);
  const entries = useLiveQuery(() => (ids.length ? db.ledger.where("sourceId").anyOf(ids).toArray() : []), [ids.join(",")]);
  const [f, setF] = useState(EMPTY_MANUAL);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof EMPTY_MANUAL) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  // 입력 묶음(groupId)별로 한 줄씩 보여 준다
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries ?? []) groups.set(e.groupId, [...(groups.get(e.groupId) ?? []), e]);
  const rows = [...groups.entries()].sort((a, b) => b[1][0].time - a[1][0].time);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    const input: ManualInput = {
      type: f.type,
      time: f.when ? Date.parse(`${f.when}:00+09:00`) : NaN,
      place: f.place,
      coin: f.coin,
      qty: f.qty,
      krw: f.krw || undefined,
      coin2: f.coin2 || undefined,
      qty2: f.qty2 || undefined,
      fee: f.fee || undefined,
      feeAsset: f.feeAsset || undefined,
      memo: f.memo || undefined,
    };
    const problem = validateManual(input);
    setError(problem);
    if (problem) return;
    let source = manualSources?.[0];
    if (!source) {
      source = { id: crypto.randomUUID(), kind: "manual", label: "직접 입력", createdAt: Date.now() };
      await db.sources.add(source);
    }
    await db.ledger.bulkPut(buildManualEntries(source.id, crypto.randomUUID(), input));
    setF({ ...EMPTY_MANUAL, type: f.type, place: f.place });
  }

  const t = f.type;
  return (
    <form onSubmit={onAdd} className={card}>
      <h3 className="font-semibold">직접 입력</h3>
      <p className="text-xs leading-5 text-stone-500">
        연결할 수 없는 거래소·지갑의 거래나 오래된 거래, 2026년 말에 가지고 있던 코인(의제취득가 대상)을 손으로 넣습니다. 시각은 한국 시각입니다.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <select className={input} value={t} onChange={set("type")}>
          {(Object.keys(MANUAL_TYPES) as ManualType[]).map((k) => (
            <option key={k} value={k}>
              {MANUAL_TYPES[k]}
            </option>
          ))}
        </select>
        {t === "holding" ? (
          <span className="self-center text-xs text-stone-500">2026-12-31 23:59 기준</span>
        ) : (
          <input className={input} type="datetime-local" step={1} value={f.when} onChange={set("when")} />
        )}
        <input className={input} value={f.place} onChange={set("place")} placeholder="거래소·지갑 이름 (예: 코인원)" />
        <input className={input} value={f.coin} onChange={set("coin")} placeholder={t === "swap" ? "보낸 코인 (예: USDT)" : "코인 (예: BTC)"} />
        <input className={input} value={f.qty} onChange={set("qty")} placeholder={t === "swap" ? "보낸 수량" : "수량"} inputMode="decimal" />
        {(t === "buy" || t === "sell" || t === "holding") && (
          <input
            className={input}
            value={f.krw}
            onChange={set("krw")}
            inputMode="numeric"
            placeholder={t === "holding" ? "실제 취득가 원화 합계 (모르면 비움)" : t === "buy" ? "지불한 원화 금액" : "받은 원화 금액"}
          />
        )}
        {t === "swap" && (
          <>
            <input className={input} value={f.coin2} onChange={set("coin2")} placeholder="받은 코인 (예: BTC)" />
            <input className={input} value={f.qty2} onChange={set("qty2")} placeholder="받은 수량" inputMode="decimal" />
          </>
        )}
        <input className={input} value={f.fee} onChange={set("fee")} placeholder="수수료 (선택)" inputMode="decimal" />
        <input className={input} value={f.feeAsset} onChange={set("feeAsset")} placeholder={t === "buy" || t === "sell" ? "수수료 단위 (기본 KRW)" : "수수료 단위 (기본: 코인)"} />
        <input className={`${input} col-span-2`} value={f.memo} onChange={set("memo")} placeholder="메모 (선택)" />
      </div>
      {t === "holding" && (
        <p className="text-xs text-stone-500">
          실제 취득가를 모르면 비워 두세요. 2026년 말 시가로 계산되어 의제취득가와 같아집니다. 실제로 더 비싸게 샀다면 그 금액을 넣어야 세금이 줄어듭니다.
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button className={button}>추가</button>

      {rows.length > 0 && (
        <ul className="divide-y divide-stone-200 text-xs dark:divide-stone-800">
          {rows.map(([groupId, legs]) => (
            <li key={groupId} className="flex items-center gap-2 py-1.5">
              <span className="text-stone-500">{formatDateTime(legs[0].time)}</span>
              <span className="flex-1">
                {legs[0].rawType?.replace("직접 입력: ", "")} · {legs.filter((l) => l.kind !== "fee").map((l) => `${l.amount} ${l.asset}`).join(" / ")} · {legs[0].location}
              </span>
              <button type="button" className="text-red-600 hover:underline" onClick={() => db.ledger.where("groupId").equals(groupId).delete()}>
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

interface CsvPreview {
  fileName: string;
  adapter: CsvAdapter;
  table: CsvTable;
  result: ImportResult;
  parts: string[];
}

// 거래소별 가져오기 설정 (같은 거래소 파일 여러 개는 한 계정에 모은다)
interface GroupSetting {
  target: string; // "new" 또는 합칠 CSV 계정 ID
  label: string;
  link: string; // 같은 계정의 API 연결 ID ("" = 연결 안 함)
}

type Failed = { fileName: string; message: string; headers?: string[] };

const fmtDay = (t: number) => new Date(t).toLocaleDateString("ko-KR");

const PART_STYLE: Record<PartState, string> = {
  done: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  api: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300",
  missing: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
};

// 거래소 파일 준비 목록: 필요한 파일마다 올렸는지, 담긴 기간, 빠졌으면 받는 법. pending: 지금 가져오려는 파일의 부분
function KitChecklist({ rows, pending = [] }: { rows: KitRow[]; pending?: string[] }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {rows.map((p) => {
        const waiting = pending.includes(p.key) && p.state !== "done";
        const state: PartState = waiting ? "done" : p.state;
        return (
          <li key={p.key} className={`rounded-lg border px-2.5 py-1.5 text-xs ${PART_STYLE[state]}`}>
            <span className="font-semibold">
              {state === "done" ? "✓" : state === "api" ? "↻" : "!"} {p.label}
            </span>
            <span className="ml-1.5 opacity-80">
              {waiting
                ? "가져오기 대기"
                : state === "done"
                  ? p.from !== undefined && p.to !== undefined
                    ? `${fmtDay(p.from)} ~ ${fmtDay(p.to)}`
                    : `파일 ${p.files}개`
                  : state === "api"
                    ? "API로 최근 기록 보완 · 오래된 기간은 파일 필요"
                    : `없음 · ${p.howTo}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function CsvImportCard() {
  const allSources = useLiveQuery(() => db.sources.toArray(), []);
  const csvSources = allSources?.filter((s): s is CsvSource => s.kind === "csv");
  const [previews, setPreviews] = useState<CsvPreview[]>([]);
  const [settings, setSettings] = useState<Record<string, GroupSetting>>({});
  const [failed, setFailed] = useState<Failed[]>([]);
  const [done, setDone] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [paste, setPaste] = useState("");

  function reset() {
    setPreviews([]);
    setFailed([]);
    setDone([]);
    setError(null);
  }

  // 미리보기용 변환 (sourceId는 저장할 때 확정)
  function makePreview(fileName: string, adapter: CsvAdapter, table: CsvTable, extraWarning?: string): CsvPreview {
    const result = adapter.convert(table, "preview");
    if (extraWarning) result.warnings.unshift(extraWarning);
    return { fileName, adapter, table, result, parts: partsOf(adapter, table) };
  }

  // 거래소마다 기본 설정: 같은 거래소의 기존 파일 계정에 합치고, 같은 거래소 API가 있으면 같은 계정으로 연결
  function showPreviews(list: CsvPreview[]) {
    setPreviews(list);
    const next: Record<string, GroupSetting> = {};
    for (const p of list) {
      const x = p.adapter.exchange;
      if (next[x]) continue;
      const same = (csvSources ?? []).find((s) => s.exchange === x);
      const api = (allSources ?? []).find((s) => isExchangeKind(s.kind) && exchangeIdOf(s) === x);
      next[x] = {
        target: same ? same.id : "new",
        label: `${p.adapter.exchangeName} (${p.adapter.id.includes("paste") ? "붙여넣기" : "파일"})`,
        link: same?.linkedSourceId ?? api?.id ?? "",
      };
    }
    setSettings(next);
  }

  async function readFile(file: File): Promise<CsvPreview | Failed> {
    const buf = await file.arrayBuffer();
    if (isOldXls(buf)) {
      return { fileName: file.name, message: "옛 엑셀 형식(.xls)입니다. 엑셀에서 ‘다른 이름으로 저장 → Excel 통합 문서(.xlsx)’로 저장해 올리거나, 표를 복사해 ‘붙여넣기’ 칸에 넣으세요." };
    }
    try {
      const found = isXlsx(buf) ? detectRows(await readXlsxRows(buf)) : detect(decodeText(buf));
      if (!found.adapter) return { fileName: file.name, message: "지원하지 않는 형식입니다.", headers: found.headers };
      return makePreview(file.name, found.adapter, found.table);
    } catch (e) {
      return { fileName: file.name, message: `읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async function onFiles(files: FileList | null | undefined) {
    reset();
    const list = [...(files ?? [])];
    if (!list.length) return;
    setBusy(true);
    const results = await Promise.all(list.map(readFile));
    setBusy(false);
    setFailed(results.filter((r): r is Failed => !("adapter" in r)));
    showPreviews(results.filter((r): r is CsvPreview => "adapter" in r));
  }

  function onPaste() {
    reset();
    // 엑셀에서 복사한 표(탭으로 나뉜 칸)는 파일과 같은 변환기로 읽는다 (예: 빗썸 엑셀)
    const asTable = detect(paste);
    if (asTable.adapter && asTable.adapter !== upbitHistory) {
      showPreviews([makePreview(`${asTable.adapter.exchangeName} 붙여넣기 ${new Date().toLocaleString("ko-KR")}`, asTable.adapter, asTable.table)]);
      return;
    }
    const parsed = parseUpbitPaste(paste);
    if (!parsed) {
      setError("거래 기록을 찾지 못했습니다. 업비트는 투자내역 → 거래내역 표를, 빗썸은 엑셀의 표를 열 이름 줄까지 포함해 복사했는지 확인하세요.");
      return;
    }
    showPreviews([
      makePreview(
        `업비트 붙여넣기 ${new Date().toLocaleString("ko-KR")}`,
        upbitHistory,
        parsed.table,
        parsed.skipped ? `기록으로 읽지 못한 조각 ${parsed.skipped}개는 건너뛰었습니다.` : undefined,
      ),
    ]);
  }

  async function onImport() {
    if (!previews.length) return;
    setError(null);
    setBusy(true);
    const messages: string[] = [];
    try {
      for (const [exchange, set] of Object.entries(settings)) {
        const files = previews.filter((p) => p.adapter.exchange === exchange);
        if (!files.length) continue;
        let source: CsvSource =
          set.target === "new"
            ? { id: crypto.randomUUID(), kind: "csv", label: set.label.trim() || `${files[0].adapter.exchangeName} (파일)`, exchange, imports: [], createdAt: Date.now() }
            : ((await db.sources.get(set.target)) as CsvSource);
        for (const p of files) {
          // 실제 계정 ID로 다시 변환해 결정적 ID를 확정한다
          const { entries, range } = p.adapter.convert(p.table, source.id);
          const existing = await db.ledger.bulkGet(entries.map((e) => e.id));
          const added = existing.filter((x) => !x).length;
          const imp = { at: Date.now(), fileName: p.fileName, format: p.adapter.id, rows: p.result.rowCount, added, parts: p.parts, from: range?.from, to: range?.to };
          const saved: CsvSource = { ...source, linkedSourceId: set.link || undefined, imports: [...source.imports, imp] };
          await db.transaction("rw", db.sources, db.ledger, async () => {
            await db.ledger.bulkPut(entries);
            await db.sources.put(saved);
          });
          source = saved;
          messages.push(`${p.fileName}: 새 기록 ${added}건${entries.length - added ? ` (이미 있던 ${entries.length - added}건은 건너뜀)` : ""}`);
        }
      }
      setDone(messages);
      setPreviews([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const exchanges = [...new Set(previews.map((p) => p.adapter.exchange))];
  const kitSources = (csvSources ?? []).filter((s) => KITS[s.exchange]);

  return (
    <div className={card}>
      <h3 className="font-semibold">거래내역 파일 가져오기</h3>
      <p className="text-xs leading-5 text-stone-500">
        API 키 없이 거래소에서 내려받은 거래내역 파일(CSV·엑셀)로 연결합니다. <b>여러 파일을 한 번에</b> 올릴 수 있고, 어느 거래소의 어떤 파일인지 자동으로
        알아봅니다. 파일은 이 브라우저 안에서만 읽고 서버로 보내지 않습니다. 지원: {[...new Set(ADAPTERS.map((a) => a.exchangeName))].join(", ")} · 준비 중:{" "}
        {PLANNED_EXCHANGES.join(", ")}
      </p>

      {kitSources.length > 0 && (
        <div className="space-y-3 rounded-xl bg-stone-50 p-3 dark:bg-stone-800/40">
          <p className="text-xs font-semibold text-stone-500">거래소별 필요한 파일</p>
          {kitSources.map((s) => (
            <div key={s.id} className="space-y-1.5">
              <p className="text-sm font-medium">{s.label}</p>
              <KitChecklist rows={kitStatus(s, allSources ?? []) ?? []} />
            </div>
          ))}
        </div>
      )}

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void onFiles(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-8 text-center text-sm transition-colors ${
          dragging ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40" : "border-stone-300 hover:border-indigo-400 dark:border-stone-700"
        }`}
      >
        <span className="font-medium">{busy ? "읽는 중…" : "파일을 여기에 끌어다 놓거나 눌러서 고르세요"}</span>
        <span className="text-xs text-stone-500">여러 개 선택 가능 · CSV, 엑셀(.xlsx) · 예: OKX 거래·입금·출금 내역 3개를 한 번에</span>
        <input
          type="file"
          multiple
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            void onFiles(e.target.files);
            e.target.value = "";
          }}
          className="sr-only"
        />
      </label>

      <details className="text-sm">
        <summary className="cursor-pointer font-medium">붙여넣기로 가져오기 (업비트 거래내역 화면, 엑셀에서 복사한 표)</summary>
        <div className="mt-2 space-y-2">
          <p className="text-xs leading-5 text-stone-500">
            업비트: {upbitHistory.howToExport}. 빗썸 등 엑셀 파일이 올라가지 않을 때: 엑셀에서 열 이름 줄부터 표 전체를 선택해 복사(Ctrl+C) →
            여기에 붙여넣기. 붙여넣은 글자는 이 브라우저 안에서만 읽습니다.
          </p>
          <textarea
            className={`${input} h-32 font-mono text-xs`}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={"예)\n2027.01.02 09:00:05\tBTC\tKRW\t매수\t0.01 BTC\t100,000,000 KRW\t1,000,000 KRW\t500 KRW\t1,000,500 KRW\t2027.01.02 09:00:00"}
          />
          <button type="button" className={button} disabled={!paste.trim()} onClick={onPaste}>
            읽기
          </button>
        </div>
      </details>

      {exchanges.map((x) => {
        const files = previews.filter((p) => p.adapter.exchange === x);
        const set = settings[x];
        if (!set) return null;
        const update = (patch: Partial<GroupSetting>) => setSettings({ ...settings, [x]: { ...set, ...patch } });
        const apiSources = (allSources ?? []).filter((s) => isExchangeKind(s.kind) && exchangeIdOf(s) === x);
        const base: CsvSource = (csvSources ?? []).find((s) => s.id === set.target) ?? { id: "", kind: "csv", label: "", exchange: x, imports: [], createdAt: 0 };
        const kit = kitStatus({ ...base, linkedSourceId: set.link || undefined }, allSources ?? []);
        return (
          <div key={x} className="space-y-3 rounded-xl border border-stone-200 p-4 text-sm dark:border-stone-800">
            <p className="font-semibold">
              {files[0].adapter.exchangeName} · 파일 {files.length}개
            </p>
            {kit && <KitChecklist rows={kit} pending={files.flatMap((f) => f.parts)} />}
            <ul className="space-y-2">
              {files.map((p) => {
                const r = p.result;
                return (
                  <li key={p.fileName} className="space-y-1 rounded-lg bg-stone-50 p-3 dark:bg-stone-800/40">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{p.fileName}</span>
                      <Badge tone="info">{p.adapter.formatName}</Badge>
                      {!p.adapter.verified && <Badge tone="warn">샘플 검증 전 형식</Badge>}
                    </p>
                    <p className="text-xs text-stone-600 dark:text-stone-400">
                      {r.rowCount}줄 → 원장 {r.entries.length}건{r.range ? ` · ${fmtDay(r.range.from)} ~ ${fmtDay(r.range.to)}` : ""}
                    </p>
                    {r.unknownTypes.length > 0 && (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        처음 보는 유형 {r.unknownTypes.length}개는 &lsquo;검토 필요&rsquo;로 들어갑니다: {r.unknownTypes.join(", ")}
                      </p>
                    )}
                    {r.warnings.map((w, i) => (
                      <p key={i} className="text-xs text-amber-700 dark:text-amber-400">
                        {w}
                      </p>
                    ))}
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <select className={`${input} w-auto`} value={set.target} onChange={(e) => update({ target: e.target.value })}>
                <option value="new">새 계정으로</option>
                {(csvSources ?? [])
                  .filter((s) => s.exchange === x)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}에 합치기
                    </option>
                  ))}
              </select>
              {set.target === "new" && <input className={`${input} w-48`} value={set.label} onChange={(e) => update({ label: e.target.value })} placeholder="계정 이름" />}
            </div>
            {apiSources.length > 0 && (
              <label className="flex flex-wrap items-center gap-2 text-xs">
                같은 계정의 API 연결
                <select className={`${input} w-auto`} value={set.link} onChange={(e) => update({ link: e.target.value })}>
                  {apiSources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                  <option value="">없음 (다른 계정)</option>
                </select>
                <span className="text-stone-500">같은 계정이면 파일에 있는 기간·종류는 파일을, 나머지는 API 내역을 써서 중복을 막습니다.</span>
              </label>
            )}
          </div>
        );
      })}

      {previews.length > 0 && (
        <button className={button} disabled={busy} onClick={onImport}>
          {busy ? "가져오는 중…" : previews.length > 1 ? `파일 ${previews.length}개 모두 가져오기` : "가져오기"}
        </button>
      )}

      {failed.map((f) => (
        <div key={f.fileName} className="space-y-1 rounded-lg bg-red-50 p-3 text-xs dark:bg-red-950/40">
          <p className="font-medium">
            {f.fileName}: {f.message}
          </p>
          {f.headers && <p className="break-all text-stone-600 dark:text-stone-400">열 이름: {f.headers.join(", ") || "(읽지 못함)"}</p>}
        </div>
      ))}
      {done.length > 0 && (
        <ul className="space-y-0.5 text-sm text-emerald-700 dark:text-emerald-400">
          {done.map((m) => (
            <li key={m}>✓ {m}</li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function preview(input: string, scriptType: ScriptType | "") {
  if (!input.trim()) return null;
  try {
    const w = parseWalletInput(input, scriptType || undefined);
    if (w.kind !== "hd") return { ok: true as const, text: "단일 주소", isXpub: false };
    const isXpub = /^xpub/.test(input.trim());
    return {
      ok: true as const,
      text: `${SCRIPT_LABEL[w.scriptType]} · 첫 받는 주소 ${deriveAddress(w, 0, 0)}`,
      isXpub,
    };
  } catch (e) {
    return { ok: false as const, text: e instanceof Error ? e.message : String(e), isXpub: false };
  }
}

function BtcForm() {
  const [label, setLabel] = useState("비트코인 지갑");
  const [walletInput, setWalletInput] = useState("");
  const [scriptType, setScriptType] = useState<ScriptType | "">("");
  const [esploraUrl, setEsploraUrl] = useState(DEFAULT_ESPLORA);
  const [advanced, setAdvanced] = useState(false);
  const p = preview(walletInput, scriptType);

  const [dupError, setDupError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!p?.ok) return;
    const dup = await findDuplicateBtc(walletInput, scriptType);
    if (dup) {
      setDupError(dup);
      return;
    }
    setDupError(null);
    await db.sources.add({
      id: crypto.randomUUID(),
      kind: "btc",
      label: label.trim() || "비트코인 지갑",
      input: walletInput.trim(),
      scriptType: scriptType || undefined,
      gapLimit: DEFAULT_GAP_LIMIT,
      esploraUrl: esploraUrl.trim() || DEFAULT_ESPLORA,
      createdAt: Date.now(),
    });
    setWalletInput("");
    setScriptType("");
  }

  return (
    <form onSubmit={onSubmit} className={card}>
      <h3 className="font-semibold">비트코인 지갑</h3>
      <p className="text-xs leading-5 text-stone-500">
        확장 공개키(<b>zpub·ypub·xpub</b>), 디스크립터, 또는 주소 하나를 입력하세요. Sparrow는 지갑의{" "}
        <i>Settings</i> 탭 → Keystore의 <i>xPub</i> 값을 복사하면 됩니다.
        공개키로는 조회만 가능합니다. <b>복구 문구(시드)나 개인키(xprv)는 절대 입력하지 마세요.</b>
      </p>
      <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="이름" />
      <textarea
        className={`${input} font-mono text-xs`}
        rows={3}
        value={walletInput}
        onChange={(e) => setWalletInput(e.target.value)}
        placeholder="zpub6r… / wpkh([…]xpub…/<0;1>/*) / bc1q…"
        required
      />
      {p && (
        <p className={`break-all text-xs ${p.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600"}`}>
          {p.text}
        </p>
      )}
      {p?.ok && p.isXpub && (
        <label className="flex flex-wrap items-center gap-2 text-xs">
          주소 형식
          <select className={`${input} w-auto`} value={scriptType} onChange={(e) => setScriptType(e.target.value as ScriptType | "")}>
            <option value="">Legacy (1…) — xpub 기본값</option>
            {(Object.keys(SCRIPT_LABEL) as ScriptType[]).map((s) => (
              <option key={s} value={s}>
                {SCRIPT_LABEL[s]}
              </option>
            ))}
          </select>
          <span className="text-stone-500">첫 받는 주소가 지갑 앱과 같은지 확인하세요.</span>
        </label>
      )}
      <button type="button" className="block text-xs text-stone-500 underline" onClick={() => setAdvanced(!advanced)}>
        조회 서버 설정
      </button>
      {advanced && (
        <div className="space-y-1">
          <input className={input} value={esploraUrl} onChange={(e) => setEsploraUrl(e.target.value)} placeholder={DEFAULT_ESPLORA} />
          <p className="text-xs leading-5 text-stone-500">
            기본값은 mempool.space 공개 서버입니다. 조회한 주소들이 한 지갑이라는 사실이 서버에 드러나므로,
            개인 노드(Umbrel·Start9의 mempool 등)가 있다면 그 주소(예: http://umbrel.local:3006/api)를
            입력하세요.
          </p>
        </div>
      )}
      {dupError && <p className="text-xs text-red-600">{dupError}</p>}
      <button className={button} disabled={!p?.ok}>
        추가
      </button>
    </form>
  );
}

// 같은 지갑을 두 번 연결하면 잔고와 거래가 이중으로 잡히므로 막는다.
// 입력 형식이 달라도(zpub ↔ 디스크립터) 첫 받는 주소가 같으면 같은 지갑이다.
async function findDuplicateBtc(raw: string, scriptType: ScriptType | ""): Promise<string | null> {
  const fingerprint = (input: string, st?: string) => {
    const w = parseWalletInput(input, (st || undefined) as ScriptType | undefined);
    return w.kind === "hd" ? deriveAddress(w, 0, 0) : w.kind === "address" ? w.address : w.addresses[0];
  };
  const mine = fingerprint(raw, scriptType);
  const existing = (await db.sources.toArray()).filter((s) => s.kind === "btc");
  for (const s of existing) {
    if (s.frozenAddresses?.length) {
      // xpub을 지운 지갑: 남긴 주소로만 비교한다
      if (s.frozenAddresses.includes(mine)) return `이미 연결된 지갑(${s.label})에 포함된 주소입니다.`;
      continue;
    }
    if (fingerprint(s.input, s.scriptType) === mine) return `이미 연결된 지갑입니다 (${s.label}).`;
    // 단일 주소가 이미 연결된 HD 지갑에 속하는지 (동기화한 적이 있는 지갑만 확인 가능)
    const saved = await db.syncState.get(`${s.id}:addresses`);
    if (saved && (JSON.parse(saved.cursor) as string[]).includes(mine)) {
      return `이 주소는 이미 연결된 지갑(${s.label})에 포함되어 있습니다.`;
    }
  }
  return null;
}

// EVM 주소를 연결한다. 같은 주소가 이미 있으면 새 계정을 만들지 않고 체인만 합친다 (이중 집계 방지).
async function addOrMergeEvm(label: string, address: string, chains: EvmChain[]): Promise<string> {
  const addr = address.trim();
  const existing = (await db.sources.toArray()).find((s) => s.kind === "evm" && s.address.toLowerCase() === addr.toLowerCase());
  if (existing && existing.kind === "evm") {
    const added = chains.filter((c) => !existing.chains.includes(c));
    if (added.length > 0) await db.sources.put({ ...existing, chains: [...existing.chains, ...added] });
    return added.length > 0
      ? `이미 연결된 주소라 기존 계정(${existing.label})에 ${added.map((c) => EVM_CHAINS[c].name).join(", ")}를 추가했습니다.`
      : `이미 연결된 주소입니다 (${existing.label}).`;
  }
  await db.sources.add({ id: crypto.randomUUID(), kind: "evm", label, address: addr, chains, createdAt: Date.now() });
  return `${label} (${addr.slice(0, 6)}…${addr.slice(-4)})를 연결했습니다.`;
}

const ACTIVITY_LABEL: Record<ChainActivity, { text: string; cls: string }> = {
  active: { text: "사용함", cls: "text-emerald-700 dark:text-emerald-400" },
  inactive: { text: "안 씀", cls: "text-stone-400" },
  unknown: { text: "확인 실패", cls: "text-amber-700 dark:text-amber-400" },
};

function EvmForm() {
  const [label, setLabel] = useState("내 지갑");
  const [address, setAddress] = useState("");
  const [chains, setChains] = useState<EvmChain[]>(["eth"]);
  const [activity, setActivity] = useState<Partial<Record<EvmChain, ChainActivity>> | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [wallets, setWallets] = useState<WalletDetail[] | null>(null);
  const [pending, setPending] = useState<string[]>([]); // 지갑에서 가져왔지만 아직 추가하지 않은 주소
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim());

  // 사용한 체인을 찾아 자동으로 체크한다. 확인에 실패한 체인도 체크해 두어 빠뜨리지 않게 한다.
  async function detect(addr: string) {
    setDetecting(true);
    setActivity(null);
    try {
      const r = await detectActiveChains(addr.trim());
      setActivity(Object.fromEntries(r.map((x) => [x.chain, x.status])));
      const picked = r.filter((x) => x.status !== "inactive").map((x) => x.chain);
      setChains(picked.length ? picked : ["eth"]);
      if (!picked.length) setNotice("지원하는 체인에서 사용 기록을 찾지 못했습니다. 주소를 확인하세요.");
    } finally {
      setDetecting(false);
    }
  }

  function load(addr: string) {
    setAddress(addr);
    setNotice(null);
    void detect(addr);
  }

  async function connect() {
    setError(null);
    const found = await discoverWallets();
    if (found.length === 0) {
      setError("이 브라우저에서 확장 지갑을 찾지 못했습니다. 지갑을 설치했다면 새로고침하거나, 주소를 직접 입력하세요.");
      return;
    }
    if (found.length === 1) return pick(found[0]);
    setWallets(found);
  }

  async function pick(w: WalletDetail) {
    setWallets(null);
    setError(null);
    try {
      const addrs = await requestAddresses(w.provider);
      if (addrs.length === 0) throw new Error("지갑에서 받은 주소가 없습니다");
      setLabel(w.info.name);
      setPending(addrs.slice(1));
      load(addrs[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || chains.length === 0) return;
    const n = pending.length;
    setNotice(await addOrMergeEvm(label.trim() || "내 지갑", address, chains));
    setActivity(null);
    if (n > 0) {
      load(pending[0]);
      setPending(pending.slice(1));
    } else {
      setAddress("");
    }
  }

  return (
    <form onSubmit={onSubmit} className={card}>
      <h3 className="font-semibold">EVM 지갑 (메타마스크, 라비, 트러스트 등)</h3>
      <p className="text-xs leading-5 text-stone-500">
        공개 블록체인 데이터를 조회하므로 주소만 있으면 됩니다. 지갑 연결은 <b>주소 확인 권한만</b> 요청하며 서명·거래를
        요청하지 않습니다. <b>복구 문구(시드)나 개인키는 절대 입력하지 마세요.</b>
      </p>

      <button type="button" onClick={connect} className="w-full rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium dark:border-stone-700">
        확장 지갑으로 연결
      </button>
      {wallets && (
        <div className="flex flex-wrap gap-2">
          {wallets.map((w) => (
            <button
              type="button"
              key={w.info.uuid}
              onClick={() => pick(w)}
              className="flex items-center gap-2 rounded-lg border border-stone-300 px-3 py-1.5 text-sm dark:border-stone-700"
            >
              {w.info.icon && (
                // 지갑이 EIP-6963으로 넘겨준 data URI 아이콘이라 next/image 최적화 대상이 아니다
                // eslint-disable-next-line @next/next/no-img-element
                <img src={w.info.icon} alt="" className="h-5 w-5" />
              )}
              {w.info.name}
            </button>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex items-center gap-3 text-xs text-stone-400">
        <div className="h-px flex-1 bg-stone-200 dark:bg-stone-800" />
        또는 주소 직접 입력
        <div className="h-px flex-1 bg-stone-200 dark:bg-stone-800" />
      </div>

      <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="이름" />
      <div className="flex gap-2">
        <input className={input} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" required />
        <button
          type="button"
          disabled={!valid || detecting}
          onClick={() => detect(address)}
          className="shrink-0 rounded-lg border border-stone-300 px-3 text-xs disabled:opacity-40 dark:border-stone-700"
        >
          {detecting ? "찾는 중…" : "사용한 체인 찾기"}
        </button>
      </div>
      {pending.length > 0 && <p className="text-xs text-stone-500">지갑에서 가져온 주소가 {pending.length}개 더 있습니다. 이 주소를 추가하면 다음 주소로 넘어갑니다.</p>}

      <div className="flex flex-wrap gap-3 text-sm">
        {(Object.keys(EVM_CHAINS) as EvmChain[]).map((c) => (
          <label key={c} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={chains.includes(c)}
              onChange={(e) => setChains(e.target.checked ? [...chains, c] : chains.filter((x) => x !== c))}
            />
            {EVM_CHAINS[c].name}
            {activity?.[c] && <span className={`text-xs ${ACTIVITY_LABEL[activity[c]!].cls}`}>{ACTIVITY_LABEL[activity[c]!].text}</span>}
          </label>
        ))}
      </div>
      {notice && <p className="text-xs text-amber-700 dark:text-amber-400">{notice}</p>}
      <button className={button} disabled={!valid || chains.length === 0 || detecting}>
        추가
      </button>
    </form>
  );
}

// CSV 계정을 같은 거래소의 API 계정과 연결하거나 해제한다 (중복 제거·잔고 이중 합산 방지).
function CsvLink({ source, all }: { source: CsvSource; all: Source[] }) {
  const apis = all.filter((s) => isExchangeKind(s.kind) && exchangeIdOf(s) === source.exchange);
  if (apis.length === 0) return null;
  const linked = apis.some((a) => a.id === source.linkedSourceId);
  return (
    <label className="flex items-center gap-1 text-xs text-stone-500">
      같은 계정:
      <select
        className="rounded border border-stone-300 bg-transparent px-1 py-0.5 dark:border-stone-700"
        value={linked ? source.linkedSourceId : ""}
        onChange={(e) => db.sources.put({ ...source, linkedSourceId: e.target.value || undefined })}
      >
        <option value="">연결 안 함</option>
        {apis.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// xpub 스캔 후 삭제: 동기화로 찾은 주소만 남기고 xpub(과거·미래의 모든 주소를 아는 키)을 지운다.
function ForgetXpub({ source }: { source: BtcSource }) {
  const saved = useLiveQuery(() => db.syncState.get(`${source.id}:addresses`), [source.id]);
  const [confirm, setConfirm] = useState(false);
  let isHd = false;
  try {
    isHd = !source.frozenAddresses?.length && parseWalletInput(source.input, source.scriptType).kind === "hd";
  } catch {
    isHd = false;
  }
  if (!isHd) return null;
  const addresses = saved ? (JSON.parse(saved.cursor) as string[]) : [];
  if (addresses.length === 0) {
    return <span className="text-xs text-stone-400">동기화 후 xpub을 지울 수 있습니다</span>;
  }
  if (!confirm) {
    return (
      <button onClick={() => setConfirm(true)} className="text-xs text-stone-500 underline">
        xpub 지우기
      </button>
    );
  }
  return (
    <div className="basis-full space-y-1 rounded-lg bg-amber-50 p-3 text-xs dark:bg-amber-950/40">
      <p>
        찾아 둔 주소 {addresses.length}개만 남기고 xpub을 지웁니다. 이후 지갑이 <b>새로 만드는 주소</b>(새 받는 주소·거스름돈)는
        찾지 못합니다. 특히 이 지갑에서 <b>비트코인을 보내면</b> 거스름돈이 외부 송금으로 잘못 계산될 수 있으니, 그때는 xpub을 다시
        넣어 갱신하세요 (앱이 경고합니다).
      </p>
      <div className="flex gap-3">
        <button
          className="font-medium text-red-600 underline"
          onClick={() => db.sources.put({ ...source, input: "", frozenAddresses: addresses, frozenAt: Date.now() })}
        >
          지우기
        </button>
        <button className="underline" onClick={() => setConfirm(false)}>
          취소
        </button>
      </div>
    </div>
  );
}

// 계정과 함께 그 계정의 원장·동기화 상태도 지운다.
async function removeSource(id: string) {
  await db.transaction("rw", db.sources, db.ledger, db.syncState, async () => {
    await db.sources.delete(id);
    await db.ledger.where("sourceId").equals(id).delete();
    await db.syncState.where("key").startsWith(`${id}:`).delete();
  });
}

function sourceDetail(s: Source) {
  if (s.kind === "evm") return `${s.address.slice(0, 6)}…${s.address.slice(-4)} · ${s.chains.map((c) => EVM_CHAINS[c].name).join(", ")}`;
  if (s.kind === "btc") return `${s.frozenAddresses?.length ? `주소 ${s.frozenAddresses.length}개 (xpub 지움)` : mask(s.input)} · ${new URL(s.esploraUrl).host}`;
  if (s.kind === "csv") return `파일 ${s.imports.length}개 가져옴`;
  if (s.kind === "xapi") return `API 키 ${mask(s.apiKey)}`;
  if (s.kind === "tron" || s.kind === "solana") return `${s.address.slice(0, 6)}…${s.address.slice(-4)}`;
  if (s.kind === "manual") return "‘직접 입력’ 탭에서 관리";
  return `API 키 ${mask(s.apiKey)}`;
}

// 계정 종류 이름 (거래소 API는 거래소 이름으로)
function kindName(s: Source) {
  if (s.kind === "xapi") return API_EXCHANGES[s.exchange].name;
  return KIND_LABEL[s.kind];
}

const GROUPS: { title: string; kinds: Source["kind"][] }[] = [
  { title: "거래소", kinds: ["binance", "okx", "xapi", "csv"] },
  { title: "개인 지갑", kinds: ["btc", "evm", "tron", "solana"] },
  { title: "직접 입력", kinds: ["manual"] },
];

function ConnectedList({ sources }: { sources: Source[] }) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      {GROUPS.map((g) => {
        const items = sources.filter((s) => g.kinds.includes(s.kind));
        if (!items.length) return null;
        return (
          <div key={g.title} className="space-y-2">
            <p className="text-xs font-semibold text-stone-400">
              {g.title} {items.length}
            </p>
            <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
              {items.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-xs font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                    {(s.kind === "csv" ? s.label : kindName(s)).slice(0, 2)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {s.label}
                      <Badge>{kindName(s)}</Badge>
                    </p>
                    <p className="truncate font-mono text-xs text-stone-500">{sourceDetail(s)}</p>
                  </div>
                  {s.kind === "csv" && <CsvLink source={s} all={sources} />}
                  {s.kind === "csv" && KITS[s.exchange] && (
                    <div className="order-last basis-full pl-12">
                      <KitChecklist rows={kitStatus(s, sources) ?? []} />
                    </div>
                  )}
                  {s.kind === "btc" && <ForgetXpub source={s} />}
                  {confirmId === s.id ? (
                    <span className="flex items-center gap-2 text-xs">
                      거래 기록도 함께 지워집니다.
                      <button onClick={() => removeSource(s.id)} className={btn("danger", "sm")}>
                        삭제
                      </button>
                      <button onClick={() => setConfirmId(null)} className={btn("ghost", "sm")}>
                        취소
                      </button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmId(s.id)} className={btn("ghost", "sm")}>
                      삭제
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

type Tab = "exchange" | "wallet" | "file" | "manual";
const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "exchange", label: "거래소 API", hint: "읽기 전용 키로 자동으로 가져오기" },
  { key: "wallet", label: "개인 지갑", hint: "지갑 주소로 블록체인 기록 조회" },
  { key: "file", label: "파일·붙여넣기", hint: "거래소에서 받은 거래내역" },
  { key: "manual", label: "직접 입력", hint: "연결할 수 없는 거래, 2026년 말 보유분" },
];

type ExchangeChoice = "binance" | "okx" | ApiExchange;
const EXCHANGE_ORDER: ExchangeChoice[] = ["upbit", "bithumb", "binance", "okx", "bybit", "coinbase", "bitget", "gate", "mexc"];
const exchangeName = (x: ExchangeChoice) => (x === "binance" ? "바이낸스" : x === "okx" ? "OKX" : API_EXCHANGES[x].name);

type WalletChoice = "btc" | "evm" | "tron" | "solana";
const WALLETS: { key: WalletChoice; name: string; hint: string }[] = [
  { key: "evm", name: "이더리움 계열", hint: "메타마스크·라비 등, 이더리움·아비트럼·베이스·옵티미즘·폴리곤" },
  { key: "btc", name: "비트코인", hint: "zpub·xpub 또는 주소" },
  { key: "tron", name: "트론", hint: "TRC-20 USDT" },
  { key: "solana", name: "솔라나", hint: "팬텀·솔플레어" },
];

function Tile({ active, onClick, title, hint }: { active: boolean; onClick: () => void; title: string; hint?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-4 py-3 text-left transition-colors ${
        active
          ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-500/20 dark:border-indigo-500 dark:bg-indigo-950/40"
          : "border-stone-200 bg-white hover:border-stone-300 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-700"
      }`}
    >
      <p className="text-sm font-semibold">{title}</p>
      {hint && <p className="mt-0.5 text-xs text-stone-500">{hint}</p>}
    </button>
  );
}

function AddAccount() {
  const [tab, setTab] = useState<Tab>("exchange");
  const [exchange, setExchange] = useState<ExchangeChoice>("upbit");
  const [wallet, setWallet] = useState<WalletChoice>("evm");

  return (
    <Card className="space-y-5">
      <div className="space-y-1">
        <h2 className="font-semibold">계정 추가</h2>
        <p className="text-xs text-stone-500">{TABS.find((t) => t.key === tab)?.hint}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Pill key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </Pill>
        ))}
      </div>

      {tab === "exchange" && (
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
            {EXCHANGE_ORDER.map((x) => (
              <button
                key={x}
                type="button"
                onClick={() => setExchange(x)}
                className={`rounded-xl border px-2 py-3 text-sm font-medium transition-colors ${
                  exchange === x
                    ? "border-indigo-500 bg-indigo-50 text-indigo-800 ring-2 ring-indigo-500/20 dark:bg-indigo-950/40 dark:text-indigo-200"
                    : "border-stone-200 bg-white hover:border-stone-300 dark:border-stone-800 dark:bg-stone-900"
                }`}
              >
                {exchangeName(x)}
              </button>
            ))}
          </div>
          <VaultPanel />
          <div className="max-w-xl">
            {exchange === "binance" ? <BinanceForm /> : exchange === "okx" ? <OkxForm /> : <XapiForm key={exchange} preset={exchange} />}
          </div>
          <p className="text-xs text-stone-500">API 키를 만들기 어렵다면 ‘파일·붙여넣기’ 탭에서 거래내역 파일로도 연결할 수 있습니다.</p>
        </div>
      )}

      {tab === "wallet" && (
        <div className="space-y-5">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {WALLETS.map((w) => (
              <Tile key={w.key} active={wallet === w.key} onClick={() => setWallet(w.key)} title={w.name} hint={w.hint} />
            ))}
          </div>
          <div className="max-w-xl">
            {wallet === "evm" ? <EvmForm /> : wallet === "btc" ? <BtcForm /> : wallet === "tron" ? <TronForm /> : <SolanaForm />}
          </div>
        </div>
      )}

      {tab === "file" && (
        <div className="max-w-2xl">
          <CsvImportCard />
        </div>
      )}

      {tab === "manual" && (
        <div className="max-w-2xl">
          <ManualEntryCard />
        </div>
      )}
    </Card>
  );
}

export default function SourcesPage() {
  const sources = useLiveQuery(() => db.sources.orderBy("createdAt").toArray(), []);

  return (
    <div className="space-y-6">
      <PageHeader
        step={1}
        title="계정 연결"
        description="사용하는 거래소와 지갑을 모두 연결하세요. 빠진 계정이 있으면 취득가가 끊겨 세금이 실제보다 많이 계산될 수 있습니다. 키와 주소는 이 브라우저에만 저장됩니다."
      />

      <Card className="space-y-4">
        <h2 className="font-semibold">연결된 계정{sources?.length ? ` ${sources.length}개` : ""}</h2>
        {sources?.length === 0 ? <Empty>아직 연결된 계정이 없습니다. 아래에서 추가하세요.</Empty> : sources && <ConnectedList sources={sources} />}
      </Card>

      <AddAccount />
    </div>
  );
}
