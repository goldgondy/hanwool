import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "@/lib/db";
import { classifyAll, classifyGroup } from "./classifier";
import type { Decision } from "./types";

const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const STRANGER = "0x9999999999999999999999999999999999999999";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const OWN = new Set([WALLET_A, WALLET_B]);

let n = 0;
const e = (p: Partial<LedgerEntry> & Pick<LedgerEntry, "amount">): LedgerEntry => ({
  id: `e${n++}`,
  sourceId: "A",
  location: "Ethereum",
  time: 1000,
  asset: "ETH",
  assetKey: "eth:native",
  kind: "transfer",
  groupId: "eth:0x1",
  ...p,
});
const fee = (p: Partial<LedgerEntry> = {}) => e({ amount: "-0.001", kind: "fee", ...p });
const cls = (entries: LedgerEntry[]) => classifyGroup("g", entries, OWN);

describe("classifyGroup", () => {
  it("R4: 내 지갑 A → B 이체는 두 계정의 같은 트랜잭션으로 확정된다", () => {
    const c = cls([
      e({ sourceId: "A", amount: "-1", counterparty: WALLET_B }),
      fee({ sourceId: "A" }),
      e({ sourceId: "B", amount: "1", counterparty: WALLET_A }),
    ]);
    expect([c.category, c.status, c.rule]).toEqual(["internal_transfer", "confirmed", "R4"]);
  });

  it("R4: 자기 자신에게 보낸 것도 내 계정 간 이체다", () => {
    const c = cls([e({ amount: "-1" }), e({ amount: "1" }), fee()]);
    expect([c.category, c.rule]).toEqual(["internal_transfer", "R4"]);
  });

  it("R5: 상대 계정의 체인을 동기화하지 않았어도 상대 주소가 내 것이면 이체다", () => {
    const c = cls([e({ amount: "-1", counterparty: WALLET_B.toUpperCase().replace("0X", "0x") }), fee()]);
    expect([c.category, c.rule]).toEqual(["internal_transfer", "R5"]);
  });

  it("R6: 수수료만 있으면 fee_only", () => {
    expect(cls([fee()]).category).toBe("fee_only");
  });

  it("R7: ETH → WETH 래핑", () => {
    const c = cls([e({ amount: "-1", counterparty: WETH }), e({ amount: "1", asset: "WETH", assetKey: `eth:${WETH}`, counterparty: WETH }), fee()]);
    expect([c.category, c.status, c.rule]).toEqual(["wrap", "confirmed", "R7"]);
  });

  it("R9: USDC → ETH 스왑은 교환으로 추정한다", () => {
    const c = cls([e({ amount: "-2000", asset: "USDC", assetKey: `eth:${USDC}` }), e({ amount: "0.5" }), fee()]);
    expect([c.category, c.status, c.rule]).toEqual(["trade", "suggested", "R9"]);
  });

  it("R10: 토큰 컨트랙트가 직접 보낸 토큰은 스팸 의심", () => {
    const jump = "0x83a55164edb54e329886d493589277c35dfc9d02";
    const c = cls([e({ amount: "5", asset: "JUMP", assetKey: `eth:${jump}`, counterparty: "0x83A55164EDB54E329886d493589277c35Dfc9D02" })]);
    expect([c.category, c.status, c.rule]).toEqual(["spam", "suggested", "R10"]);
  });

  it("R10: 이름만 USDT인 사칭 토큰은 스팸 의심, 공식 USDT는 정상 입금", () => {
    const fake = cls([e({ amount: "1000", asset: "USDT", assetKey: "tron:TFakeUsdtContractAddressXXXXXXXXX", counterparty: "TSomeone" })]);
    expect([fake.category, fake.rule]).toEqual(["spam", "R10"]);
    const fakeEvm = cls([e({ amount: "1000", asset: "USDT", assetKey: "eth:0x1111111111111111111111111111111111111111", counterparty: STRANGER })]);
    expect(fakeEvm.category).toBe("spam");
    const real = cls([e({ amount: "1000", asset: "USDT", assetKey: "tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", counterparty: "TSomeone" })]);
    expect(real.category).toBe("external_in");
  });

  it("R3: 블록체인 스테이킹 보상은 보상으로 확정", () => {
    const c = cls([e({ amount: "0.0002", asset: "SOL", assetKey: "sol:native", kind: "income", tag: "reward", counterparty: "StakeAcc" })]);
    expect([c.category, c.status, c.rule]).toEqual(["reward", "confirmed", "R3"]);
  });

  it("R12: 모르는 곳에서 받은 ETH는 검토 필요", () => {
    const c = cls([e({ amount: "1", counterparty: STRANGER })]);
    expect([c.category, c.status, c.rule]).toEqual(["external_in", "needs_review", "R12"]);
  });

  it("R13: 모르는 곳으로 보낸 ETH는 검토 필요", () => {
    const c = cls([e({ amount: "-1", counterparty: STRANGER }), fee()]);
    expect([c.category, c.status, c.rule]).toEqual(["external_out", "needs_review", "R13"]);
  });

  it("한 거래로 내 지갑과 외부에 동시에 보내면 외부로 나간 순금액 기준으로 외부 송금이다", () => {
    const c = cls([
      e({ sourceId: "A", amount: "-1", assetKey: "btc:native", asset: "BTC" }),
      e({ sourceId: "B", amount: "0.4", assetKey: "btc:native", asset: "BTC" }),
    ]);
    expect([c.category, c.rule]).toEqual(["external_out", "R13"]);
  });
});

describe("classifyAll", () => {
  it("계정이 달라도 같은 groupId는 한 그룹으로 묶는다", () => {
    const groups = classifyAll({
      entries: [e({ sourceId: "A", amount: "-1" }), e({ sourceId: "B", amount: "1" })],
      ownAddresses: OWN,
      decisions: new Map(),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].classification.category).toBe("internal_transfer");
  });

  it("사용자 결정이 자동 규칙보다 우선한다", () => {
    const decision: Decision = { key: "eth:0x1", category: "external_in", costKrw: "3000000", note: "친구에게 받음", decidedAt: 0 };
    const [g] = classifyAll({
      entries: [e({ amount: "5", asset: "JUMP", assetKey: "eth:0xjump", counterparty: "0xjump" })],
      ownAddresses: OWN,
      decisions: new Map([["eth:0x1", decision]]),
    });
    expect(g.classification).toMatchObject({ category: "external_in", status: "user", decision });
  });

  it("최신 그룹부터 정렬한다", () => {
    const groups = classifyAll({
      entries: [e({ groupId: "old", time: 1, amount: "1" }), e({ groupId: "new", time: 2, amount: "1" })],
      ownAddresses: OWN,
      decisions: new Map(),
    });
    expect(groups.map((g) => g.key)).toEqual(["new", "old"]);
  });
});
