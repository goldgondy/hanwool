"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { isVaultInitialized, lockVault } from "@/lib/vault";
import { reconcileStatus } from "@/lib/readiness";
import { missingFiles } from "@/lib/importers/kits";
import { useVaultUnlocked, VaultPanel } from "@/components/VaultPanel";

// 왼쪽 메뉴: 신고 준비 단계(1~4)와 도구. 휴대폰에서는 위쪽 막대의 메뉴 버튼으로 연다.

interface Item {
  href: string;
  label: string;
  step?: number;
}

const STEPS: Item[] = [
  { href: "/sources", label: "계정 연결", step: 1 },
  { href: "/reconcile", label: "동기화·잔고 대사", step: 2 },
  { href: "/review", label: "분류 검토", step: 3 },
  { href: "/tax", label: "세금 계산·신고", step: 4 },
];

const TOOLS: Item[] = [
  { href: "/plan", label: "절세 도구" },
  { href: "/foreign", label: "해외계좌 신고" },
  { href: "/snapshots", label: "보유 기록" },
  { href: "/ledger", label: "거래 원장" },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ item, active, badge, done, onNavigate }: { item: Item; active: boolean; badge?: number; done?: boolean; onNavigate: () => void }) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300"
          : "text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800/60 dark:hover:text-stone-100"
      }`}
    >
      {item.step ? (
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
            done
              ? "bg-emerald-500 text-white"
              : active
                ? "bg-indigo-600 text-white dark:bg-indigo-500"
                : "bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-400"
          }`}
        >
          {done ? "✓" : item.step}
        </span>
      ) : (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-indigo-600 dark:bg-indigo-400" : "bg-stone-300 dark:bg-stone-700"}`} />
        </span>
      )}
      <span className="flex-1">{item.label}</span>
      {badge ? <span className="rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">{badge}</span> : null}
    </Link>
  );
}

// 거래소 키 잠금 상태. 거래소 키를 쓰는 기능(잔고 조회·동기화) 전에 한 번 해제한다.
function VaultStatus() {
  const initialized = useLiveQuery(() => isVaultInitialized(), []);
  const unlocked = useVaultUnlocked();
  const [open, setOpen] = useState(false);
  if (!initialized) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-lg border border-stone-200 px-3 py-2 text-xs dark:border-stone-800">
        <span className={`h-2 w-2 rounded-full ${unlocked ? "bg-emerald-500" : "bg-stone-400"}`} />
        <span className="flex-1">{unlocked ? "거래소 키 잠금 해제됨" : "거래소 키 잠김"}</span>
        {unlocked ? (
          <button onClick={lockVault} className="font-medium text-stone-500 underline-offset-2 hover:underline">
            잠그기
          </button>
        ) : (
          <button onClick={() => setOpen(!open)} className="font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400">
            {open ? "닫기" : "해제"}
          </button>
        )}
      </div>
      {open && !unlocked && <VaultPanel compact />}
    </div>
  );
}

function NavBody({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const sources = useLiveQuery(() => db.sources.toArray(), []);
  const recon = useLiveQuery(() => reconcileStatus(), []);
  const done: Record<string, boolean> = {
    "/sources": (sources?.length ?? 0) > 0 && missingFiles(sources ?? []).length === 0,
    "/reconcile": !!recon?.ran && recon.open === 0,
  };
  const badge: Record<string, number | undefined> = { "/reconcile": recon?.open || undefined };

  return (
    <div className="flex h-full flex-col gap-6">
      <nav className="space-y-6">
        <NavLink item={{ href: "/", label: "홈" }} active={pathname === "/"} onNavigate={onNavigate} />
        <div className="space-y-1">
          <p className="px-3 pb-1 text-xs font-semibold text-stone-400">신고 준비</p>
          {STEPS.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} done={done[item.href]} badge={badge[item.href]} onNavigate={onNavigate} />
          ))}
        </div>
        <div className="space-y-1">
          <p className="px-3 pb-1 text-xs font-semibold text-stone-400">도구</p>
          {TOOLS.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} onNavigate={onNavigate} />
          ))}
        </div>
      </nav>
      <div className="mt-auto space-y-3">
        <VaultStatus />
        <p className="px-1 text-xs leading-5 text-stone-400">🔐 거래 내역과 키는 이 브라우저에만 저장됩니다.</p>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-lg font-bold text-white shadow-sm">₿</span>
      <span className="leading-tight">
        <span className="block text-base font-bold tracking-tight">B택스</span>
        <span className="block text-[11px] text-stone-500">가상자산 세금 준비</span>
      </span>
    </Link>
  );
}

export function AppNav() {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* 넓은 화면: 고정 사이드바 */}
      <aside className="no-print sticky top-0 hidden h-screen w-64 shrink-0 flex-col gap-8 border-r border-stone-200 bg-white px-4 py-6 lg:flex dark:border-stone-800 dark:bg-stone-950">
        <div className="px-2">
          <Brand />
        </div>
        <NavBody onNavigate={() => {}} />
      </aside>

      {/* 좁은 화면: 위쪽 막대 + 펼침 메뉴 */}
      <header className="no-print sticky top-0 z-30 flex items-center justify-between border-b border-stone-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden dark:border-stone-800 dark:bg-stone-950/90">
        <Brand />
        <button onClick={() => setOpen(!open)} className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm dark:border-stone-700" aria-expanded={open}>
          {open ? "닫기" : "메뉴"}
        </button>
      </header>
      {open && (
        <div className="no-print fixed inset-0 top-[57px] z-20 overflow-y-auto bg-white px-4 py-6 lg:hidden dark:bg-stone-950">
          <NavBody onNavigate={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
