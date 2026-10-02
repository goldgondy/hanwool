"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  initVault,
  isUnlocked,
  isVaultInitialized,
  resetVault,
  subscribeVault,
  unlockVault,
} from "@/lib/vault";
import { btn, inputCls } from "@/components/ui";

export function useVaultUnlocked() {
  return useSyncExternalStore(subscribeVault, isUnlocked, () => false);
}

// 거래소 키 암호화 비밀번호 설정·잠금 해제. 해제된 상태는 왼쪽 메뉴 아래에 표시하므로 여기서는 아무것도 그리지 않는다.
// compact: 메뉴 안에 넣는 작은 모양
export function VaultPanel({ compact = false }: { compact?: boolean }) {
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

  if (initialized === undefined || unlocked) return null;

  const frame = compact
    ? "space-y-2"
    : "space-y-3 rounded-2xl border border-indigo-200 bg-indigo-50/60 p-5 dark:border-indigo-900 dark:bg-indigo-950/30";

  if (!initialized) {
    const tooShort = pass.length < 8;
    const mismatch = pass !== confirm;
    return (
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          run(() => initVault(pass));
        }}
        className={frame}
      >
        <h3 className="font-semibold">🔑 거래소 키 암호화 비밀번호 만들기</h3>
        <p className="text-xs leading-5 text-stone-600 dark:text-stone-400">
          거래소 API Secret은 이 비밀번호로 암호화되어 브라우저에만 저장됩니다. 비밀번호는 어디에도 저장되지 않으므로{" "}
          <b>잊어버리면 복구할 수 없고</b>, 거래소 키를 다시 등록해야 합니다.
        </p>
        <div className="flex flex-wrap gap-2">
          <input className={`${inputCls} sm:w-56`} type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="비밀번호 (8자 이상)" autoComplete="new-password" />
          <input className={`${inputCls} sm:w-56`} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="비밀번호 확인" autoComplete="new-password" />
          <button className={btn()} disabled={busy || tooShort || mismatch}>
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
      className={frame}
    >
      {!compact && (
        <div className="space-y-0.5">
          <h3 className="font-semibold">🔒 거래소 키가 잠겨 있습니다</h3>
          <p className="text-xs text-stone-600 dark:text-stone-400">거래소 잔고·내역을 불러오려면 암호화 비밀번호로 잠금을 해제하세요. 새로고침하면 다시 잠깁니다.</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          className={`${inputCls} ${compact ? "" : "sm:w-64"}`}
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="암호화 비밀번호"
          autoComplete="current-password"
        />
        <button className={`${btn()} ${compact ? "w-full" : ""}`} disabled={busy || !pass}>
          {busy ? "확인 중…" : "잠금 해제"}
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
            초기화하면 등록된 <b>거래소 API 키가 모두 삭제</b>됩니다. 지갑 주소·CSV·스냅샷은 유지됩니다.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() =>
                run(async () => {
                  await resetVault();
                  setConfirmReset(false);
                })
              }
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
