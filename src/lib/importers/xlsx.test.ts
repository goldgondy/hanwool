import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { isOldXls, isXlsx, readXlsxRows } from "./xlsx";
import { detectRows } from "./index";

async function bithumbXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Bithumb 기간별 거래 내역"]);
  ws.addRow(["기간 : 2026-01-01 00:00:00 ~ 2026-06-29 00:00:59"]);
  ws.addRow(["거래일시", "자산", "거래구분", "거래수량", "체결가격", "거래금액", "수수료", "정산금액"]);
  // 날짜 칸이 엑셀 날짜 값인 경우 (표시 시각 그대로 UTC로 담긴다)
  ws.addRow([new Date(Date.UTC(2026, 5, 12, 12, 18, 21)), "비트코인", "매도", "0.02281208 BTC", "95,340,000.0000 KRW", "2,174,904 KRW", "869.96 KRW", "+2,174,034 KRW"]);
  ws.addRow(["2026-06-09 09:03:57", "원화", "입금", "5,000,000 KRW", "-", "5,000,000 KRW", "- KRW", "+5,000,000 KRW"]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

describe("엑셀 파일 읽기", () => {
  it("xlsx를 칸 배열로 읽고 빗썸 형식을 찾는다", async () => {
    const buf = await bithumbXlsx();
    expect(isXlsx(buf)).toBe(true);
    expect(isOldXls(buf)).toBe(false);
    const rows = await readXlsxRows(buf);
    expect(rows[3][0]).toBe("2026-06-12 12:18:21");
    const found = detectRows(rows);
    if (!found.adapter) throw new Error("not detected");
    const { entries } = found.adapter.convert(found.table, "s");
    // 12:18:21 한국 시각 = 03:18:21 UTC
    expect(entries[0].time).toBe(Date.UTC(2026, 5, 12, 3, 18, 21));
    expect(entries.filter((e) => e.rawType === "입금").map((e) => e.amount)).toEqual(["5000000"]);
  });
});
