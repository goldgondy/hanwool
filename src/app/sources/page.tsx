"use client";

import { useState, type FormEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type EvmChain } from "@/lib/db";
import { EVM_CHAINS } from "@/lib/sources/evm";
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

function BinanceForm() {
  const unlocked = useVaultUnlocked();
  const [label, setLabel] = useState("Binance");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
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
      <button className={button} disabled={!unlocked}>추가</button>
    </form>
  );
}

const KIND_LABEL = { binance: "Binance", okx: "OKX", evm: "EVM", btc: "Bitcoin" } as const;

function preview(input: string, scriptType: ScriptType | "") {
  if (!input.trim()) return null;
  try {
    const w = parseWalletInput(input, scriptType || undefined);
    if (w.kind === "address") return { ok: true as const, text: "단일 주소", isXpub: false };
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!p?.ok) return;
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
      <button className={button} disabled={!p?.ok}>
        추가
      </button>
    </form>
  );
}

function EvmForm() {
  const [label, setLabel] = useState("내 지갑");
  const [address, setAddress] = useState("");
  const [chains, setChains] = useState<EvmChain[]>(["eth", "arb", "base"]);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim());

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || chains.length === 0) return;
    await db.sources.add({
      id: crypto.randomUUID(),
      kind: "evm",
      label: label.trim() || "내 지갑",
      address: address.trim(),
      chains,
      createdAt: Date.now(),
    });
    setAddress("");
  }

  return (
    <form onSubmit={onSubmit} className={card}>
      <h3 className="font-semibold">EVM 지갑 주소</h3>
      <p className="text-xs leading-5 text-stone-500">
        공개 블록체인 데이터(Blockscout)를 조회하므로 API 키가 필요 없습니다. 주소만으로는 자산을
        옮길 수 없지만, <b>복구 문구(시드)나 개인키는 절대 입력하지 마세요.</b>
      </p>
      <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="이름" />
      <input className={input} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" required />
      <div className="flex flex-wrap gap-3 text-sm">
        {(Object.keys(EVM_CHAINS) as EvmChain[]).map((c) => (
          <label key={c} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={chains.includes(c)}
              onChange={(e) =>
                setChains(e.target.checked ? [...chains, c] : chains.filter((x) => x !== c))
              }
            />
            {EVM_CHAINS[c].name}
          </label>
        ))}
      </div>
      <button className={button} disabled={!valid || chains.length === 0}>
        추가
      </button>
    </form>
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
                    ? `${mask(s.input)} · ${new URL(s.esploraUrl).host}`
                    : mask(s.apiKey)}
              </code>
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
        <BinanceForm />
        <OkxForm />
      </div>
    </div>
  );
}
