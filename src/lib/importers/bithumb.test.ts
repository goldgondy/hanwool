import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import { detect, detectRows } from "./index";
import { bithumbHistory, unitOf } from "./bithumb";

// 2026-10-02 세무사 제공 빗썸 "기간별 거래 내역" 엑셀 캡처의 일부 (엑셀에서 복사하면 탭으로 나뉜다)
const SAMPLE = [
  "Bithumb 기간별 거래 내역",
  "기간 : 2026-01-01 00:00:00 ~ 2026-06-29 00:00:59",
  "거래일시\t자산\t거래구분\t거래수량\t체결가격\t거래금액\t수수료\t정산금액",
  "2026-06-12 12:18:55\t원화\t출금\t5,034,802 KRW\t-\t5,033,802 KRW\t1,000 KRW\t-5,034,802 KRW",
  "2026-06-12 12:18:21\t비트코인\t매도\t0.02281208 BTC\t95,340,000.0000 KRW\t2,174,904 KRW\t869.96 KRW\t+2,174,034 KRW",
  "2026-06-12 12:18:21\t비트코인\t매도\t0.00647141 BTC\t95,342,000.0000 KRW\t616,997 KRW\t246.79 KRW\t+616,750 KRW",
  "2026-06-12 12:15:48\t비트코인\t매수\t0.01895799 BTC\t95,361,000.0000 KRW\t1,807,853 KRW\t723.14 KRW\t-1,808,576 KRW",
  "2026-06-09 09:04:47\t비트코인\t매수\t0.05272989 BTC\t94,601,000.0000 KRW\t4,988,300 KRW\t1,995.32 KRW\t-4,990,296 KRW",
  "2026-06-09 09:04:33\t에스프레소\t매도\t59.17326326 ESP\t97.6300 KRW\t5,777 KRW\t2.31 KRW\t+5,775 KRW",
  "2026-06-09 09:03:57\t원화\t입금\t5,000,000 KRW\t-\t5,000,000 KRW\t- KRW\t+5,000,000 KRW",
  "2026-06-05 08:40:10\t에스프레소\t포인트샵 입금\t8.16326530 ESP\t-\t8.16326530 ESP\t- ESP\t+8.16326530 ESP",
].join("\n");

const sum = (entries: { assetKey: string; amount: string }[], key: string) =>
  entries.filter((e) => e.assetKey === key).reduce((s, e) => s.plus(e.amount), new Decimal(0)).toString();

describe("빗썸 기간별 거래 내역", () => {
  it("제목 두 줄을 건너뛰고 열 이름 줄을 찾아 빗썸 변환기를 고른다", () => {
    const found = detect(SAMPLE);
    expect(found.adapter?.id).toBe("bithumb-period-history-v1");
    expect(found.adapter && found.table.rows.length).toBe(8);
  });

  it("엑셀 시트(칸 배열)에서도 같은 변환기를 고른다", () => {
    const rows = SAMPLE.split("\n").map((l) => l.split("\t"));
    expect(detectRows(rows).adapter?.id).toBe("bithumb-period-history-v1");
  });

  it("단위로 코인 기호를 얻는다", () => {
    expect(unitOf("0.02281208 BTC")).toBe("BTC");
    expect(unitOf("5,034,802 KRW")).toBe("KRW");
    expect(unitOf("-")).toBeNull();
  });

  it("원화 변동 합계가 정산금액 합계와 같다 (잔고 대사가 맞는다)", () => {
    const found = detect(SAMPLE);
    if (!found.adapter) throw new Error("not detected");
    const { entries, unknownTypes } = bithumbHistory.convert(found.table, "s");
    expect(unknownTypes).toEqual([]);
    // -5,034,802 + 2,174,034 + 616,750 - 1,808,576 - 4,990,296 + 5,775 + 5,000,000
    expect(sum(entries, "fiat:KRW")).toBe("-4037115");
    expect(sum(entries, "BTC")).toBe(new Decimal("-0.02281208").minus("0.00647141").plus("0.01895799").plus("0.05272989").toString());
    expect(sum(entries, "ESP")).toBe(new Decimal("8.1632653").minus("59.17326326").toString());
  });

  it("매도: 코인 −, 원화 +거래금액, 수수료는 거래금액 − 정산금액", () => {
    const found = detect(SAMPLE);
    if (!found.adapter) throw new Error("not detected");
    const { entries } = bithumbHistory.convert(found.table, "s");
    const t = Date.UTC(2026, 5, 12, 3, 18, 21);
    const legs = entries.filter((e) => e.time === t);
    // 같은 초의 두 체결이 한 거래로 묶인다
    expect(new Set(legs.map((e) => e.groupId)).size).toBe(1);
    expect(legs.filter((e) => e.kind === "fee").map((e) => e.amount)).toEqual(["-870", "-247"]);
  });

  it("원화 출금은 보낸 금액과 수수료로 나눈다", () => {
    const found = detect(SAMPLE);
    if (!found.adapter) throw new Error("not detected");
    const { entries } = bithumbHistory.convert(found.table, "s");
    const out = entries.filter((e) => e.rawType === "출금");
    expect(out.map((e) => [e.kind, e.amount])).toEqual([
      ["transfer", "-5033802"],
      ["fee", "-1000"],
    ]);
  });

  it("포인트샵 입금은 보상(취득가 0)으로 처리한다", () => {
    const found = detect(SAMPLE);
    if (!found.adapter) throw new Error("not detected");
    const { entries } = bithumbHistory.convert(found.table, "s");
    const p = entries.find((e) => e.rawType === "포인트샵 입금")!;
    expect([p.kind, p.tag, p.asset, p.amount]).toEqual(["income", "reward", "ESP", "8.1632653"]);
  });
});
