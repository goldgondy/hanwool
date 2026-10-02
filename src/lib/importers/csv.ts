import Papa from "papaparse";
import type { CsvTable } from "./types";

// CSV 텍스트 → 표. 파일 앞쪽에 안내 문구가 있는 거래소(예: 코인베이스)도 있어,
// isHeader가 참이 되는 줄을 앞 20줄 안에서 찾아 열 이름으로 쓴다.
export function parseCsv(text: string, isHeader: (cells: string[]) => boolean = () => true): CsvTable | null {
  const clean = text.replace(/^﻿/, ""); // BOM 제거
  const { data } = Papa.parse<string[]>(clean, { skipEmptyLines: "greedy" });
  return tableFromRows(data, isHeader);
}

// 칸 배열(CSV·엑셀 시트) → 표. 엑셀 파일도 같은 방식으로 열 이름 줄을 찾는다 (lib/importers/xlsx.ts).
export function tableFromRows(data: string[][], isHeader: (cells: string[]) => boolean = () => true): CsvTable | null {
  const headerIndex = data.slice(0, 20).findIndex((cells) => isHeader(cells.map((c) => (c ?? "").trim())));
  if (headerIndex < 0) return null;

  const headers = data[headerIndex].map((h) => (h ?? "").trim());
  const rows = data
    .slice(headerIndex + 1)
    .filter((cells) => cells.some((c) => (c ?? "").trim()))
    .map((cells) => {
      const row: Record<string, string> = {};
      headers.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
      return row;
    });
  return { headers, rows };
}

// 한국어 윈도우 엑셀이 저장한 CSV는 EUC-KR(CP949)이다. UTF-8로 읽어 글자가 깨지면 EUC-KR로 다시 읽는다.
export function decodeText(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("euc-kr").decode(buf);
  } catch {
    return utf8;
  }
}

// 행 내용으로 만드는 결정적 ID용 해시 (같은 파일·겹치는 기간을 다시 올려도 중복되지 않게).
// 완전히 같은 행이 여러 번 있으면 몇 번째인지(occurrence)를 붙여 구분한다.
export function rowKey(values: string[], seen: Map<string, number>): string {
  const base = cyrb53(values.join("\u0001"));
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
