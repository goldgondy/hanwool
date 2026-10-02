import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import { detect } from "./index";
import { okxHistory, okxOffsetMinutes } from "./okx";

// 2026-10-02 세무사 제공 OKX 거래 계정 내역 캡처의 2026-05-11 부분 (엑셀 표시가 잘린 소수는 맞아떨어지게 채움)
const HEAD = "id,Order id,Time,Trade Type,Symbol,Action,Amount,Trading Unit,Filled Price,PnL,Fee,Fee Unit,Position Change,Position Balance,Balance Change,Balance,Balance Unit";
const sample = (orderId = "3561000000000000001", account = "Trading") =>
  [
    `UID:67000000,Account Type:${account},Time Zone:UTC+8`,
    HEAD,
    "6,3562000000000000001,2026-05-11 21:37:10,Transfer,,Transfer out,0,cont,0,0,0,BTC,0,0,-0.0502876,0,BTC",
    `5,${orderId},2026-05-11 21:35:20,Spot,BTC-USDT,Buy,0.001647,BTC,80904.4,0,-0.0000017,BTC,0,0,0.0016453,0.0018980,BTC`,
    `4,${orderId},2026-05-11 21:35:20,Spot,BTC-USDT,Buy,0.048691,BTC,80904.4,0,-0.0000487,BTC,0,0,0.0486423,0.0505403,BTC`,
    `3,${orderId},2026-05-11 21:35:20,Spot,BTC-USDT,Sell,133.2682,BTC,80904.4,0,0,USDT,0,0,-133.2682,3940.033,USDT`,
    `2,${orderId},2026-05-11 21:35:20,Spot,BTC-USDT,Sell,3939.288,BTC,80904.4,0,0,USDT,0,0,-3939.288,0.745,USDT`,
    "1,3560000000000000001,2026-05-11 21:34:05,Transfer,,Transfer in,0,cont,0,0,0,USDT,0,0,4073.3,4073.301,USDT",
  ].join("\n");

const sum = (entries: { assetKey: string; amount: string }[], key: string) =>
  entries.filter((e) => e.assetKey === key).reduce((s, e) => s.plus(e.amount), new Decimal(0)).toString();

describe("OKX 계정 내역 파일", () => {
  it("첫 줄의 안내를 건너뛰고 OKX 변환기를 고른다", () => {
    const found = detect(sample());
    expect(found.adapter?.id).toBe("okx-account-history-v1");
    expect(found.adapter && found.table.preamble?.[0]).toContain("UTC+8");
  });

  it("시간대 읽기", () => {
    expect(okxOffsetMinutes(["Time Zone:UTC+8"])).toBe(480);
    expect(okxOffsetMinutes(["Time Zone:UTC-05:30"])).toBe(-330);
    expect(okxOffsetMinutes(["UID:1"])).toBeNull();
  });

  it("잔고 변동에서 수수료를 나누고, 한 주문의 체결을 한 거래로 묶고, 계정 간 이동은 뺀다", () => {
    const found = detect(sample());
    if (!found.adapter) throw new Error("not detected");
    const r = okxHistory.convert(found.table, "s");
    // 이동 2줄 제외 → 체결 4줄 = 거래 4 + 수수료 2
    expect(r.entries).toHaveLength(6);
    expect(new Set(r.entries.map((e) => e.groupId))).toEqual(new Set(["okx:ord:3561000000000000001"]));
    expect(r.entries.filter((e) => e.kind === "trade" && e.asset === "BTC").map((e) => e.amount)).toEqual(["0.001647", "0.048691"]);
    expect(r.entries.filter((e) => e.kind === "fee").map((e) => e.amount)).toEqual(["-0.0000017", "-0.0000487"]);
    // 합계는 파일의 잔고 변동과 같다
    expect(sum(r.entries, "BTC")).toBe("0.0502876");
    expect(sum(r.entries, "USDT")).toBe("-4072.5562");
    // 21:35:20 (UTC+8) = 13:35:20 UTC
    expect(new Date(r.entries[0].time).toISOString()).toBe("2026-05-11T13:35:20.000Z");
    expect(r.entries[0].location).toBe("OKX 거래 계정");
    expect(r.warnings.join(" ")).toContain("이동 2건");
  });

  it("엑셀이 주문번호를 3.56E+18로 줄인 파일은 시각으로 묶고 경고한다", () => {
    const found = detect(sample("3.56E+18"));
    if (!found.adapter) throw new Error("not detected");
    const r = okxHistory.convert(found.table, "s");
    expect(new Set(r.entries.map((e) => e.groupId)).size).toBe(1);
    expect(r.warnings.join(" ")).toContain("원본 CSV");
  });

  it("자금 계정 파일의 입금·출금 (형식 추정)", () => {
    const text = [
      "UID:67000000,Account Type:Funding,Time Zone:UTC+8",
      HEAD,
      "2,,2026-05-12 10:00:00,Withdrawal,,Withdrawal,0.0506,BTC,0,0,-0.0002,BTC,0,0,-0.0506,0,BTC",
      "1,,2026-05-11 21:00:00,Deposit,,Deposit,4073.3,USDT,0,0,0,USDT,0,0,4073.3,4073.3,USDT",
    ].join("\n");
    const found = detect(text);
    if (!found.adapter) throw new Error("not detected");
    const r = okxHistory.convert(found.table, "s");
    expect(r.entries.map((e) => [e.kind, e.asset, e.amount])).toEqual([
      ["transfer", "BTC", "-0.0504"],
      ["fee", "BTC", "-0.0002"],
      ["transfer", "USDT", "4073.3"],
    ]);
    expect(r.entries[0].location).toBe("OKX 펀딩 계정");
  });
});
