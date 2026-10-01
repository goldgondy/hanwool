import { describe, expect, it } from "vitest";
import { buildCoinbaseEntries, type CoinbaseTx } from "./coinbase-build";

const tx = (p: Partial<CoinbaseTx> & Pick<CoinbaseTx, "id" | "type" | "amount">): CoinbaseTx => ({ status: "completed", created_at: "2027-03-01T00:00:00Z", ...p });
const brief = (r: ReturnType<typeof buildCoinbaseEntries>) => r.entries.map((e) => [e.kind, e.assetKey, e.amount, e.groupId]);

describe("buildCoinbaseEntries", () => {
  it("어드밴스드 체결: 두 지갑의 기록을 주문 번호로 묶고, 달러 지갑은 법정화폐로 표시", () => {
    const r = buildCoinbaseEntries("s", [
      tx({ id: "a", type: "advanced_trade_fill", amount: { amount: "0.01", currency: "BTC" }, advanced_trade_fill: { order_id: "o1" } }),
      tx({ id: "b", type: "advanced_trade_fill", amount: { amount: "-1001.2", currency: "USD" }, advanced_trade_fill: { order_id: "o1" } }),
    ]);
    expect(brief(r)).toEqual([
      ["trade", "BTC", "0.01", "cb:order:o1"],
      ["trade", "fiat:USD", "-1001.2", "cb:order:o1"],
    ]);
  });

  it("카드 매수: 법정화폐 지갑 기록이 없으면 결제 금액을 대가로 보충하고, 법정화폐 합계는 0", () => {
    const r = buildCoinbaseEntries("s", [
      tx({ id: "c", type: "buy", amount: { amount: "0.5", currency: "ETH" }, native_amount: { amount: "1500", currency: "USD" }, buy: { id: "buy1" } }),
    ]);
    expect(brief(r)).toEqual([
      ["trade", "ETH", "0.5", "cb:buy:buy1"],
      ["trade", "fiat:USD", "-1500", "cb:buy:buy1"],
      ["transfer", "fiat:USD", "1500", "cb:buy:buy1:pay"],
    ]);
  });

  it("달러 지갑으로 산 경우에는 보충하지 않는다", () => {
    const r = buildCoinbaseEntries("s", [
      tx({ id: "d", type: "buy", amount: { amount: "0.5", currency: "ETH" }, native_amount: { amount: "1500", currency: "USD" }, buy: { id: "buy2" } }),
      tx({ id: "e", type: "buy", amount: { amount: "-1500", currency: "USD" }, buy: { id: "buy2" } }),
    ]);
    expect(r.entries).toHaveLength(2);
  });

  it("송금은 블록체인 해시와 함께, 내부 이동·미완료는 제외, 스테이킹 보상은 보상", () => {
    const r = buildCoinbaseEntries("s", [
      tx({ id: "f", type: "send", amount: { amount: "-2", currency: "SOL" }, network: { hash: "5abc" } }),
      tx({ id: "g", type: "transfer", amount: { amount: "-1", currency: "ETH" } }),
      tx({ id: "h", type: "send", status: "pending", amount: { amount: "-1", currency: "ETH" } }),
      tx({ id: "i", type: "staking_reward", amount: { amount: "0.001", currency: "SOL" } }),
    ]);
    expect(r.entries.map((e) => [e.kind, e.amount, e.txHash, e.tag])).toEqual([
      ["transfer", "-2", "5abc", undefined],
      ["income", "0.001", undefined, "reward"],
    ]);
  });
});
