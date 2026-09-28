import Decimal from "@/lib/decimal";
import { describe, expect, it } from "vitest";
import { buildEvmEntries, type AlchemyTransfer, type TxReceipt } from "./evm-build";
import { reconcile } from "./reconcile";

const ME = "0x1111111111111111111111111111111111111111";
const DEX = "0x2222222222222222222222222222222222222222";
const FRIEND = "0x3333333333333333333333333333333333333333";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function transfer(p: Partial<AlchemyTransfer> & { hash: string; uniqueId: string }): AlchemyTransfer {
  return {
    blockNum: "0x10",
    from: ME,
    to: FRIEND,
    value: null,
    asset: "ETH",
    category: "external",
    rawContract: { value: "0xde0b6b3a7640000", address: null, decimal: "0x12" }, // 1 ETH
    metadata: { blockTimestamp: "2027-03-01T00:00:00.000Z" },
    ...p,
  };
}

function receipt(hash: string, from = ME, extra: Partial<TxReceipt> = {}): TxReceipt {
  // 21000 gas × 10 gwei = 0.00021 ETH
  return { transactionHash: hash, from, gasUsed: "0x5208", effectiveGasPrice: "0x2540be400", ...extra };
}

const base = { sourceId: "s1", chain: "eth" as const, address: ME, tokenMeta: {} };

