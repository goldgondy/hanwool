import type { CsvSource, ManualSource, Source } from "@/lib/db";

// 잔고 대사 단위(계정) 묶기.
// - 실제 잔고를 조회할 수 있는 계정(지갑, 거래소 API)이 대표가 된다.
// - 대표와 "같은 계정"으로 연결된 CSV 계정은 함께 묶어 원장을 합친다.
// - 연결되지 않은 CSV 계정은 실제 잔고를 알 수 없어 대사할 수 없다. 직접 입력한 거래도 대사 대상이 아니다.

export type LiveSource = Exclude<Source, CsvSource | ManualSource>;

export interface Account {
  key: string;
  label: string;
  primary: LiveSource;
  memberIds: string[];
}

export function buildAccounts(sources: Source[]): { accounts: Account[]; csvOnly: CsvSource[] } {
  const accounts: Account[] = [];
  const linkedCsv = new Set<string>();
  for (const s of sources) {
    if (s.kind === "csv" || s.kind === "manual") continue;
    const csvs = sources.filter((c): c is CsvSource => c.kind === "csv" && c.linkedSourceId === s.id);
    csvs.forEach((c) => linkedCsv.add(c.id));
    accounts.push({
      key: s.id,
      label: csvs.length ? `${s.label} + ${csvs.map((c) => c.label).join(", ")}` : s.label,
      primary: s,
      memberIds: [s.id, ...csvs.map((c) => c.id)],
    });
  }
  const csvOnly = sources.filter((s): s is CsvSource => s.kind === "csv" && !linkedCsv.has(s.id));
  return { accounts, csvOnly };
}
