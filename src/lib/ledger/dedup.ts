import type { LedgerEntry, Source } from "@/lib/db";

// 같은 거래소 계정을 CSV와 API로 함께 연결했을 때의 중복 제거.
// - CSV 계정이 API 계정과 연결되어 있으면(linkedSourceId), CSV가 덮는 기간(첫 행 ~ 마지막 행)은 CSV를 기준으로 하고
//   그 기간 안의 API 항목은 뺀다. 기간 밖(CSV 이전·이후)은 API 항목을 그대로 쓴다.
//   → "과거는 CSV, 이후는 API" 흐름과, 중간 기간만 CSV로 올린 경우를 모두 처리한다.
// - 연결되지 않은 CSV·API는 서로 다른 계정으로 보고 둘 다 쓴다 (같은 거래소에 계정이 여러 개일 수 있다).

export interface Coverage {
  csvSourceId: string;
  apiSourceId: string;
  from: number;
  to: number;
}

export function csvCoverage(entries: LedgerEntry[], sources: Source[]): Coverage[] {
  const out: Coverage[] = [];
  for (const s of sources) {
    if (s.kind !== "csv" || !s.linkedSourceId) continue;
    const times = entries.filter((e) => e.sourceId === s.id).map((e) => e.time);
    if (times.length === 0) continue;
    out.push({ csvSourceId: s.id, apiSourceId: s.linkedSourceId, from: Math.min(...times), to: Math.max(...times) });
  }
  return out;
}

export interface DedupResult {
  entries: LedgerEntry[];
  dropped: number; // CSV 기간과 겹쳐 뺀 API 항목 수
}

export function applyCsvCoverage(entries: LedgerEntry[], sources: Source[]): DedupResult {
  const coverage = csvCoverage(entries, sources);
  if (coverage.length === 0) return { entries, dropped: 0 };
  const byApi = new Map<string, Coverage[]>();
  for (const c of coverage) byApi.set(c.apiSourceId, [...(byApi.get(c.apiSourceId) ?? []), c]);

  const kept = entries.filter((e) => {
    const covers = byApi.get(e.sourceId);
    return !covers?.some((c) => e.time >= c.from && e.time <= c.to);
  });
  return { entries: kept, dropped: entries.length - kept.length };
}

// 잔고 스냅샷에서 뺄 CSV 계정: API 계정과 연결되어 있으면 API 실시간 잔고만 쓴다.
export function csvSourcesShadowedByApi(sources: Source[]): Set<string> {
  const ids = new Set(sources.map((s) => s.id));
  return new Set(sources.filter((s) => s.kind === "csv" && s.linkedSourceId && ids.has(s.linkedSourceId)).map((s) => s.id));
}
