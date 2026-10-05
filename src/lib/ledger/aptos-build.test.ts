import { describe, expect, it } from "vitest";
import { normalizeAptos, type AptosActivity } from "@/lib/aptos/api";
import { APT_NATIVE_KEY, APTOS_USDT, buildAptosEntries } from "./aptos-build";

const ME = "0x466ab9a7d9383436e11dc7012746edf7bdc5ebece14a1910c52933467a7e9107";
const act = (p: Partial<AptosActivity>): AptosActivity => ({
  transaction_version: 100,
  event_index: 0,
  owner_address: ME,
  amount: 0,
  type: "0x1::fungible_asset::Deposit",
  asset_type: APTOS_USDT,
  is_gas_fee: false,
  is_transaction_success: true,
  transaction_timestamp: "2026-10-05T14:25:31",
  entry_function_id_str: "0x1::primary_fungible_store::transfer",
  metadata: { symbol: "USDt", decimals: 6 },
  ...p,
});

describe("Aptos", () => {
  it("주소 정규화 (짧은 주소는 0으로 채움)", () => {
    expect(normalizeAptos("0x1")).toBe(`0x${"0".repeat(63)}1`);
    expect(normalizeAptos(ME.toUpperCase().replace("0X", "0x"))).toBe(ME);
    expect(normalizeAptos("1234")).toBeNull();
  });

  it("USDt 입금(이름은 USDT로), 보낸 거래의 가스비, 예전 코인 형식 APT를 하나로", () => {
    const es = buildAptosEntries({
      sourceId: "s",
      hashes: new Map([[100, "0xabc"]]),
      activities: [
        act({ amount: 399970000 }),
        act({ transaction_version: 200, event_index: 1, type: "0x1::coin::WithdrawEvent", asset_type: "0x1::aptos_coin::AptosCoin", amount: 150000000, metadata: { symbol: "APT", decimals: 8 } }),
        act({ transaction_version: 200, event_index: 2, is_gas_fee: true, type: "0x1::aptos_coin::GasFeeEvent", asset_type: "0xa", amount: 1000, metadata: null }),
      ],
    });
    expect(es.map((e) => [e.asset, e.assetKey === APT_NATIVE_KEY, e.kind, e.amount])).toEqual([
      ["USDT", false, "transfer", "399.97"],
      ["APT", true, "transfer", "-1.5"],
      ["APT", true, "fee", "-0.00001"],
    ]);
    expect(es[0].txHash).toBe("0xabc");
    expect(new Date(es[0].time).toISOString()).toBe("2026-10-05T14:25:31.000Z");
  });

  it("실패한 거래는 가스비만, 두 자산이 오가면 교환", () => {
    const es = buildAptosEntries({
      sourceId: "s",
      hashes: new Map(),
      activities: [
        act({ transaction_version: 300, is_transaction_success: false, amount: 5 }),
        act({ transaction_version: 300, event_index: 1, is_gas_fee: true, is_transaction_success: false, asset_type: "0xa", amount: 500, metadata: { symbol: "APT", decimals: 8 } }),
        act({ transaction_version: 400, type: "0x1::fungible_asset::Withdraw", amount: 10_000_000 }),
        act({ transaction_version: 400, event_index: 1, asset_type: "0xa", amount: 200_000_000, metadata: { symbol: "APT", decimals: 8 } }),
      ],
    });
    expect(es.filter((e) => e.groupId === "aptos:300").map((e) => e.kind)).toEqual(["fee"]);
    expect(es.filter((e) => e.groupId === "aptos:400").map((e) => [e.asset, e.kind, e.amount])).toEqual([
      ["USDT", "trade", "-10"],
      ["APT", "trade", "2"],
    ]);
  });
});
