"use client";

import { useState, type FormEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, exchangeIdOf, isExchangeKind, type BtcSource, type CsvSource, type EvmChain, type Source } from "@/lib/db";
import { ADAPTERS, detect, PLANNED_EXCHANGES } from "@/lib/importers";
import { API_EXCHANGES, type ApiExchange } from "@/lib/sources/exchanges";
import type { CsvAdapter, CsvTable, ImportResult } from "@/lib/importers/types";
import { detectActiveChains, EVM_CHAINS, type ChainActivity } from "@/lib/sources/evm";
import { discoverWallets, requestAddresses, type WalletDetail } from "@/lib/wallet/eip6963";
import { deriveAddress, parseWalletInput, SCRIPT_LABEL, type ScriptType } from "@/lib/btc/descriptor";
import { DEFAULT_ESPLORA } from "@/lib/btc/esplora";
import { DEFAULT_GAP_LIMIT } from "@/lib/btc/scan";
import { encrypt } from "@/lib/vault";
import { useVaultUnlocked, VaultPanel } from "@/components/VaultPanel";

const input =
  "w-full rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm dark:border-stone-700";const button =
  "rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900";
const card =
  "space-y-3 rounded-xl border border-stone-200 p-5 dark:border-stone-800";

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

const KIND_LABEL = { binance: "Binance", okx: "OKX", xapi: "API", evm: "EVM", btc: "Bitcoin", csv: "CSV" } as const;

