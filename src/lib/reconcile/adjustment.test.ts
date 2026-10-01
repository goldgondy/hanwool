import { describe, expect, it } from "vitest";
import { classifyAll } from "@/lib/classify/classifier";
import type { Decision } from "@/lib/classify/types";
import type { LedgerEntry } from "@/lib/db";
import { buildTaxEvents } from "@/lib/tax/build-events";

// 잔고 대사 조정(run.ts applyAdjustment가 만드는 형태)이 분류·세금 계산까지 이어지는지 확인
const T = Date.parse("2027-03-01T00:00:00Z");
const groupId = `adjust:wallet:eth:0xae7a:${T}`;
const adjustment = (amount: string): LedgerEntry => ({
  id: `wallet:${groupId}`,
  sourceId: "wallet",
  location: "Ethereum",
  time: T,
  asset: "stETH",
  assetKey: "eth:0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
  amount,
  kind: "transfer",
  groupId,
  origin: "manual",
  rawType: "잔고 대사 조정",
});

const run = (entry: LedgerEntry, decision: Decision) => {
  const groups = classifyAll({ entries: [entry], ownAddresses: new Set(), decisions: new Map([[decision.key, decision]]) });
  return { groups, built: buildTaxEvents(groups, new Map()) };
};

describe("잔고 대사 조정", () => {
  it("증가를 보상으로 처리하면 0원에 취득한다", () => {
    const { groups, built } = run(adjustment("0.3"), { key: groupId, category: "reward", note: "잔고 대사", decidedAt: T });
    expect(groups[0].classification).toMatchObject({ category: "reward", status: "user" });
    expect(built.events).toHaveLength(1);
    expect(built.events[0]).toMatchObject({ type: "acquire", asset: "STETH" });
    expect(built.events[0].type === "acquire" && built.events[0].costKrw.toString()).toBe("0");
    expect(built.unresolved).toHaveLength(0);
  });

  it("감소를 외부로 보냄으로 처리하면 양도로 계산한다", () => {
    const { built } = run(adjustment("-0.5"), { key: groupId, category: "external_out", note: "잔고 대사", decidedAt: T });
    expect(built.events[0]).toMatchObject({ type: "dispose", asset: "STETH" });
  });

  it("결정 없이 남은 조정은 검토 필요로 남는다", () => {
    const groups = classifyAll({ entries: [adjustment("0.3")], ownAddresses: new Set(), decisions: new Map() });
    expect(groups[0].classification.status).toBe("needs_review");
  });
});
