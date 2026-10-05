import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import { toRawTon, tonHashHex } from "@/lib/ton/address";
import { classifyAll } from "@/lib/classify/classifier";
import { buildTonEntries, TON_NATIVE_KEY } from "./ton-build";
import type { TonJettonTransfer, TonTx } from "@/lib/ton/api";

const ME = "0:276846D6B2D5DFB71AC18254BA686596E2B94240D0276245CB62990EE190EADD";
const OTHER = "0:46635CBDD634C45992509A7BE7F1341E8744A01B4BFA5336EE7D62EBD342D6CC";
const USDT = "0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE";
const META = { [USDT]: { token_info: [{ type: "jetton_masters", symbol: "USD₮", extra: { decimals: "6" } }] } };
const H = (n: number) => btoa(String.fromCharCode(...new Array(32).fill(n)));

const tx = (p: Partial<TonTx> & { before: string; after: string }): TonTx => ({
  hash: H(1),
  lt: "1",
  now: 1_790_000_000,
  trace_id: "T1",
  total_fees: "0",
  in_msg: null,
  out_msgs: [],
  account_state_before: { balance: p.before },
  account_state_after: { balance: p.after },
  ...p,
});
const jt = (p: Partial<TonJettonTransfer>): TonJettonTransfer => ({ source: ME, destination: OTHER, amount: "100000000", jetton_master: USDT, transaction_hash: H(9), transaction_lt: "5", transaction_now: 1_790_000_000, transaction_aborted: false, trace_id: "T1", ...p });
const sum = (es: { assetKey: string; amount: string }[], k: string) => es.filter((e) => e.assetKey === k).reduce((s, e) => s.plus(e.amount), new Decimal(0)).toString();

describe("TON 주소", () => {
  it("사용자 형식(EQ…) ↔ 내부 형식", () => {
    expect(toRawTon("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs")).toBe(USDT);
    expect(toRawTon(USDT.toLowerCase())).toBe(USDT);
    expect(toRawTon("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDt")).toBeNull(); // 체크섬 틀림
    expect(tonHashHex(H(255))).toBe("ff".repeat(32));
  });
});

describe("TON 원장", () => {
  it("TON 송금: 잔고 변화에서 수수료를 떼어 낸다", () => {
    const es = buildTonEntries({ sourceId: "s", address: ME, jettons: [], meta: {}, txs: [tx({ before: "5000000000", after: "2995000000", total_fees: "5000000", out_msgs: [{ destination: OTHER, value: "2000000000" }] })] });
    expect(es.map((e) => [e.kind, e.amount])).toEqual([
      ["fee", "-0.005"],
      ["transfer", "-2"],
    ]);
  });

  it("USDT 보내기: 오간 TON(가스·환불)은 순액을 수수료로, 교환으로 잘못 분류하지 않는다", () => {
    const es = buildTonEntries({
      sourceId: "s",
      address: ME,
      meta: META,
      jettons: [jt({})],
      txs: [tx({ hash: H(2), before: "1000000000", after: "940000000", total_fees: "3000000" }), tx({ hash: H(3), lt: "9", before: "940000000", after: "975000000" })],
    });
    expect(es.find((e) => e.kind === "transfer")?.asset).toBe("USDT"); // USD₮ → USDT
    expect(sum(es, "ton:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe")).toBe("-100");
    expect(es.filter((e) => e.assetKey === TON_NATIVE_KEY).map((e) => [e.kind, e.amount])).toEqual([["fee", "-0.025"]]);
    const [g] = classifyAll({ entries: es, ownAddresses: new Set(), decisions: new Map() });
    expect(g.classification.category).toBe("external_out");
  });

  it("0.001 TON 미만 입금은 먼지 송금(스팸 추정)", () => {
    const es = buildTonEntries({ sourceId: "s", address: ME, jettons: [], meta: {}, txs: [tx({ before: "1000", after: "2000", total_fees: "500", in_msg: { source: OTHER, destination: ME, value: "1500" } })] });
    expect(es.map((e) => [e.rawType, e.amount])).toEqual([["Dust", "0.000001"]]);
    const [g] = classifyAll({ entries: es, ownAddresses: new Set(), decisions: new Map() });
    expect(g.classification.category).toBe("spam");
  });
});
