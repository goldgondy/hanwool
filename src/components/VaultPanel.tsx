"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  initVault,
  isUnlocked,
  isVaultInitialized,
  lockVault,
  resetVault,
  subscribeVault,
  unlockVault,
} from "@/lib/vault";

export function useVaultUnlocked() {
  return useSyncExternalStore(subscribeVault, isUnlocked, () => false);
}

const input =
  "rounded-lg border border-stone-300 bg-transparent px-3 py-2 text-sm dark:border-stone-700";
const button =
  "rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900";

export function VaultPanel() {
  const initialized = useLiveQuery(() => isVaultInitialized(), []);
  const unlocked = useVaultUnlocked();
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setPass("");
      setConfirm("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (initialized === undefined) return null;

  if (unlocked) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm dark:border-emerald-800 dark:bg-emerald-950/40">
        <span>🔓 잠금 해제됨. 이 탭을 닫거나 새로고침하면 다시 잠깁니다.</span>
        <button onClick={lockVault} className="ml-auto text-xs underline">
          지금 잠그기
        </button>
      </div>
    );
  }

  if (!initialized) {
    const tooShort = pass.length < 8;
    const mismatch = pass !== confirm;
    return (
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          run(() => initVault(pass));
        }}
        className="space-y-3 rounded-xl border border-stone-200 p-5 dark:border-stone-800"
      >
        <h3 className="font-semibold">암호화 비밀번호 설정</h3>
        <p className="text-xs leading-5 text-stone-500">
          거래소 API Secret은 이 비밀번호로 암호화되어 브라우저에 저장됩니다.
          비밀번호는 어디에도 저장되지 않으므로 <b>잊어버리면 복구할 수 없고</b>,
          거래소 키를 다시 등록해야 합니다.
        </p>
        <div className="flex flex-wrap gap-2">
          <input className={input} type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="비밀번호 (8자 이상)" autoComplete="new-password" />
          <input className={input} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="비밀번호 확인" autoComplete="new-password" />
          <button className={button} disabled={busy || tooShort || mismatch}>
            {busy ? "설정 중…" : "설정"}
          </button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    );
  }

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        run(() => unlockVault(pass));
      }}
      className="space-y-3 rounded-xl border border-stone-200 p-5 dark:border-stone-800"
    >
      <h3 className="font-semibold">🔒 잠금 해제</h3>
      <div className="flex flex-wrap gap-2">
        <input className={input} type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="암호화 비밀번호" autoComplete="current-password" />
        <button className={button} disabled={busy || !pass}>
          {busy ? "확인 중…" : "해제"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!confirmReset ? (
        <button type="button" onClick={() => setConfirmReset(true)} className="text-xs text-stone-500 underline">
          비밀번호를 잊었어요
        </button>
      ) : (
        <div className="space-y-2 rounded-lg bg-red-50 p-3 text-xs dark:bg-red-950/40">
          <p>
            초기화하면 등록된 <b>거래소 키(바이낸스, OKX)가 모두 삭제</b>됩니다.
            지갑 주소와 스냅샷은 유지됩니다.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => run(async () => { await resetVault(); setConfirmReset(false); })}
              className="font-medium text-red-600 underline"
            >
              초기화
            </button>
            <button type="button" onClick={() => setConfirmReset(false)} className="underline">
              취소
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
