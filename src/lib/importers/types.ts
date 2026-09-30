import type { LedgerEntry } from "@/lib/db";

// 거래소 CSV 변환기. 설계: docs/architecture.md §4 "CSV 표준화"
// 모든 변환기는 공통 원장(LedgerEntry)으로 바꾼다. 분류·세액 계산은 원장만 보고 하므로 거래소 차이는 여기서 끝난다.

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

export interface ImportResult {
  entries: LedgerEntry[];
  warnings: string[];
  unknownTypes: string[]; // 변환기가 모르는 거래 유형 (검토 필요로 들어감)
  range: { from: number; to: number } | null;
  rowCount: number;
}

export interface CsvAdapter {
  id: string; // 형식 ID (예: binance-statement-v1). 거래소가 형식을 바꾸면 새 버전을 추가한다.
  exchange: string; // 거래소 ID (예: binance)
  exchangeName: string; // 표시 이름
  formatName: string; // 사용자에게 보여 줄 파일 종류 (예: 전체 거래 명세서)
  howToExport: string; // 파일 받는 방법 안내
  verified: boolean; // 실제 샘플 파일로 검증했는지
  detect(headers: string[]): boolean;
  convert(table: CsvTable, sourceId: string): ImportResult;
}
