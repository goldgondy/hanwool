import Decimal from "@/lib/decimal";
import type { BuildEventsResult } from "@/lib/tax/build-events";
import type { Disposal, EngineResult } from "@/lib/tax/engine";
import { CATEGORY_LABEL } from "@/lib/classify/types";

// 세금 계산 결과 → 신고용 엑셀. 브라우저에서 만들어 내려받는다 (서버로 보내지 않음).
// 시트: 신고요약(연도별) · 자산별손익 · 양도명세 · 의제취득가 · 확인필요

export interface TaxReportInput {
  mode: "actual" | "simulate";
  engine: EngineResult;
  built: BuildEventsResult;
}

// 원화 금액은 원 단위 정수로 (엑셀에서 숫자로 계산할 수 있게 number로 넣는다)
const won = (d: Decimal) => Number(d.toFixed(0));
const kst = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
const yearOfKst = (ms: number) => new Date(ms + 9 * 3600_000).getUTCFullYear();
const isFee = (d: Disposal) => d.ref.endsWith(":gas") || d.proceedsKrw.isZero();

export interface AssetRow {
  year: number;
  asset: string;
  count: number;
  qty: Decimal;
  proceeds: Decimal;
  cost: Decimal;
  fee: Decimal;
  gain: Decimal;
}

// 연도·자산별 합계 (테스트에서도 쓴다)
export function assetSummary(disposals: Disposal[]): AssetRow[] {
  const map = new Map<string, AssetRow>();
  for (const d of disposals) {
    const year = yearOfKst(d.time);
    const key = `${year}:${d.asset}`;
    const r = map.get(key) ?? { year, asset: d.asset, count: 0, qty: new Decimal(0), proceeds: new Decimal(0), cost: new Decimal(0), fee: new Decimal(0), gain: new Decimal(0) };
    r.count++;
    r.qty = r.qty.plus(d.qty);
    r.proceeds = r.proceeds.plus(d.proceedsKrw);
    r.cost = r.cost.plus(d.costKrw);
    r.fee = r.fee.plus(d.feeKrw);
    r.gain = r.gain.plus(d.gainKrw);
    map.set(key, r);
  }
  return [...map.values()].sort((a, b) => a.year - b.year || b.gain.abs().comparedTo(a.gain.abs()));
}

