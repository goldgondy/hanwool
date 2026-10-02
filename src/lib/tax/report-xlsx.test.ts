import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import ExcelJS from "exceljs";
import { runEngine } from "./engine";
import { assetSummary, buildTaxWorkbook } from "./report-xlsx";

const T = Date.UTC(2027, 2, 1);
const d = (n: number | string) => new Decimal(n);

describe("신고 자료 엑셀", () => {
  const engine = runEngine(
    [
      { type: "acquire", time: T, asset: "BTC", qty: d(1), costKrw: d(50_000_000), ref: "a1" },
      { type: "dispose", time: T + 1000, asset: "BTC", qty: d("0.5"), proceedsKrw: d(40_000_000), feeKrw: d(20_000), ref: "s1" },
      { type: "acquire", time: T, asset: "ETH", qty: d(10), costKrw: d(40_000_000), ref: "a2" },
      { type: "dispose", time: T + 2000, asset: "ETH", qty: d(10), proceedsKrw: d(30_000_000), feeKrw: d(0), ref: "s2" },
    ],
    {},
  );

  it("연도·자산별 합계", () => {
    const rows = assetSummary(engine.disposals.filter((x) => x.taxable));
    expect(rows.map((r) => [r.year, r.asset, r.gain.toNumber()])).toEqual([
      [2027, "BTC", 14_980_000],
      [2027, "ETH", -10_000_000],
    ]);
  });

  it("시트와 요약 숫자가 엔진 결과와 같다", async () => {
    const blob = await buildTaxWorkbook({ mode: "actual", engine, built: { events: [], unresolved: [], unpriced: [], pools: new Set() } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await blob.arrayBuffer());
    expect(wb.worksheets.map((w) => w.name)).toEqual(["신고요약", "자산별손익", "양도명세", "확인필요"]);
    const summary = wb.getWorksheet("신고요약")!;
    const row = summary.getRow(2);
    const y = engine.years[0];
    expect(row.getCell(1).value).toBe(2027);
    expect(row.getCell(8).value).toBe(Number(y.netKrw.toFixed(0))); // 소득금액
    expect(row.getCell(10).value).toBe(Number(y.taxableKrw.toFixed(0))); // 과세표준
    expect(row.getCell(13).value).toBe(Number(y.totalTaxKrw.toFixed(0)));
    expect(wb.getWorksheet("양도명세")!.rowCount).toBe(3);
  });
});
