import Decimal from "@/lib/decimal";
import { describe, expect, it } from "vitest";
import {
  buildEvmEntries,
  type BuildInput,
  type InternalTx,
  type NativeTx,
  type TokenTransfer,
} from "./evm-build";
import { reconcile } from "./reconcile";

const ME = "0x1111111111111111111111111111111111111111";
const DEX = "0x2222222222222222222222222222222222222222";
const FRIEND = "0x3333333333333333333333333333333333333333";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TIME = Date.parse("2027-03-01T00:00:00Z");
const ONE_ETH = "1000000000000000000";
const FEE = "210000000000000"; // 0.00021 ETH

const tx = (p: Partial<NativeTx> & { hash: string }): NativeTx => ({
  from: ME,
  to: FRIEND,
  value: ONE_ETH,
  fee: FEE,
  success: true,
  time: TIME,
  ...p,
});
const internal = (p: Partial<InternalTx> & { hash: string }): InternalTx => ({
  index: 0,
  from: DEX,
  to: ME,
  value: "0",
  success: true,
  time: TIME,
  ...p,
});
const token = (p: Partial<TokenTransfer> & { hash: string }): TokenTransfer => ({
  logIndex: 0,
  from: FRIEND,
  to: ME,
  value: "0",
  decimals: 6,
  token: USDC,
  symbol: "USDC",
  time: TIME,
  ...p,
});

const build = (p: Partial<BuildInput>) =>
  buildEvmEntries({ sourceId: "s1", chain: "eth", address: ME, txs: [], internal: [], tokens: [], ...p });

const summary = (entries: ReturnType<typeof build>["entries"]) =>
  entries.map((e) => [e.kind, e.assetKey, e.amount]);

