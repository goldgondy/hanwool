import { binanceStatement } from "./binance";
import { parseCsv } from "./csv";
import { upbitHistory } from "./upbit";
import type { CsvAdapter, CsvTable } from "./types";

// 등록된 변환기. 거래소 우선순위(세무사 제공): 바이낸스, 코인베이스, OKX, 바이비트, 빗썸, 업비트, 비트겟, MEXC, 게이트아이오
// 업비트는 파일이 아니라 화면 붙여넣기 (lib/importers/upbit.ts)
export const ADAPTERS: CsvAdapter[] = [binanceStatement, upbitHistory];

// 지원 예정 거래소 (샘플 파일 대기)
export const PLANNED_EXCHANGES = ["코인베이스", "OKX", "바이비트", "빗썸", "비트겟", "MEXC", "게이트아이오"];

export interface Detected {
  adapter: CsvAdapter;
  table: CsvTable;
}

// 파일 내용으로 변환기를 고른다. 맞는 변환기가 없으면 첫 줄의 열 이름을 돌려준다 (열 연결 화면용).
export function detect(text: string): Detected | { adapter: null; headers: string[] } {
  for (const adapter of ADAPTERS) {
    const table = parseCsv(text, (cells) => adapter.detect(cells));
    if (table) return { adapter, table };
  }
  return { adapter: null, headers: parseCsv(text)?.headers ?? [] };
}
