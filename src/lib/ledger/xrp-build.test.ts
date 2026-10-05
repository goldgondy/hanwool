import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import { isXrpAddress } from "@/lib/xrp/address";
import { buildXrpEntries, currencyName, XRP_NATIVE_KEY, xrpTokenKey } from "./xrp-build";
import type { XrplTx } from "@/lib/xrp/rpc";

const ME = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const OTHER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"; // RLUSD 발행자
const RLUSD = "524C555344000000000000000000000000000000";

const acct = (account: string, before: string, after: string) => ({
  kind: "ModifiedNode" as const,
  node: { LedgerEntryType: "AccountRoot", FinalFields: { Account: account, Balance: after }, PreviousFields: { Balance: before } },
});
// 신뢰선: Balance는 LowLimit 계정 기준
const line = (low: string, high: string, before: string, after: string) => ({
  kind: "ModifiedNode" as const,
  node: {
    LedgerEntryType: "RippleState",
    FinalFields: { LowLimit: { issuer: low }, HighLimit: { issuer: high }, Balance: { currency: RLUSD, value: after } },
    PreviousFields: { Balance: { currency: RLUSD, value: before } },
  },
});
const tx = (p: Partial<XrplTx>): XrplTx => ({ hash: "AB".repeat(32), ledgerIndex: 1, date: 800_000_000, type: "Payment", account: ME, fee: "12", result: "tesSUCCESS", nodes: [], ...p });

const sum = (es: { assetKey: string; amount: string }[], k: string) => es.filter((e) => e.assetKey === k).reduce((s, e) => s.plus(e.amount), new Decimal(0)).toString();

describe("XRP 원장", () => {
  it("주소 검사 (체크섬)", () => {
    expect(isXrpAddress(ME)).toBe(true);
    expect(isXrpAddress(ME.slice(0, -1) + "x")).toBe(false);
    expect(isXrpAddress("XV5sbjUmgPpvXv4ixFWZ5ptAYZ6PD28Sq49uo34VyjnmK5H")).toBe(false);
  });

  it("긴 통화 코드 해석", () => {
    expect(currencyName(RLUSD)).toBe("RLUSD");
    expect(currencyName("USD")).toBe("USD");
  });

  it("보낸 송금: 수수료를 떼어 보낸 금액과 수수료로 나눈다", () => {
    // 잔고 100 → 89.999988 XRP (10 XRP 송금 + 수수료 0.000012)
    const es = buildXrpEntries({ sourceId: "s", address: ME, txs: [tx({ destination: OTHER, nodes: [acct(ME, "100000000", "89999988"), acct(OTHER, "0", "10000000")] })] });
    expect(es.map((e) => [e.kind, e.amount])).toEqual([
      ["fee", "-0.000012"],
      ["transfer", "-10"],
    ]);
    expect(es[1].counterparty).toBe(OTHER);
    expect(es[1].txHash).toBe("AB".repeat(32));
    expect(new Date(es[0].time).toISOString()).toBe("2025-05-08T06:13:20.000Z");
  });

  it("받은 송금: 실제로 잔고에 들어온 만큼만 (부분 지급 사기에도 안전)", () => {
    const es = buildXrpEntries({ sourceId: "s", address: ME, txs: [tx({ account: OTHER, destination: ME, nodes: [acct(ME, "5000000", "5000001")] })] });
    expect(es.map((e) => [e.kind, e.amount, e.counterparty])).toEqual([["transfer", "0.000001", OTHER]]);
  });

  it("DEX 교환: XRP → RLUSD (내가 신뢰선의 High 쪽이면 부호를 바꾼다)", () => {
    const es = buildXrpEntries({
      sourceId: "s",
      address: ME,
      txs: [tx({ type: "OfferCreate", nodes: [acct(ME, "50000000", "39999988"), line(ISSUER, ME, "-1", "-25.5")] })],
    });
    expect(sum(es, XRP_NATIVE_KEY)).toBe("-10.000012");
    expect(sum(es, xrpTokenKey(RLUSD, ISSUER))).toBe("24.5");
    expect(es.find((e) => e.asset === "RLUSD")?.kind).toBe("trade");
  });

  it("실패한 거래: 수수료만", () => {
    const es = buildXrpEntries({ sourceId: "s", address: ME, txs: [tx({ result: "tecPATH_DRY", nodes: [acct(ME, "1000000", "999988")] })] });
    expect(es.map((e) => [e.kind, e.amount])).toEqual([["fee", "-0.000012"]]);
  });
});