export async function buildTaxWorkbook({ mode, engine, built }: TaxReportInput): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "crypto-tax-engine";
  wb.created = new Date();
  const disposals = engine.disposals.filter((d) => d.taxable).sort((a, b) => a.time - b.time);
  const money = "#,##0";

  const sheet = (name: string, columns: { header: string; key: string; width: number; money?: boolean }[]) => {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.money ? { numFmt: money } : {} }));
    ws.getRow(1).font = { bold: true };
    return ws;
  };

  // 1) 신고요약
  const summary = sheet("신고요약", [
    { header: "귀속연도", key: "year", width: 10 },
    { header: "양도 건수", key: "count", width: 10 },
    { header: "양도가액 합계", key: "proceeds", width: 18, money: true },
    { header: "취득가액 합계", key: "cost", width: 18, money: true },
    { header: "필요경비(수수료) 합계", key: "fee", width: 20, money: true },
    { header: "양도 이익 합계", key: "gain", width: 18, money: true },
    { header: "양도 손실 합계", key: "loss", width: 18, money: true },
    { header: "소득금액(손익 통산)", key: "net", width: 20, money: true },
    { header: "기본공제", key: "deduction", width: 14, money: true },
    { header: "과세표준", key: "taxable", width: 18, money: true },
    { header: "소득세(20%)", key: "income", width: 16, money: true },
    { header: "지방소득세(2%)", key: "local", width: 16, money: true },
    { header: "예상 세액 합계", key: "total", width: 18, money: true },
  ]);
  for (const y of engine.years) {
    const ds = disposals.filter((d) => yearOfKst(d.time) === y.year);
    const sum = (f: (d: Disposal) => Decimal) => ds.reduce((s, d) => s.plus(f(d)), new Decimal(0));
    summary.addRow({
      year: y.year,
      count: y.disposalCount,
      proceeds: won(sum((d) => d.proceedsKrw)),
      cost: won(sum((d) => d.costKrw)),
      fee: won(sum((d) => d.feeKrw)),
      gain: won(y.gainKrw),
      loss: won(y.lossKrw),
      net: won(y.netKrw),
      deduction: won(y.deductionKrw),
      taxable: won(y.taxableKrw),
      income: won(y.incomeTaxKrw),
      local: won(y.localTaxKrw),
      total: won(y.totalTaxKrw),
    });
  }
  summary.addRow({});
  summary.addRow({ year: mode === "simulate" ? "※ 모의 계산: 모든 거래에 과세한다고 가정한 참고용 결과입니다 (실제 과세는 2027년부터)." : "※ 추정치입니다. 신고 전에 세무 전문가의 검토를 받으세요." });
  summary.addRow({ year: "※ 취득가액 산정: 이동평균법. 2027-01-01 이전 보유분은 실제 취득가액과 2026-12-31 시가 중 큰 금액(의제취득가액)." });

  // 2) 자산별손익
  const byAsset = sheet("자산별손익", [
    { header: "귀속연도", key: "year", width: 10 },
    { header: "자산", key: "asset", width: 14 },
    { header: "양도 건수", key: "count", width: 10 },
    { header: "양도 수량", key: "qty", width: 20 },
    { header: "양도가액", key: "proceeds", width: 18, money: true },
    { header: "취득가액", key: "cost", width: 18, money: true },
    { header: "필요경비", key: "fee", width: 14, money: true },
    { header: "손익", key: "gain", width: 18, money: true },
  ]);
  for (const r of assetSummary(disposals)) {
    byAsset.addRow({ year: r.year, asset: r.asset, count: r.count, qty: r.qty.toString(), proceeds: won(r.proceeds), cost: won(r.cost), fee: won(r.fee), gain: won(r.gain) });
  }

  // 3) 양도명세
  const detail = sheet("양도명세", [
    { header: "일시(KST)", key: "time", width: 20 },
    { header: "귀속연도", key: "year", width: 10 },
    { header: "자산", key: "asset", width: 12 },
    { header: "구분", key: "type", width: 10 },
    { header: "수량", key: "qty", width: 22 },
    { header: "양도가액", key: "proceeds", width: 16, money: true },
    { header: "취득가액", key: "cost", width: 16, money: true },
    { header: "필요경비", key: "fee", width: 12, money: true },
    { header: "손익", key: "gain", width: 16, money: true },
    { header: "거래 참조", key: "ref", width: 40 },
  ]);
  for (const d of disposals) {
    detail.addRow({
      time: kst(d.time),
      year: yearOfKst(d.time),
      asset: d.asset,
      type: isFee(d) ? "수수료" : "양도",
      qty: d.qty.toString(),
      proceeds: won(d.proceedsKrw),
      cost: won(d.costKrw),
      fee: won(d.feeKrw),
      gain: won(d.gainKrw),
      ref: d.ref,
    });
  }

  // 4) 의제취득가
  if (mode === "actual" && engine.deemed.length) {
    const deemed = sheet("의제취득가", [
      { header: "자산", key: "asset", width: 14 },
      { header: "2026년 말 보유 수량", key: "qty", width: 22 },
      { header: "실제 취득가액", key: "actual", width: 18, money: true },
      { header: "2026-12-31 시가 × 수량", key: "fair", width: 22, money: true },
      { header: "적용 취득가액", key: "applied", width: 18, money: true },
    ]);
    for (const d of engine.deemed) {
      deemed.addRow({ asset: d.asset, qty: d.qty.toString(), actual: won(d.actualCostKrw), fair: d.fairValueKrw ? won(d.fairValueKrw) : "시가 없음", applied: won(d.appliedCostKrw) });
    }
  }

  // 5) 확인필요
  const checks = sheet("확인필요", [
    { header: "구분", key: "kind", width: 16 },
    { header: "일시(KST)", key: "time", width: 20 },
    { header: "자산·분류", key: "what", width: 24 },
    { header: "금액(원)", key: "value", width: 16, money: true },
    { header: "내용", key: "message", width: 80 },
  ]);
  for (const u of built.unresolved) {
    checks.addRow({ kind: "확인하지 않은 거래", time: kst(u.time), what: CATEGORY_LABEL[u.category], value: u.valueKrw ? won(u.valueKrw) : "금액 미상", message: "기본 정책으로 계산함 (외부로 보냄 = 시가로 양도, 외부에서 받음 = 취득가 0원)" });
  }
  for (const u of built.unpriced) checks.addRow({ kind: "시세 없음", time: kst(u.time), what: u.pool, message: "원화 시세를 찾지 못해 0원으로 계산함" });
  for (const w of engine.warnings) checks.addRow({ kind: "계산 경고", time: w.time ? kst(w.time) : "", what: w.asset ?? "", message: w.message });

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
