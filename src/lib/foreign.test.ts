import { describe, expect, it } from "vitest";
import type { LedgerEntry, ReconciliationRecord, Source } from "@/lib/db";
import { foreignAccounts, monthEndQuantities, monthEnds } from "./foreign";

const enc = { iv: "", ct: "" };
const sources: Source[] = [
  { id: "bn", kind: "binance", label: "바이낸스", apiKey: "k", encSecret: enc, createdAt: 0 },
  { id: "up", kind: "xapi", exchange: "upbit", label: "업비트", apiKey: "k", encSecret: enc, createdAt: 0 },
  { id: "w", kind: "tron", label: "트론 지갑", address: "T", createdAt: 0 },
];
const at = Date.UTC(2027, 3, 15); // 4월 15일 대사
const record: ReconciliationRecord = { key: "bn", label: "바이낸스", memberIds: ["bn"], at, status: "ok", rows: [{ assetKey: "BTC", asset: "BTC", location: "", ledger: "2", actual: "2", diff: "0" }] };
const e = (time: number, amount: string): LedgerEntry => ({ id: `${time}`, sourceId: "bn", location: "", time, asset: "BTC", assetKey: "BTC", amount, kind: "transfer", groupId: `${time}` });

describe("해외금융계좌", () => {
  it("해외 거래소만 대상 (국내 거래소·지갑 제외)", () => {
    expect(foreignAccounts(sources, [record]).map((a) => [a.key, !!a.anchor])).toEqual([["bn", true]]);
  });

  it("월말 말일 23:59:59 한국 시각", () => {
    expect(new Date(monthEnds(2027)[0]).toISOString()).toBe("2027-01-31T14:59:59.000Z");
    expect(new Date(monthEnds(2027)[11]).toISOString()).toBe("2027-12-31T14:59:59.000Z");
  });

  it("대사 잔고에서 그 뒤 기록을 거꾸로 빼서 월말 잔고를 구한다", () => {
    const [account] = foreignAccounts(sources, [record]);
    // 2월 10일 +1.5 입금, 3월 20일 −0.5 출금 → 1월 말 1.0, 2월 말 2.5, 3월 말 2.0
    const entries = [e(Date.UTC(2027, 1, 10), "1.5"), e(Date.UTC(2027, 2, 20), "-0.5")];
    const q = monthEndQuantities(account, entries, monthEnds(2027));
    expect(q.slice(0, 3).map((m) => m?.get("BTC")?.qty.toString())).toEqual(["1", "2.5", "2"]);
    expect(q[3]).toBeNull(); // 4월 말은 대사(4/15) 이후
  });
});
