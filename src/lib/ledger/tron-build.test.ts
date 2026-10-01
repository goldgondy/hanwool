import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import { toHex } from "@/lib/tron/address";
import type { Trc20Transfer, TronTx } from "@/lib/tron/trongrid";
import { buildTronEntries } from "./tron-build";

// 실제 TronGrid 응답 형식을 따른 가짜 데이터 (주소는 실제 형식의 유효한 주소)
const ME = "TWoYrRBWqb2K9viaFTwn3dDVt59Y5hgkJ7";
const OTHER = "TBP2wFbyVVD7n9SDJbdqw2V9gPBz6bCDFz";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const T = 1_790_853_204_000;

const tx = (txID: string, type: string, value: Record<string, unknown>, fee = 0, ok = true): TronTx => ({
  txID,
  block_timestamp: T,
  ret: [{ contractRet: ok ? "SUCCESS" : "REVERT", fee }],
  raw_data: { contract: [{ type, parameter: { value } }] },
});
const usdt = (id: string, from: string, to: string, value: string): Trc20Transfer => ({
  transaction_id: id,
  block_timestamp: T,
  from,
  to,
  type: "Transfer",
  value,
  token_info: { symbol: "USDT", address: USDT, decimals: 6, name: "Tether USD" },
});

const brief = (r: ReturnType<typeof buildTronEntries>) => r.entries.map((e) => [e.kind, e.asset, e.amount]);

describe("buildTronEntries", () => {
  it("USDT 보내기: 토큰 출금 + 소각된 TRX 수수료 (실제 응답의 fee 345000 sun)", () => {
    const r = buildTronEntries({
      sourceId: "s",
      address: ME,
      txs: [tx("aa", "TriggerSmartContract", { owner_address: toHex(ME), contract_address: toHex(USDT) }, 345000)],
      trc20: [usdt("aa", ME, OTHER, "83272000000")],
    });
    expect(brief(r)).toEqual([
      ["fee", "TRX", "-0.345"],
      ["transfer", "USDT", "-83272"],
    ]);
    expect(r.entries[1].assetKey).toBe(`tron:${USDT}`);
    expect(r.entries[1].counterparty).toBe(OTHER);
  });

  it("업비트에서 USDT 받기: 남이 낸 거래라 수수료 없이 입금만", () => {
    const r = buildTronEntries({ sourceId: "s", address: ME, txs: [], trc20: [usdt("bb", OTHER, ME, "1000000000")] });
    expect(brief(r)).toEqual([["transfer", "USDT", "1000"]]);
  });

  it("TRX 송금·수신, 실패한 거래는 수수료만", () => {
    const r = buildTronEntries({
      sourceId: "s",
      address: ME,
      txs: [
        tx("c1", "TransferContract", { owner_address: toHex(ME), to_address: toHex(OTHER), amount: 5_000_000 }, 1_100_000),
        tx("c2", "TransferContract", { owner_address: toHex(OTHER), to_address: toHex(ME), amount: 2_000_000 }, 1_100_000),
        tx("c3", "TriggerSmartContract", { owner_address: toHex(ME), contract_address: toHex(USDT) }, 8_000_000, false),
      ],
      trc20: [],
    });
    expect(brief(r)).toEqual([
      ["fee", "TRX", "-1.1"],
      ["transfer", "TRX", "-5"],
      ["transfer", "TRX", "2"],
      ["fee", "TRX", "-8"],
    ]);
  });

  it("주소 오염 사기의 0원 전송은 건너뛴다", () => {
    const r = buildTronEntries({ sourceId: "s", address: ME, txs: [], trc20: [usdt("dd", ME, OTHER, "0")] });
    expect(r.entries).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it("동결은 수수료만, 투표 보상은 보상으로, 모르는 유형은 알린다", () => {
    const r = buildTronEntries({
      sourceId: "s",
      address: ME,
      txs: [
        tx("f1", "FreezeBalanceV2Contract", { owner_address: toHex(ME), frozen_balance: 100_000_000 }, 0),
        tx("f2", "WithdrawBalanceContract", { owner_address: toHex(ME) }, 0),
        tx("f3", "SomeFutureContract", { owner_address: toHex(ME) }, 0),
      ],
      trc20: [],
      rewardAmounts: { f2: 3_500_000 },
    });
    expect(brief(r)).toEqual([["income", "TRX", "3.5"]]);
    expect(r.entries[0].tag).toBe("reward");
    expect(r.unknownTypes).toEqual(["SomeFutureContract"]);
  });

  it("TRX를 내고 USDT를 받은 거래는 스왑으로 표시하고, 합계가 잔고 변화와 같다", () => {
    const r = buildTronEntries({
      sourceId: "s",
      address: ME,
      txs: [tx("e1", "TriggerSmartContract", { owner_address: toHex(ME), contract_address: toHex(OTHER), call_value: 100_000_000 }, 2_000_000)],
      trc20: [usdt("e1", OTHER, ME, "29000000")],
    });
    expect(r.entries.filter((e) => e.kind === "trade").map((e) => e.asset).sort()).toEqual(["TRX", "USDT"]);
    const trx = r.entries.filter((e) => e.asset === "TRX").reduce((s, e) => s.plus(e.amount), new Decimal(0));
    expect(trx.toString()).toBe("-102");
  });
});
