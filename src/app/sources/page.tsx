"use client";

import { useState, type FormEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, getSetting, setSetting, type EvmChain } from "@/lib/db";
import { EVM_CHAINS } from "@/lib/sources/evm";
import { encrypt } from "@/lib/vault";
import { useVaultUnlocked, VaultPanel } from "@/components/VaultPanel";

const input =
  "w-full rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm dark:border-stone-700";
const button =
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

const KIND_LABEL = { binance: "Binance", okx: "OKX", evm: "EVM" } as const;

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

function AlchemyKeyForm() {
  const saved = useLiveQuery(() => getSetting("alchemyKey"), []);
  const [key, setKey] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await setSetting("alchemyKey", key.trim());
    setKey("");
  }

  return (
    <form onSubmit={onSubmit} className={card}>
      <h3 className="font-semibold">Alchemy API 키</h3>
      <p className="text-xs leading-5 text-stone-500">
        지갑 잔고 조회에 사용합니다. alchemy.com에서 무료로 발급받을 수 있고,
        브라우저에서 Alchemy로 직접 요청합니다.
        {saved && <> 현재 저장된 키: <code>{mask(saved)}</code></>}
      </p>
      <input className={input} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Alchemy API Key" required />
      <button className={button}>저장</button>
    </form>
  );
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
                {s.kind !== "evm"
                  ? mask(s.apiKey)
                  : `${s.address.slice(0, 6)}…${s.address.slice(-4)} · ${s.chains
                      .map((c) => EVM_CHAINS[c].name)
                      .join(", ")}`}
              </code>
              <button
                onClick={() => db.sources.delete(s.id)}
                className="ml-auto text-xs text-red-600 hover:underline"
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <BinanceForm />
        <OkxForm />
        <EvmForm />
        <AlchemyKeyForm />
      </div>
    </div>
  );
}
