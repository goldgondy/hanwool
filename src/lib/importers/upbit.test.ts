import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
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

// 2026-10-05 세무사 제공 업비트 거래내역 화면 캡처 (날짜·시간이 한 칸에 두 줄, 단위가 숫자 뒤에)
const REAL = [
  "체결시간\t코인\t마켓\t종류\t거래수량\t거래단가\t거래금액\t수수료\t정산금액\t주문시간",
  "2025.10.24\n15:14\tUSDT\t-\t출금\t6.67446600 USDT\t1,496.0 KRW\t9,985 KRW\t0 USDT\t6.67446600 USDT\t-",
  "2025.10.24\n15:12\tUSDT\tKRW\t매수\t6.67446624 USDT\t1,496.0 KRW\t9,985 KRW\t0.99 KRW\t9,986 KRW\t2025.10.24\n15:12",
  "2025.10.24\n15:11\tDOGE\tKRW\t매도\t33.86781185 DOGE\t295.0 KRW\t9,991 KRW\t4.99 KRW\t9,986 KRW\t2025.10.24\n15:11",
  "2025.10.24\n11:09\tDOGE\tKRW\t매수\t33.86781185 DOGE\t295.0 KRW\t9,991 KRW\t4.99 KRW\t9,996 KRW\t2025.10.24\n11:09",
  "2025.10.24\n10:38\tBTC\tKRW\t매도\t0.00006012 BTC\t166,336,000 KRW\t10,000 KRW\t5.00 KRW\t9,995 KRW\t2025.10.24\n10:38",
  "2025.10.23\n13:23\tBTC\tKRW\t매수\t0.00006012 BTC\t163,980,000 KRW\t9,859 KRW\t4.92 KRW\t9,864 KRW\t2025.10.23\n13:23",
  "2025.10.22\n17:21\tBTC\t-\t입금\t0.00006057 BTC\t163,101,000 KRW\t9,879 KRW\t0 BTC\t0.00006057 BTC\t-",
  "2025.10.17\n08:37\tKRW\t-\t출금\t190,470 KRW\t1.000 KRW\t190,470 KRW\t1,000.00 KRW\t191,470 KRW\t-",
].join("\n");

describe("업비트 실제 화면 (2026-10-05 캡처)", () => {
  const parsed = parseUpbitPaste(REAL);
  const r = parsed ? upbitHistory.convert(parsed.table, "s") : null;
  const sum = (k: string) => (r?.entries ?? []).filter((e) => e.assetKey === k).reduce((s, e) => s.plus(e.amount), new Decimal(0)).toString();

  it("8건을 모두 읽는다 (주문시간 칸은 앞 기록에 붙인다)", () => {
    expect(parsed?.table.rows.length).toBe(8);
    expect(parsed?.skipped).toBe(0);
    expect(r?.rowCount).toBe(8);
  });

  it("원화는 정산금액만큼 정확히 움직인다 (수수료 0.99원 → 실제 1원)", () => {
    // −9,986(USDT 매수) +9,986(DOGE 매도) −9,996(DOGE 매수) +9,995(BTC 매도) −9,864(BTC 매수) −191,470(출금)
    expect(sum("fiat:KRW")).toBe(String(-9986 + 9986 - 9996 + 9995 - 9864 - 191470));
    const usdtFee = r?.entries.find((e) => e.kind === "fee" && e.rawType === "매수" && e.groupId.includes("USDT"));
    expect(usdtFee?.amount).toBe("-1");
  });

  it("코인 수량: USDT는 매수 후 출금하고 먼지만 남는다, BTC는 입금 후 사고팔기", () => {
    expect(sum("USDT")).toBe("0.00000024");
    expect(sum("DOGE")).toBe("0");
    expect(sum("BTC")).toBe("0.00006057");
  });

  it("분까지만 있는 시각을 한국 시각으로 읽는다", () => {
    expect(new Date(r!.entries[0].time).toISOString()).toBe("2025-10-24T06:14:00.000Z");
  });
});
