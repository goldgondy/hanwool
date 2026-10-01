import { describe, expect, it } from "vitest";
import { classifyAll } from "@/lib/classify/classifier";
import { detect } from "./index";

// 공개된 형식 기준의 가상 샘플 (실제 샘플 확보 후 교체)
const SAMPLE = `﻿User_ID,UTC_Time,Account,Operation,Coin,Change,Remark
12345,2025-03-01 09:00:00,Spot,Deposit,USDT,1000,
12345,2025-03-02 10:00:00,Spot,Transaction Buy,BTC,0.01,
12345,2025-03-02 10:00:00,Spot,Transaction Spend,USDT,-900,
12345,2025-03-02 10:00:00,Spot,Transaction Fee,BNB,-0.002,
12345,2025-03-03 00:00:00,Spot,Simple Earn Flexible Subscription,USDT,-100,
12345,2025-03-03 00:00:00,Earn,Simple Earn Flexible Subscription,USDT,100,
12345,2025-03-04 00:00:00,Earn,Simple Earn Flexible Interest,USDT,0.05,
12345,2025-03-05 00:00:00,Spot,Airdrop Assets,XYZ,10,
12345,2025-03-06 00:00:00,Spot,Brand New Operation,ABC,1,
12345,2025-03-07 00:00:00,Spot,Withdraw,BTC,-0.005,
12345,2025-03-08 00:00:00,Spot,Fiat Deposit,KRW,1000000,
12345,2025-03-09 00:00:00,USDT-Futures,Realized Profit and Loss,USDT,25.5,
12345,2025-03-09 00:00:00,USDT-Futures,Fee,USDT,-0.8,
`;

describe("바이낸스 전체 거래 명세서", () => {
  const found = detect(SAMPLE);

  it("열 이름으로 형식을 자동 인식한다 (BOM이 있어도)", () => {
    expect(found.adapter?.id).toBe("binance-statement-v1");
  });

  const result = found.adapter!.convert("table" in found ? found.table : { headers: [], rows: [] }, "src1");

  it("행마다 원장 항목을 만들고, 모르는 유형을 알려 준다", () => {
    expect(result.entries).toHaveLength(13);
    expect(result.unknownTypes).toEqual(["Brand New Operation"]);
    expect(result.range).toEqual({ from: Date.parse("2025-03-01T09:00:00Z"), to: Date.parse("2025-03-09T00:00:00Z") });
    expect(result.entries.every((e) => e.origin === "exchange")).toBe(true);
  });

  it("같은 파일을 다시 가져와도 ID가 같다 (중복 방지)", () => {
    const again = found.adapter!.convert("table" in found ? found.table : { headers: [], rows: [] }, "src1");
    expect(again.entries.map((e) => e.id)).toEqual(result.entries.map((e) => e.id));
    expect(new Set(result.entries.map((e) => e.id)).size).toBe(result.entries.length);
  });

  it("분류: 체결은 교환(확정), Earn 예치는 내 계정 간 이체, 이자는 보상, 에어드랍, 원화 입금", () => {
    const groups = classifyAll({ entries: result.entries, ownAddresses: new Set(), decisions: new Map() });
    const byType = (op: string) => groups.find((g) => g.entries.some((e) => e.rawType === op))!.classification;

    expect(byType("Transaction Buy")).toMatchObject({ category: "trade", status: "confirmed", rule: "R1" });
    expect(groups.find((g) => g.entries.some((e) => e.rawType === "Transaction Buy"))!.entries).toHaveLength(3);
    expect(byType("Simple Earn Flexible Subscription")).toMatchObject({ category: "internal_transfer", status: "confirmed" });
    expect(byType("Simple Earn Flexible Interest")).toMatchObject({ category: "reward", status: "confirmed", rule: "R3" });
    expect(byType("Airdrop Assets")).toMatchObject({ category: "airdrop", status: "confirmed" });
    expect(byType("Brand New Operation")).toMatchObject({ status: "needs_review" });
    expect(byType("Withdraw")).toMatchObject({ category: "external_out", status: "needs_review" });
    expect(byType("Fiat Deposit")).toMatchObject({ category: "fiat_transfer", status: "confirmed" });
    expect(byType("Deposit")).toMatchObject({ category: "external_in", status: "needs_review" });
  });

  it("선물 손익과 선물 수수료는 같은 기준(미분류)으로 두고 세금 계산에 넣지 않는다", () => {
    const futures = result.entries.filter((e) => e.location.includes("Futures"));
    expect(futures.map((e) => [e.rawType, e.kind])).toEqual([
      ["Realized Profit and Loss", "other"],
      ["Fee", "other"],
    ]);
    const groups = classifyAll({ entries: futures, ownAddresses: new Set(), decisions: new Map() });
    expect(groups.every((g) => g.classification.status === "needs_review")).toBe(true);
    expect(groups.some((g) => g.classification.category === "fee_only")).toBe(false);
    expect(result.warnings.join()).toMatch(/선물/);
  });
});

describe("형식 인식", () => {
  it("모르는 CSV는 변환기 없이 열 이름을 돌려준다", () => {
    const r = detect("날짜,코인,수량\n2025-01-01,BTC,1\n");
    expect(r.adapter).toBeNull();
    expect("headers" in r && r.headers).toEqual(["날짜", "코인", "수량"]);
  });
});
