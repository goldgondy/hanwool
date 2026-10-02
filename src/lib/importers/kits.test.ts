import { describe, expect, it } from "vitest";
import type { CsvSource, OkxSource } from "@/lib/db";
import { detect } from "./index";
import { kitStatus, missingFiles, partsOf } from "./kits";

const okxFile = (imports: CsvSource["imports"], linkedSourceId?: string): CsvSource => ({ id: "f", kind: "csv", label: "OKX (파일)", exchange: "okx", imports, linkedSourceId, createdAt: 0 });
const imp = (parts: string[], format = "okx-deposit-withdrawal-v1") => ({ at: 0, fileName: "x.csv", format, rows: 1, added: 1, parts, from: 1, to: 2 });
const api: OkxSource = { id: "api", kind: "okx", label: "OKX", apiKey: "k", encSecret: { iv: "", ct: "" }, encPassphrase: { iv: "", ct: "" }, createdAt: 0 };

describe("거래소 파일 준비 목록", () => {
  it("파일 종류를 알아본다: OKX 출금 파일 → okx:withdrawal, 빗썸 → bithumb:all", () => {
    const wd = detect("Time,Crypto,Withdrawal address,Network,Transaction ID,Amount,Fee,Status,Reference no.\n05/11/2026 21:37:10,BTC,bc1q,Bitcoin,ab,0.1,0.0001,Sent,1");
    expect(wd.adapter && partsOf(wd.adapter, wd.table)).toEqual(["okx:withdrawal"]);
    const bt = detect("거래일시\t자산\t거래구분\t거래수량\t체결가격\t거래금액\t수수료\t정산금액\n2026-06-12 12:18:55\t원화\t입금\t1 KRW\t-\t1 KRW\t- KRW\t+1 KRW");
    expect(bt.adapter && partsOf(bt.adapter, bt.table)).toEqual(["bithumb:all"]);
  });

  it("OKX: 거래·출금만 올리면 입금 내역이 빠졌다고 알려 준다", () => {
    const s = okxFile([imp(["okx:trading"], "okx-account-history-v1"), imp(["okx:withdrawal"])]);
    expect(kitStatus(s)?.map((p) => [p.key, p.state])).toEqual([
      ["okx:trading", "done"],
      ["okx:deposit", "missing"],
      ["okx:withdrawal", "done"],
    ]);
    expect(missingFiles([s])).toEqual(["OKX (파일): 입금 내역"]);
  });

  it("같은 계정 OKX API가 연결되어 있으면 입출금은 API로 보완된 것으로 본다", () => {
    const s = okxFile([imp(["okx:trading"], "okx-account-history-v1")], "api");
    expect(kitStatus(s, [api, s])?.map((p) => p.state)).toEqual(["done", "api", "api"]);
    expect(missingFiles([api, s])).toEqual([]);
  });

  it("예전에 parts 없이 가져온 기록도 형식으로 알아본다", () => {
    const old = { at: 0, fileName: "a.csv", format: "okx-account-history-v1", rows: 1, added: 1 };
    expect(kitStatus(okxFile([old]))?.[0].state).toBe("done");
  });
});
