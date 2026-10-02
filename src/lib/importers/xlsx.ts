// 엑셀(.xlsx) 파일 → 칸 배열. 첫 시트를 화면에 보이는 글자 그대로 읽는다 (예: "0.02281208 BTC").
// 옛 엑셀 형식(.xls)은 읽지 못한다 → 화면에서 "다른 이름으로 저장 → .xlsx 또는 CSV"를 안내한다.

export async function readXlsxRows(buf: ArrayBuffer): Promise<string[][]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let i = 1; i <= row.cellCount; i++) {
      const cell = row.getCell(i);
      cells.push(cellText(cell.value, cell.text));
    }
    rows.push(cells);
  });
  return rows;
}

// 날짜 칸은 엑셀이 표시한 그대로가 아니라 Date로 오므로 "YYYY-MM-DD HH:mm:ss"로 바꾼다.
// 엑셀 날짜에는 시간대가 없어 ExcelJS는 표시 시각을 UTC로 담아 준다 → UTC 값 그대로 꺼내면 화면에 보인 시각이다.
function cellText(value: unknown, text: string): string {
  if (value instanceof Date) {
    return value.toISOString().replace("T", " ").slice(0, 19);
  }
  return (text ?? "").trim();
}

export function isXlsx(buf: ArrayBuffer) {
  const b = new Uint8Array(buf.slice(0, 4));
  return b[0] === 0x50 && b[1] === 0x4b; // ZIP ("PK")
}

export function isOldXls(buf: ArrayBuffer) {
  const b = new Uint8Array(buf.slice(0, 4));
  return b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0; // OLE2 (엑셀 97-2003)
}