function XapiForm() {
  const unlocked = useVaultUnlocked();
  const [exchange, setExchange] = useState<ApiExchange>("bybit");
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
      <h3 className="font-semibold">그 밖의 거래소 API 키</h3>
      <select className={input} value={exchange} onChange={(e) => setExchange(e.target.value as ApiExchange)}>
        {(Object.keys(API_EXCHANGES) as ApiExchange[]).map((x) => (
          <option key={x} value={x}>
            {API_EXCHANGES[x].name}
          </option>
        ))}
      </select>
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

interface CsvPreview {
  fileName: string;
  adapter: CsvAdapter;
  table: CsvTable;
  result: ImportResult;
}

function CsvImportCard() {
  const allSources = useLiveQuery(() => db.sources.toArray(), []);
  const csvSources = allSources?.filter((s): s is CsvSource => s.kind === "csv");
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [unknownHeaders, setUnknownHeaders] = useState<string[] | null>(null);
  const [target, setTarget] = useState<string>("new");
  const [label, setLabel] = useState("");
  const [link, setLink] = useState<string>(""); // 같은 계정의 API 연결 ID ("" = 연결 안 함)
  const apiSources = (allSources ?? []).filter((s) => isExchangeKind(s.kind) && exchangeIdOf(s) === preview?.adapter.exchange);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    setPreview(null);
    setUnknownHeaders(null);
    setDone(null);
    setError(null);
    if (!file) return;
    const text = await file.text();
    const found = detect(text);
    if (!found.adapter) {
      setUnknownHeaders(found.headers);
      return;
    }
    // 미리보기용 변환 (sourceId는 저장할 때 확정)
    const result = found.adapter.convert(found.table, "preview");
    setPreview({ fileName: file.name, adapter: found.adapter, table: found.table, result });
    const same = (csvSources ?? []).find((s) => s.exchange === found.adapter.exchange);
    setTarget(same ? same.id : "new");
    setLabel(`${found.adapter.exchangeName} (CSV)`);
    // 기존 연결을 유지하고, 없으면 같은 거래소의 첫 API 연결을 기본값으로 제안한다
    const api = (allSources ?? []).find((s) => isExchangeKind(s.kind) && exchangeIdOf(s) === found.adapter.exchange);
    setLink(same?.linkedSourceId ?? api?.id ?? "");
  }

  async function onImport() {
    if (!preview) return;
    setError(null);
    try {
      const { adapter } = preview;
      let source: CsvSource;
      if (target === "new") {
        source = { id: crypto.randomUUID(), kind: "csv", label: label.trim() || `${adapter.exchangeName} (CSV)`, exchange: adapter.exchange, imports: [], createdAt: Date.now() };
      } else {
        source = (csvSources ?? []).find((s) => s.id === target)!;
      }
      // 실제 계정 ID로 다시 변환해 결정적 ID를 확정한다
      const { entries } = adapter.convert(preview.table, source.id);
      const existing = await db.ledger.bulkGet(entries.map((e) => e.id));
      const added = existing.filter((x) => !x).length;
      await db.transaction("rw", db.sources, db.ledger, async () => {
        await db.ledger.bulkPut(entries);
        await db.sources.put({
          ...source,
          linkedSourceId: link || undefined,
          imports: [...source.imports, { at: Date.now(), fileName: preview.fileName, format: adapter.id, rows: preview.result.rowCount, added }],
        });
      });
      setDone(`${entries.length}건 중 새 거래 ${added}건을 가져왔습니다${entries.length - added ? ` (이미 있던 ${entries.length - added}건은 건너뜀)` : ""}.`);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const r = preview?.result;
  const fmt = (t: number) => new Date(t).toLocaleDateString("ko-KR");

  return (
    <div className={card}>
      <h3 className="font-semibold">거래소 CSV 가져오기</h3>
      <p className="text-xs leading-5 text-stone-500">
        API 키 없이 거래소에서 내려받은 거래내역 파일로 연결합니다. 파일은 이 브라우저 안에서만 읽고 서버로 보내지
        않습니다. 지원: {ADAPTERS.map((a) => a.exchangeName).join(", ")} · 준비 중: {PLANNED_EXCHANGES.join(", ")}
      </p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="block w-full text-sm" />

      {preview && r && (
        <div className="space-y-2 rounded-lg bg-stone-100 p-3 text-sm dark:bg-stone-900">
          <p>
            <b>{preview.adapter.exchangeName}</b> · {preview.adapter.formatName}
            {!preview.adapter.verified && (
              <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-xs text-amber-900">샘플 검증 전 형식</span>
            )}
          </p>
          <p className="text-xs text-stone-600 dark:text-stone-400">
            {r.rowCount}줄 → 원장 {r.entries.length}건{r.range ? ` · ${fmt(r.range.from)} ~ ${fmt(r.range.to)}` : ""}
          </p>
          {r.unknownTypes.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              처음 보는 유형 {r.unknownTypes.length}개는 &lsquo;검토 필요&rsquo;로 들어갑니다: {r.unknownTypes.join(", ")}
            </p>
          )}
          {r.warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-700 dark:text-amber-400">{w}</p>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <select className={`${input} w-auto`} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="new">새 계정으로</option>
              {(csvSources ?? [])
                .filter((s) => s.exchange === preview.adapter.exchange)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}에 합치기
                  </option>
                ))}
            </select>
            {target === "new" && <input className={`${input} w-48`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="계정 이름" />}
            {apiSources.length > 0 && (
              <label className="flex w-full flex-wrap items-center gap-2 text-xs">
                같은 계정의 API 연결
                <select className={`${input} w-auto`} value={link} onChange={(e) => setLink(e.target.value)}>
                  {apiSources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                  <option value="">없음 (다른 계정)</option>
                </select>
                <span className="text-stone-500">같은 계정이면 CSV 기간은 CSV를, 그 밖의 기간은 API 내역을 써서 중복을 막습니다.</span>
              </label>
            )}
            <button className={button} onClick={onImport}>
              가져오기
            </button>
          </div>
        </div>
      )}

      {unknownHeaders && (
        <div className="space-y-1 rounded-lg bg-red-50 p-3 text-xs dark:bg-red-950/40">
          <p className="font-medium">지원하지 않는 형식입니다.</p>
          <p className="break-all text-stone-600 dark:text-stone-400">열 이름: {unknownHeaders.join(", ") || "(읽지 못함)"}</p>
          <p className="text-stone-600 dark:text-stone-400">열을 직접 연결하는 화면은 준비 중입니다.</p>
        </div>
      )}
      {done && <p className="text-sm text-emerald-700 dark:text-emerald-400">{done}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {preview && <p className="text-xs text-stone-500">파일 받는 법: {preview.adapter.howToExport}</p>}
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

export default function SourcesPage() {
  const sources = useLiveQuery(() => db.sources.orderBy("createdAt").toArray(), []);

  return (
    <div className="space-y-8">
      <VaultPanel />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">연결된 계정</h2>
        {sources?.length === 0 && (
          <p className="text-sm text-stone-500">아직 연결된 계정이 없습니다.</p>
        )}
        <ul className="space-y-2">
          {sources?.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 px-4 py-3 text-sm dark:border-stone-800"
            >
              <span className="rounded bg-stone-200 px-2 py-0.5 text-xs dark:bg-stone-800">
                {KIND_LABEL[s.kind]}
              </span>
              <span className="font-medium">{s.label}</span>
              <code className="text-xs text-stone-500">
                {s.kind === "evm"
                  ? `${s.address.slice(0, 6)}…${s.address.slice(-4)} · ${s.chains
                      .map((c) => EVM_CHAINS[c].name)
                      .join(", ")}`
                  : s.kind === "btc"
                    ? `${s.frozenAddresses?.length ? `주소 ${s.frozenAddresses.length}개 (xpub 지움)` : mask(s.input)} · ${new URL(s.esploraUrl).host}`
                    : s.kind === "csv"
                      ? `파일 ${s.imports.length}개 가져옴`
                      : s.kind === "xapi"
                        ? `${API_EXCHANGES[s.exchange].name} · ${mask(s.apiKey)}`
                        : mask(s.apiKey)}
              </code>
              {s.kind === "csv" && <CsvLink source={s} all={sources ?? []} />}
              {s.kind === "btc" && <ForgetXpub source={s} />}
              <button
                onClick={() => removeSource(s.id)}
                className="ml-auto text-xs text-red-600 hover:underline"
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <BtcForm />
        <EvmForm />
        <CsvImportCard />
        <BinanceForm />
        <OkxForm />
        <XapiForm />
      </div>
    </div>
  );
}
