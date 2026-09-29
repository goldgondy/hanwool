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

describe("buildTaxEvents", () => {
  it("교환: 판 코인은 시가로 양도, 산 코인은 시가로 취득, 가스비는 수수료", () => {
    const r = buildTaxEvents([group("trade", [leg("USDC", "-2000"), leg("ETH", "0.5"), fee()])], prices({ USDC: "1400", ETH: "5600000" }));
    expect(brief(r)).toEqual([
      ["fee", "ETH", "0.001"],
      ["dispose", "USDC", "2000", "2800000"],
      ["acquire", "ETH", "0.5", "2800000"],
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

  it("시세가 필요한 것은 교환·외부 입출금뿐이다", () => {
    const q = priceQueries([
      group("trade", [leg("USDC", "-1"), leg("ETH", "1")]),
      group("internal_transfer", [leg("BTC", "-1"), leg("BTC", "1")]),
      group("reward", [leg("ETH", "1")]),
    ]);
    expect(q.map((x) => x.symbol).sort()).toEqual(["ETH", "USDC"]);
  });
});