describe("buildEvmEntries", () => {
  it("ETH 송금은 출금 항목과 가스비 항목을 만든다", () => {
    const { entries } = buildEvmEntries({
      ...base,
      incoming: [],
      outgoing: [transfer({ hash: "0xa", uniqueId: "0xa:external" })],
      receipts: [receipt("0xa")],
    });
    expect(entries.map((e) => [e.kind, e.assetKey, e.amount])).toEqual([
      ["transfer", "eth:native", "-1"],
      ["fee", "eth:native", "-0.00021"],
    ]);
    expect(entries[0].counterparty).toBe(FRIEND);
    expect(entries[1].time).toBe(entries[0].time);
  });

  it("남이 보낸 트랜잭션에는 가스비를 기록하지 않는다", () => {
    const { entries } = buildEvmEntries({
      ...base,
      incoming: [transfer({ hash: "0xb", uniqueId: "0xb:external", from: FRIEND, to: ME })],
      outgoing: [],
      receipts: [receipt("0xb", FRIEND)],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe("1");
    expect(entries[0].counterparty).toBe(FRIEND);
  });

  it("ERC-20 소수점 자릿수를 반영하고, 서로 다른 자산이 오가면 스왑으로 분류한다", () => {
    const { entries } = buildEvmEntries({
      ...base,
      outgoing: [
        transfer({
          hash: "0xc",
          uniqueId: "0xc:log:1",
          to: DEX,
          asset: "USDC",
          category: "erc20",
          rawContract: { value: "0x77359400", address: USDC, decimal: "0x6" }, // 2000 USDC
        }),
      ],
      incoming: [
        transfer({
          hash: "0xc",
          uniqueId: "0xc:internal:0",
          from: DEX,
          to: ME,
          category: "internal",
          rawContract: { value: "0x6f05b59d3b20000", address: null, decimal: "0x12" }, // 0.5 ETH
        }),
      ],
      receipts: [receipt("0xc")],
    });
    const byKind = entries.map((e) => [e.kind, e.asset, e.assetKey, e.amount]);
    expect(byKind).toContainEqual(["trade", "USDC", `eth:${USDC.toLowerCase()}`, "-2000"]);
    expect(byKind).toContainEqual(["trade", "ETH", "eth:native", "0.5"]);
    expect(byKind).toContainEqual(["fee", "ETH", "eth:native", "-0.00021"]);
    expect(new Set(entries.map((e) => e.groupId))).toEqual(new Set(["eth:0xc"]));
  });

  it("자기 자신에게 보낸 것은 스왑이 아니라 이체이며 합계는 가스비만 남는다", () => {
    const self = transfer({ hash: "0xd", uniqueId: "0xd:external", from: ME, to: ME });
    const { entries } = buildEvmEntries({
      ...base,
      incoming: [self],
      outgoing: [self],
      receipts: [receipt("0xd")],
    });
    expect(entries.filter((e) => e.kind === "trade")).toHaveLength(0);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    const sum = entries.reduce((s, e) => s.plus(e.amount), new Decimal(0));
    expect(sum.toString()).toBe("-0.00021");
  });

  it("L2의 L1 수수료를 가스비에 더한다", () => {
    const { entries } = buildEvmEntries({
      ...base,
      chain: "base",
      incoming: [],
      outgoing: [transfer({ hash: "0xe", uniqueId: "0xe:external" })],
      receipts: [receipt("0xe", ME, { l1Fee: "0x5af3107a4000" })], // 0.0001 ETH
    });
    const fee = entries.find((e) => e.kind === "fee")!;
    expect(fee.amount).toBe("-0.00031");
    expect(fee.assetKey).toBe("base:native");
  });

  it("소수점 자릿수가 없으면 토큰 메타데이터를 쓰고, 둘 다 없으면 건너뛴다", () => {
    const token = "0x4444444444444444444444444444444444444444";
    const t = (uniqueId: string) =>
      transfer({
        hash: "0xf",
        uniqueId,
        from: FRIEND,
        to: ME,
        asset: null,
        category: "erc20",
        rawContract: { value: "0x64", address: token, decimal: null },
      });
    const withMeta = buildEvmEntries({
      ...base,
      tokenMeta: { [token]: { symbol: "abc", decimals: 2 } },
      incoming: [t("0xf:log:1")],
      outgoing: [],
      receipts: [],
    });
    expect(withMeta.entries[0].amount).toBe("1");
    expect(withMeta.entries[0].asset).toBe("ABC");

    const noMeta = buildEvmEntries({ ...base, incoming: [t("0xf:log:2")], outgoing: [], receipts: [] });
    expect(noMeta.entries).toHaveLength(0);
    expect(noMeta.skipped).toHaveLength(1);
  });
});

describe("reconcile", () => {
  it("원장 합계와 실제 잔고의 차이를 계산하고 불일치를 먼저 보여 준다", () => {
    const { entries } = buildEvmEntries({
      ...base,
      incoming: [
        transfer({ hash: "0x1", uniqueId: "0x1:external", from: FRIEND, to: ME }),
        transfer({
          hash: "0x2",
          uniqueId: "0x2:log:0",
          from: FRIEND,
          to: ME,
          asset: "USDC",
          category: "erc20",
          rawContract: { value: "0x5f5e100", address: USDC, decimal: "0x6" }, // 100 USDC
        }),
      ],
      outgoing: [],
      receipts: [],
    });
    const rows = reconcile(entries, [
      { location: "Ethereum", asset: "ETH", rawAsset: "ETH", assetKey: "eth:native", amount: new Decimal("1") },
      { location: "Ethereum", asset: "USDC", rawAsset: USDC, assetKey: `eth:${USDC.toLowerCase()}`, amount: new Decimal("150") },
    ]);
    expect(rows.map((r) => [r.asset, r.diff.toString()])).toEqual([
      ["USDC", "50"],
      ["ETH", "0"],
    ]);
  });

  it("18자리 소수 토큰의 큰 수량도 반올림 없이 정확히 합산한다", () => {
    // 1,234,567.123456789012345678 토큰 (유효숫자 25자리) × 2
    const raw = "0x" + BigInt("1234567123456789012345678").toString(16);
    const token = "0x5555555555555555555555555555555555555555";
    const t = (uniqueId: string) =>
      transfer({
        hash: uniqueId.split(":")[0],
        uniqueId,
        from: FRIEND,
        to: ME,
        asset: "BIG",
        category: "erc20",
        rawContract: { value: raw, address: token, decimal: "0x12" },
      });
    const { entries } = buildEvmEntries({ ...base, incoming: [t("0x7:log:0"), t("0x8:log:0")], outgoing: [], receipts: [] });
    const rows = reconcile(entries, [
      { location: "Ethereum", asset: "BIG", rawAsset: token, assetKey: `eth:${token}`, amount: new Decimal("2469134.246913578024691356") },
    ]);
    expect(rows[0].ledger.toFixed()).toBe("2469134.246913578024691356");
    expect(rows[0].diff.isZero()).toBe(true);
  });

  it("아주 작은 수량을 지수 표기 없이 저장한다", () => {
    const { entries } = buildEvmEntries({
      ...base,
      incoming: [transfer({ hash: "0x9", uniqueId: "0x9:external", from: FRIEND, to: ME, rawContract: { value: "0x1", address: null, decimal: "0x12" } })],
      outgoing: [],
      receipts: [],
    });
    expect(entries[0].amount).toBe("0.000000000000000001");
  });

  it("원장과 잔고가 모두 0인 자산은 제외한다", () => {
    const rows = reconcile(
      [
        { id: "a", sourceId: "s1", location: "Ethereum", time: 0, asset: "X", assetKey: "eth:0xx", amount: "5", kind: "transfer", groupId: "g1" },
        { id: "b", sourceId: "s1", location: "Ethereum", time: 1, asset: "X", assetKey: "eth:0xx", amount: "-5", kind: "transfer", groupId: "g2" },
      ],
      [],
    );
    expect(rows).toHaveLength(0);
  });
});
