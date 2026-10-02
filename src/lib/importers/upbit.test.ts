import { describe, expect, it } from "vitest";
import { parseKst, parseUpbitPaste, upbitHistory } from "./upbit";

const brief = (text: string) => {
  const parsed = parseUpbitPaste(text)!;
  return upbitHistory.convert(parsed.table, "s").entries.map((e) => [e.kind, e.assetKey, e.amount, e.groupId]);
};

describe("업비트 거래내역 붙여넣기", () => {
  it("탭으로 나뉜 표 (머리글 포함): 매수 두 체결은 같은 주문으로 묶고 원화 수수료를 분리", () => {
    const text = [
      "체결시간\t코인\t마켓\t종류\t거래수량\t거래단가\t거래금액\t수수료\t정산금액\t주문시간",
      "2027.01.02 09:00:05\tBTC\tKRW\t매수\t0.006 BTC\t100,000,000 KRW\t600,000 KRW\t300 KRW\t600,300 KRW\t2027.01.02 09:00:00",
      "2027.01.02 09:00:06\tBTC\tKRW\t매수\t0.004 BTC\t100,000,000 KRW\t400,000 KRW\t200 KRW\t400,200 KRW\t2027.01.02 09:00:00",
    ].join("\n");
    expect(brief(text)).toEqual([
      ["trade", "BTC", "0.006", "upbit:paste:2027.01.02 09:00:00:KRW-BTC:매수"],
      ["trade", "fiat:KRW", "-600000", "upbit:paste:2027.01.02 09:00:00:KRW-BTC:매수"],
      ["fee", "fiat:KRW", "-300", "upbit:paste:2027.01.02 09:00:00:KRW-BTC:매수"],
      ["trade", "BTC", "0.004", "upbit:paste:2027.01.02 09:00:00:KRW-BTC:매수"],
      ["trade", "fiat:KRW", "-400000", "upbit:paste:2027.01.02 09:00:00:KRW-BTC:매수"],
      ["fee", "fiat:KRW", "-200", "upbit:paste:2027.01.02 09:00:00:KRW-BTC:매수"],
    ]);
    expect(parseKst("2027.01.02 09:00:05")).toBe(Date.UTC(2027, 0, 2, 0, 0, 5));
  });

  it("칸마다 줄이 나뉘고 날짜·시간도 따로 나뉜 경우, 매도와 출금", () => {
    const text = [
      "2027.03.01", "14:23:45", "비트코인(BTC)", "KRW", "매도", "0.005BTC", "120,000,000KRW", "600,000KRW", "300KRW", "599,700KRW", "2027.03.01", "14:23:40",
      "2027.03.02", "10:00:00", "USDT", "-", "출금", "100 USDT", "-", "-", "1 USDT", "-", "-",
    ].join("\n");
    const rows = brief(text);
    expect(rows.map((r) => r.slice(0, 3))).toEqual([
      ["trade", "BTC", "-0.005"],
      ["trade", "fiat:KRW", "600000"],
      ["fee", "fiat:KRW", "-300"],
      ["transfer", "USDT", "-100"],
      ["fee", "USDT", "-1"],
    ]);
  });

  it("다시 붙여넣어도 같은 행은 같은 ID (중복 방지), 기록이 없으면 null", () => {
    const text = "2027.01.02 09:00:05\tXRP\tKRW\t입금\t100 XRP\t-\t-\t-\t-\t-";
    const a = upbitHistory.convert(parseUpbitPaste(text)!.table, "s").entries.map((e) => e.id);
    const b = upbitHistory.convert(parseUpbitPaste(text)!.table, "s").entries.map((e) => e.id);
    expect(a).toEqual(b);
    expect(parseUpbitPaste("아무 내용 없음")).toBeNull();
  });
});
