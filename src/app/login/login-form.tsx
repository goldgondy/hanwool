"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

export type Provider = "kakao" | "naver" | "google";

const PROVIDER: Record<Provider, { label: string; cls: string }> = {
  kakao: { label: "카카오로 시작하기", cls: "bg-[#FEE500] text-black/85" },
  naver: { label: "네이버로 시작하기", cls: "bg-[#03C75A] text-white" },
  google: { label: "구글로 시작하기", cls: "border border-stone-300 bg-white text-stone-800" },
};

export function LoginForm({ providers }: { providers: Provider[] }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function social(provider: Provider) {
    setError(null);
    setBusy(true);
    const { error } = await authClient.signIn.social({ provider, callbackURL: "/me" });
    if (error) {
      setError(error.message ?? "로그인을 시작하지 못했습니다");
      setBusy(false);
    }
  }

  async function magic(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error } = await authClient.signIn.magicLink({ email: email.trim(), callbackURL: "/me" });
    setBusy(false);
    if (error) setError(error.message ?? "메일을 보내지 못했습니다");
    else setSent(true);
  }

  return (
    <div className="mx-auto max-w-sm space-y-6 py-8">
      <div className="space-y-1 text-center">
        <h1 className="text-xl font-bold">로그인</h1>
        <p className="text-sm text-stone-500">처음이면 자동으로 가입됩니다.</p>
      </div>

      <div className="space-y-2">
        {providers.map((p) => (
          <button
            key={p}
            onClick={() => social(p)}
            disabled={busy}
            className={`w-full rounded-lg px-4 py-3 text-sm font-medium disabled:opacity-50 ${PROVIDER[p].cls}`}
          >
            {PROVIDER[p].label}
          </button>
        ))}
        {providers.length === 0 && (
          <p className="text-center text-xs text-stone-500">설정된 소셜 로그인이 없습니다 (.env.local의 CLIENT_ID·SECRET 확인).</p>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-stone-400">
        <div className="h-px flex-1 bg-stone-200 dark:bg-stone-800" />
        또는 이메일로
        <div className="h-px flex-1 bg-stone-200 dark:bg-stone-800" />
      </div>

      {sent ? (
        <p className="text-center text-sm">로그인 링크를 보냈습니다. 메일함을 확인하세요.</p>
      ) : (
        <form onSubmit={magic} className="space-y-2">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="이메일 주소"
            className="w-full rounded-lg border border-stone-300 bg-transparent px-3 py-2.5 text-sm dark:border-stone-700"
          />
          <button disabled={busy} className="w-full rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900">
            로그인 링크 받기
          </button>
        </form>
      )}

      {error && <p className="text-center text-sm text-red-600">{error}</p>}
    </div>
  );
}
