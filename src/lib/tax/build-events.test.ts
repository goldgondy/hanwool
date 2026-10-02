import Decimal from "@/lib/decimal";
import { describe, expect, it } from "vitest";
import type { GroupView } from "@/lib/classify/classifier";
import type { Category, ClassificationStatus, Decision } from "@/lib/classify/types";
import type { LedgerEntry } from "@/lib/db";
import { buildTaxEvents, priceKey, priceQueries } from "./build-events";

const T = Date.parse("2027-03-01T00:00:00Z");
let n = 0;
const leg = (asset: string, amount: string, p: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: `e${n++}`,
  sourceId: "A",
  location: "Ethereum",
  time: T,
  asset,
  assetKey: `eth:${asset}`,
  amount,
  kind: "transfer",
  groupId: "g",
  ...p,
});
const fee = (asset = "ETH", amount = "-0.001") => leg(asset, amount, { kind: "fee" });
const group = (category: Category, entries: LedgerEntry[], status: ClassificationStatus = "confirmed", decision?: Decision): GroupView => ({
  key: `g${n++}`,
  time: T,
  entries,
  classification: { key: "g", category, status, rule: "-", reason: "test", decision },
});
const prices = (p: Record<string, string>) => new Map(Object.entries(p).map(([s, v]) => [priceKey(s, T), new Decimal(v)]));
const brief = (r: ReturnType<typeof buildTaxEvents>) =>
  r.events.map((e) =>
    e.type === "acquire" ? ["acquire", e.asset, e.qty.toString(), e.costKrw.toString()]
    : e.type === "dispose" ? ["dispose", e.asset, e.qty.toString(), e.proceedsKrw.toString()]
    : ["fee", e.asset, e.qty.toString()],
  );

describe("buildTaxEvents: R11 짝지은 이체", () => {
  it("보낸 쪽에 기록된 차이(이체 수수료)만 수수료로, 이체 자체는 과세 없음", () => {
    const out = group("internal_transfer", [leg("USDT", "-100")], "suggested");
    out.classification.pair = { key: "x", feeAsset: "USDT", feeQty: "1" };
    const inn = group("internal_transfer", [leg("USDT", "99")], "suggested");
    inn.classification.pair = { key: out.key };
    expect(brief(buildTaxEvents([out, inn], prices({})))).toEqual([["fee", "USDT", "1"]]);
  });
});