describe("buildEvmEntries", () => {
  it("ETH 송금은 출금 항목과 가스비 항목을 만든다", () => {
    const { entries } = build({ txs: [tx({ hash: "0xa" })] });
    expect(summary(entries)).toEqual([
      ["transfer", "eth:native", "-1"],
      ["fee", "eth:native", "-0.00021"],
    ]);
    expect(entries[0].counterparty).toBe(FRIEND);
  });

  it("남이 보낸 트랜잭션은 입금만 기록하고 가스비는 기록하지 않는다", () => {
    const { entries } = build({ txs: [tx({ hash: "0xb", from: FRIEND, to: ME })] });
    expect(summary(entries)).toEqual([["transfer", "eth:native", "1"]]);
    expect(entries[0].counterparty).toBe(FRIEND);
  });

  it("실패한 트랜잭션은 금액 이동 없이 가스비만 기록한다", () => {
    const { entries } = build({ txs: [tx({ hash: "0xc", success: false })] });
    expect(summary(entries)).toEqual([["fee", "eth:native", "-0.00021"]]);
  });

  it("approve처럼 값이 0인 트랜잭션도 가스비를 기록한다", () => {
    const { entries } = build({ txs: [tx({ hash: "0xd", to: USDC, value: "0" })] });
    expect(summary(entries)).toEqual([["fee", "eth:native", "-0.00021"]]);
  });

  it("토큰을 내고 ETH를 받은 트랜잭션은 스왑으로 분류한다", () => {
    const { entries } = build({
      txs: [tx({ hash: "0xe", to: DEX, value: "0" })],
      tokens: [token({ hash: "0xe", logIndex: 3, from: ME, to: DEX, value: "2000000000" })], // 2000 USDC
      internal: [internal({ hash: "0xe", index: 1, value: "500000000000000000" })], // 0.5 ETH
    });
    expect(summary(entries)).toEqual(
      expect.arrayContaining([
        ["fee", "eth:native", "-0.00021"],
        ["trade", `eth:${USDC.toLowerCase()}`, "-2000"],
        ["trade", "eth:native", "0.5"],
      ]),
    );
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((e) => e.groupId))).toEqual(new Set(["eth:0xe"]));
  });

  it("자기 자신에게 보낸 것은 스왑이 아니라 이체이며 합계는 가스비만 남는다", () => {
    const { entries } = build({ txs: [tx({ hash: "0xf", to: ME })] });
    expect(entries.filter((e) => e.kind === "trade")).toHaveLength(0);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    const sum = entries.reduce((s, e) => s.plus(e.amount), new Decimal(0));
    expect(sum.toString()).toBe("-0.00021");
  });

  it("실패한 내부 트랜잭션은 무시한다", () => {
    const { entries } = build({ internal: [internal({ hash: "0x10", value: ONE_ETH, success: false })] });
    expect(entries).toHaveLength(0);
  });

  it("토큰 소수점 자릿수가 없으면 건너뛴다", () => {
    const { entries, skipped } = build({ tokens: [token({ hash: "0x11", value: "100", decimals: null })] });
    expect(entries).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it("주소 오염: 받은 적 없는 토큰을 내가 서명하지 않은 거래에서 보냈다는 기록은 뺀다", () => {
    const FAKE = "0x9999999999999999999999999999999999999999";
    const { entries, skipped } = build({
      tokens: [token({ hash: "0x20", from: ME, to: FRIEND, value: "2500000000", token: FAKE, symbol: "USDC" })],
    });
    expect(entries).toHaveLength(0);
    expect(skipped[0].spoof).toBe(true);
  });

  it("받은 적 있는 토큰이거나 내가 보낸 거래면 정상 출금으로 기록한다", () => {
    const received = build({
      tokens: [
        token({ hash: "0x21", from: FRIEND, to: ME, value: "100000000", time: TIME }),
        token({ hash: "0x22", from: ME, to: DEX, value: "50000000", time: TIME + 1 }), // 남(릴레이어)이 실행한 전송이라도 받은 적 있으면 정상
      ],
    });
    expect(received.entries.map((e) => e.amount)).toEqual(["100", "-50"]);
    const earlier = build({ tokens: [token({ hash: "0x23", from: ME, to: DEX, value: "50000000" })], knownTokens: [`eth:${USDC.toLowerCase()}`] });
    expect(earlier.entries).toHaveLength(1);
  });

  it("영문이 아닌 글자로 이름을 흉내 낸 사칭 토큰(ՍSDС)은 원장에서 뺀다", () => {
    const { entries, skipped } = build({ tokens: [token({ hash: "0x24", from: FRIEND, to: ME, value: "100", symbol: "ՍSDС" })] });
    expect(entries).toHaveLength(0);
    expect(skipped[0].spoof).toBe(true);
  });

  it("아주 작은 수량을 지수 표기 없이 저장한다", () => {
    const { entries } = build({ txs: [tx({ hash: "0x12", from: FRIEND, to: ME, value: "1" })] });
    expect(entries[0].amount).toBe("0.000000000000000001");
  });
});

describe("reconcile", () => {
  it("원장 합계와 실제 잔고의 차이를 계산하고 불일치를 먼저 보여 준다", () => {
    const { entries } = build({
      txs: [tx({ hash: "0x1", from: FRIEND, to: ME })],
      tokens: [token({ hash: "0x2", value: "100000000" })], // 100 USDC
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
    const big = "0x5555555555555555555555555555555555555555";
    const t = (hash: string) =>
      token({ hash, token: big, symbol: "BIG", decimals: 18, value: "1234567123456789012345678" });
    const { entries } = build({ tokens: [t("0x7"), t("0x8")] });
    const rows = reconcile(entries, [
      { location: "Ethereum", asset: "BIG", rawAsset: big, assetKey: `eth:${big}`, amount: new Decimal("2469134.246913578024691356") },
    ]);
    expect(rows[0].ledger.toFixed()).toBe("2469134.246913578024691356");
    expect(rows[0].diff.isZero()).toBe(true);
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
