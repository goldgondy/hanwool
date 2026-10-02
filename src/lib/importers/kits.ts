import type { CsvSource, Source } from "@/lib/db";
import { ADAPTERS } from "./index";
import type { CsvAdapter, CsvTable } from "./types";

// 거래소별로 필요한 파일 목록. 빗썸·업비트·바이낸스는 파일 하나에 거래와 입출금이 모두 있고,
// OKX는 거래 내역·입금 내역·출금 내역이 따로 나뉜다. 하나라도 빠지면 코인의 출처가 끊겨 세금이 많이 계산된다.

export interface KitPart {
  key: string;
  label: string;
  howTo: string;
}

export const KITS: Record<string, KitPart[]> = {
  okx: [
    { key: "okx:trading", label: "거래 내역", howTo: "자산 → 주문 센터·내역 → 거래 계정(Trading account) 내역 → 다운로드" },
    { key: "okx:deposit", label: "입금 내역", howTo: "자산 → 입금 내역(Deposit history) → 다운로드" },
    { key: "okx:withdrawal", label: "출금 내역", howTo: "자산 → 출금 내역(Withdrawal history) → 다운로드" },
  ],
  bithumb: [{ key: "bithumb:all", label: "기간별 거래 내역 (입출금 포함)", howTo: "입출금 → 거래내역 → 기간 선택 → 엑셀 다운로드" }],
  upbit: [{ key: "upbit:all", label: "거래내역 (종류 ‘전체’)", howTo: "투자내역 → 거래내역 → 종류 전체 → 표 복사·붙여넣기" }],
  binance: [{ key: "binance:all", label: "전체 거래 명세서", howTo: "지갑 → 거래 내역 → 내보내기" }],
};

export function partsOf(adapter: CsvAdapter, table: CsvTable): string[] {
  return adapter.parts?.(table) ?? [`${adapter.exchange}:all`];
}

// 예전에 가져온 기록(parts를 남기기 전)은 형식 ID로 추정한다
function importParts(imp: CsvSource["imports"][number], exchange: string): string[] {
  if (imp.parts) return imp.parts;
  if (imp.format === "okx-account-history-v1") return ["okx:trading"];
  const adapter = ADAPTERS.find((a) => a.id === imp.format);
  return adapter?.parts ? [] : [`${exchange}:all`];
}

export type PartState = "done" | "api" | "missing";

export interface KitRow extends KitPart {
  state: PartState;
  files: number;
  from?: number;
  to?: number;
}

// API로 보완되는 부분: 같은 계정의 API가 연결되어 있으면 입출금은 API에서 온다 (최근 기간만일 수 있음)
const API_COVERS = new Set(["okx:deposit", "okx:withdrawal"]);

export function kitStatus(source: CsvSource, all: Source[] = []): KitRow[] | null {
  const kit = KITS[source.exchange];
  if (!kit) return null;
  const linked = !!source.linkedSourceId && all.some((s) => s.id === source.linkedSourceId);
  return kit.map((part) => {
    const imps = source.imports.filter((imp) => importParts(imp, source.exchange).includes(part.key));
    const froms = imps.map((i) => i.from).filter((x): x is number => x !== undefined);
    const tos = imps.map((i) => i.to).filter((x): x is number => x !== undefined);
    return {
      ...part,
      state: imps.length ? "done" : linked && API_COVERS.has(part.key) ? "api" : "missing",
      files: imps.length,
      from: froms.length ? Math.min(...froms) : undefined,
      to: tos.length ? Math.max(...tos) : undefined,
    };
  });
}

// 첫 화면 준비도용: 빠진 파일 목록 ("OKX (파일): 입금 내역")
export function missingFiles(sources: Source[]): string[] {
  return sources.flatMap((s) =>
    s.kind === "csv" ? (kitStatus(s, sources) ?? []).filter((p) => p.state === "missing").map((p) => `${s.label}: ${p.label}`) : [],
  );
}
