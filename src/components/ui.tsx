import type { ReactNode } from "react";

// 화면 공통 디자인 요소. 색·간격을 한곳에서 정해 화면마다 모양이 달라지지 않게 한다.

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-400",
  secondary:
    "border border-stone-300 bg-white text-stone-800 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800",
  ghost: "text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100",
  danger: "text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40",
};
const SIZE: Record<Size, string> = {
  sm: "rounded-lg px-2.5 py-1 text-xs",
  md: "rounded-lg px-4 py-2 text-sm",
};

export function btn(variant: Variant = "primary", size: Size = "md") {
  return `inline-flex items-center justify-center gap-1.5 font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${VARIANT[variant]} ${SIZE[size]}`;
}

export const inputCls =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none transition-colors placeholder:text-stone-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-stone-700 dark:bg-stone-900";

// 표: 머리줄·칸 클래스
export const th = "py-2 pr-4 text-left text-xs font-medium text-stone-500 last:pr-0";
export const td = "py-2 pr-4 last:pr-0";
export const trCls = "border-b border-stone-100 last:border-0 dark:border-stone-800/60";

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full text-sm tabular-nums">{children}</table>
    </div>
  );
}

export function PageHeader({ title, description, actions, step }: { title: string; description?: ReactNode; actions?: ReactNode; step?: number }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-3xl space-y-1.5">
        {step && <p className="text-xs font-semibold tracking-wide text-indigo-600 dark:text-indigo-400">{step}단계</p>}
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && <p className="text-sm leading-6 text-stone-500 dark:text-stone-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "", as: Tag = "div" }: { children: ReactNode; className?: string; as?: "div" | "section" | "li" | "form" }) {
  return (
    <Tag className={`rounded-2xl border border-stone-200 bg-white p-5 shadow-sm dark:border-stone-800 dark:bg-stone-900/60 ${className}`}>{children}</Tag>
  );
}

// 제목·설명·오른쪽 버튼이 있는 카드 묶음
export function Section({ title, description, actions, children, className = "" }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card as="section" className={`space-y-4 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </Card>
  );
}

type Tone = "info" | "warn" | "danger" | "success" | "neutral";
const CALLOUT: Record<Tone, string> = {
  info: "border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200",
  warn: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  danger: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  neutral: "border-stone-200 bg-stone-50 text-stone-700 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300",
};

export function Callout({ tone = "info", title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm leading-6 ${CALLOUT[tone]}`}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>}
    </div>
  );
}

const BADGE: Record<Tone, string> = {
  info: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  danger: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  neutral: "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${BADGE[tone]}`}>{children}</span>;
}

const STAT_TONE: Record<Tone, string> = {
  info: "text-indigo-700 dark:text-indigo-400",
  warn: "text-amber-700 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
  success: "text-emerald-700 dark:text-emerald-400",
  neutral: "",
};

export function Stat({ label, value, tone = "neutral", hint }: { label: ReactNode; value: ReactNode; tone?: Tone; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900/60">
      <p className="text-xs text-stone-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums tracking-tight ${STAT_TONE[tone]}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-stone-500">{hint}</p>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500 dark:border-stone-700">{children}</div>;
}

// 알약 모양 선택 버튼 (필터·계정 고르기)
export function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
        active
          ? "border-indigo-600 bg-indigo-600 text-white dark:border-indigo-500 dark:bg-indigo-500"
          : "border-stone-300 bg-white hover:border-stone-400 dark:border-stone-700 dark:bg-stone-900"
      }`}
    >
      {children}
    </button>
  );
}

export function Progress({ text }: { text: string }) {
  if (!text) return null;
  return (
    <span className="inline-flex items-center gap-2 text-sm text-stone-500">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-300 border-t-indigo-600" />
      {text}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="text-sm text-red-600">{children}</p>;
}