describe("buildTaxEvents", () => {
  it("교환: 판 코인은 시가로 양도, 산 코인은 시가로 취득, 가스비는 수수료", () => {
    const r = buildTaxEvents([group("trade", [leg("USDC", "-2000"), leg("ETH", "0.5"), fee()])], prices({ USDC: "1400", ETH: "5600000" }));
    expect(brief(r)).toEqual([
      ["fee", "ETH", "0.001"],
      ["dispose", "USDC", "2000", "2800000"],
      ["acquire", "ETH", "0.5", "2800000"],
    ]);
  });

  it("스테이블코인으로 산 경우 ETH 시세가 아니라 실제 지불한 금액이 취득가다", () => {
    // ETH 시세로는 2,900,000원이지만 실제로 낸 것은 2,000 USDC = 2,800,000원
    const r = buildTaxEvents([group("trade", [leg("USDC", "-2000"), leg("ETH", "0.5")])], prices({ USDC: "1400", ETH: "5800000" }));
    expect(brief(r)).toEqual([
      ["dispose", "USDC", "2000", "2800000"],
      ["acquire", "ETH", "0.5", "2800000"],
    ]);
  });

  it("스테이블코인을 받고 판 경우 실제 받은 금액이 양도가이고, 여러 코인이면 시가 비율로 나눈다", () => {
    const r = buildTaxEvents(
      [group("trade", [leg("ETH", "-1"), leg("ARB", "-1000"), leg("USDT", "6000")])],
      prices({ ETH: "5000000", ARB: "1000", USDT: "1350" }), // 시가 비율 5,000,000 : 1,000,000
    );
    expect(brief(r)).toEqual([
      ["dispose", "ETH", "1", "6750000"],
      ["dispose", "ARB", "1000", "1350000"],
      ["acquire", "USDT", "6000", "8100000"],
    ]);
  });

  it("교환에서 한쪽 시세가 없으면 다른 쪽 가치를 쓴다", () => {
    const r = buildTaxEvents([group("trade", [leg("USDC", "-2000"), leg("NEWTOKEN", "100")])], prices({ USDC: "1400" }));
    expect(brief(r)).toContainEqual(["acquire", "NEWTOKEN", "100", "2800000"]);
    expect(r.unpriced).toHaveLength(0);
  });

  it("양쪽 시세가 모두 없으면 0원으로 계산하고 표시한다", () => {
    const r = buildTaxEvents([group("trade", [leg("AAA", "-1"), leg("BBB", "1")])], new Map());
    expect(r.unpriced.map((u) => u.pool)).toEqual(["AAA", "BBB"]);
  });

  it("내 계정 간 이체와 래핑은 수수료만 남는다", () => {
    const r = buildTaxEvents(
      [
        group("internal_transfer", [leg("BTC", "-1", { sourceId: "A" }), leg("BTC", "1", { sourceId: "B" }), fee("BTC", "-0.0001")]),
        group("wrap", [leg("ETH", "-1"), leg("WETH", "1"), fee()]),
      ],
      new Map(),
    );
    expect(brief(r)).toEqual([
      ["fee", "BTC", "0.0001"],
      ["fee", "ETH", "0.001"],
    ]);
  });

  it("외부로 보내면 시가로 양도하고, 검토 전이면 미확인으로 모은다", () => {
    const r = buildTaxEvents([group("external_out", [leg("ETH", "-1"), fee()], "needs_review")], prices({ ETH: "5000000" }));
    expect(brief(r)).toContainEqual(["dispose", "ETH", "1", "5000000"]);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0].valueKrw?.toString()).toBe("5000000");
  });

  it("내 지갑과 외부에 동시에 보낸 거래는 외부로 나간 순수량만 양도한다", () => {
    const r = buildTaxEvents(
      [group("external_out", [leg("BTC", "-1", { sourceId: "A" }), leg("BTC", "0.4", { sourceId: "B" })])],
      prices({ BTC: "100000000" }),
    );
    expect(brief(r)).toEqual([["dispose", "BTC", "0.6", "60000000"]]);
  });

  it("외부에서 받은 코인은 사용자 입력 취득가, 없으면 0원", () => {
    const withCost = buildTaxEvents(
      [group("external_in", [leg("BTC", "0.1")], "user", { key: "g", category: "external_in", costKrw: "9000000", decidedAt: 0 })],
      new Map(),
    );
    expect(brief(withCost)).toEqual([["acquire", "BTC", "0.1", "9000000"]]);
    const noCost = buildTaxEvents([group("external_in", [leg("BTC", "0.1")], "needs_review")], new Map());
    expect(brief(noCost)).toEqual([["acquire", "BTC", "0.1", "0"]]);
    expect(noCost.unresolved).toHaveLength(1);
  });

  it("보상과 에어드랍은 0원에 취득, 스팸은 무시", () => {
    const r = buildTaxEvents(
      [group("reward", [leg("ETH", "0.01")]), group("airdrop", [leg("ARB", "100")]), group("spam", [leg("JUMP", "5")])],
      new Map(),
    );
    expect(brief(r)).toEqual([
      ["acquire", "ETH", "0.01", "0"],
      ["acquire", "ARB", "100", "0"],
    ]);
  });

  it("원화 매수: 지불한 원화 + 원화 수수료가 취득가다 (시세와 무관)", () => {
    const krw = (amount: string, kind: LedgerEntry["kind"] = "trade") => leg("KRW", amount, { assetKey: "fiat:KRW", kind, origin: "exchange" });
    const r = buildTaxEvents(
      [group("buy_fiat", [krw("-10000000"), krw("-5000", "fee"), leg("BTC", "0.1", { origin: "exchange" })])],
      prices({ BTC: "120000000" }), // 시가로는 12,000,000원이지만 실제 지불액을 쓴다
    );
    expect(brief(r)).toEqual([["acquire", "BTC", "0.1", "10005000"]]);
    expect(r.pools.has("KRW")).toBe(false);
  });

  it("원화 매도: 받은 원화에서 원화 수수료를 뺀 금액이 양도가다", () => {
    const krw = (amount: string, kind: LedgerEntry["kind"] = "trade") => leg("KRW", amount, { assetKey: "fiat:KRW", kind, origin: "exchange" });
    const r = buildTaxEvents([group("sell_fiat", [leg("BTC", "-0.1"), krw("12000000"), krw("-6000", "fee")])], new Map());
    expect(brief(r)).toEqual([["dispose", "BTC", "0.1", "11994000"]]);
  });

  it("달러 매수는 원/달러 환율로 환산하고, 환율이 없으면 표시한다", () => {
    const usd = (amount: string) => leg("USD", amount, { assetKey: "fiat:USD", origin: "exchange" });
    const withRate = buildTaxEvents([group("buy_fiat", [usd("-1000"), leg("ETH", "0.3")])], prices({ USD: "1400" }));
    expect(brief(withRate)).toEqual([["acquire", "ETH", "0.3", "1400000"]]);
    const noRate = buildTaxEvents([group("buy_fiat", [usd("-1000"), leg("ETH", "0.3")])], new Map());
    expect(noRate.unpriced.map((u) => u.pool)).toEqual(["USD"]);
  });

  it("시세가 필요한 것은 교환·외부 입출금뿐이다", () => {
    const q = priceQueries([
      group("trade", [leg("USDC", "-1"), leg("ETH", "1")]),
      group("internal_transfer", [leg("BTC", "-1"), leg("BTC", "1")]),
      group("reward", [leg("ETH", "1")]),
    ]);
    expect(q.map((x) => x.symbol).sort()).toEqual(["ETH", "USDC"]);
  });
});
