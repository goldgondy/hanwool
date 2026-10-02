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

  it("엑셀이 주문번호를 3.56E+18로 줄인 파일은 시각으로 묶는다", () => {
    const found = detect(sample("3.56E+18"));
    if (!found.adapter) throw new Error("not detected");
    const r = okxHistory.convert(found.table, "s");
    expect(new Set(r.entries.map((e) => e.groupId)).size).toBe(1);
  });

  it("원본과 엑셀에서 다시 저장한 파일(주문번호·초 잘림)을 같은 기록으로 알아본다 → 두 번 올려도 중복되지 않음", () => {
    const resaved = sample("3.56E+18")
      .replace(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}):\d{2}/g, "$1") // 초 잘림
      .replace(/^\d+,/gm, "9,"); // 행 번호도 다르게
    const a = detect(sample());
    const b = detect(resaved);
    if (!a.adapter || !b.adapter) throw new Error("not detected");
    const ids = (t: typeof a) => (t.adapter ? t.adapter.convert(t.table, "s").entries.map((e) => e.id).sort() : []);
    expect(ids(b)).toEqual(ids(a));
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

// 2026-10-02 세무사 제공 OKX 출금 내역 캡처의 일부 (거래 번호·주소는 잘린 부분을 임의로 채움)
const WD = [
  "UID: 67000000,Account type: Funding,Time: 07/10/2026 09:46",
  "",
  "Time,Crypto,Withdrawal address,Network,Transaction ID,Amount,Fee,Status,Reference no.",
  "05/11/2026 21:37:10,BTC,bc1qwdqgaaaa,Bitcoin,e1f538d9c4aaaa,0.050525,0.000015,Sent,400000001",
  "10/12/2025 15:00:00,BTC,bc1qchtrls4aaa,Bitcoin,5c8d2a3c3aaaa,0.01082,0.00001,Sent,347000001",
  "10/12/2025 15:00:00,BTC,bc1qu0p8yaaa,Bitcoin,5c8d2a3c3aaaa,0.01082,0.00001,Sent,347000002",
  "09/13/2025 10:00:00,BTC,bc1q7gegraaa,Bitcoin,,0.010057,0.00001,Canceled,339000001",
  "09/08/2025 08:00:00,USDT,UQCxdwXcaaa,The Open Network,cd5668ec6aaa,83.71655,0.15,Sent,337000001",
].join("\n");

describe("OKX 입금·출금 내역 파일", () => {
  it("출금: 보낸 금액·수수료를 나누고, 거래 번호를 남기고, 취소된 출금은 뺀다", () => {
    const found = detect(WD);
    expect(found.adapter?.id).toBe("okx-deposit-withdrawal-v1");
    if (!found.adapter) throw new Error("not detected");
    const r = found.adapter.convert(found.table, "s");
    const first = r.entries.filter((e) => e.txHash === "e1f538d9c4aaaa");
    expect(first.map((e) => [e.kind, e.amount])).toEqual([
      ["transfer", "-0.050525"],
      ["fee", "-0.000015"],
    ]);
    // 보낸 금액 + 수수료 = 거래 계정 파일의 Transfer out 0.05054
    expect(first.reduce((s, e) => s.plus(e.amount), new Decimal(0)).toString()).toBe("-0.05054");
    expect(new Date(first[0].time).toISOString()).toBe("2026-05-11T13:37:10.000Z");
    expect(first[0].counterparty).toBe("bc1qwdqgaaaa");
    // 한 거래에 두 주소로 보낸 출금은 따로 남는다, 취소 1건은 제외
    expect(r.entries.filter((e) => e.kind === "transfer")).toHaveLength(4);
    expect(r.warnings.join(" ")).toContain("Canceled 1건");
  });

  it("엑셀에서 다시 저장해 Reference no.가 4E+08로 바뀌어도 같은 기록이다", () => {
    const a = detect(WD);
    const b = detect(WD.replace(/,(\d{9})$/gm, ",4E+08"));
    if (!a.adapter || !b.adapter) throw new Error("not detected");
    const ids = (t: typeof a) => (t.adapter ? t.adapter.convert(t.table, "s").entries.map((e) => e.id).sort() : []);
    expect(ids(b)).toEqual(ids(a));
  });
});
