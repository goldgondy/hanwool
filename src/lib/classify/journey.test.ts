import { describe, expect, it } from "vitest";
import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import { classifyAll } from "./classifier";
import { buildKoreaOrders, buildKoreaTransfers } from "@/lib/ledger/korea-build";
import { buildBtcEntries } from "@/lib/ledger/btc-build";
import { buildBinanceTrades, buildBinanceTransfers } from "@/lib/ledger/binance-build";
import { buildTronEntries } from "@/lib/ledger/tron-build";
import { buildEvmEntries } from "@/lib/ledger/evm-build";
import { buildXrpEntries } from "@/lib/ledger/xrp-build";
import { detect } from "@/lib/importers";
import { parseUpbitPaste, upbitHistory } from "@/lib/importers/upbit";
import { buildTaxEvents, priceKey, priceQueries } from "@/lib/tax/build-events";
import { runEngine } from "@/lib/tax/engine";
import type { EsploraTx } from "@/lib/btc/esplora";

// 통합 점검 (2026-10-06): 국내 거래소 → 개인 지갑 → 해외 거래소 → 지갑 여러 개 → 국내 거래소로 돌아오는 한 사람의 흐름을
// 실제 변환기로 원장을 만들어 분류·세금 계산까지 돌린다. 이체는 모두 내 계정 간 이체여야 하고, 세금은 매도에서만 생겨야 한다.

const H = (n: number) => n.toString(16).padStart(2, "0").repeat(32); // 64자리 16진수 거래 번호
const kst = (s: string) => Date.parse(`${s}+09:00`);
const T = (s: string) => kst(`2027-01-${s}`);

// ── 주소 ──
const BTC_ME = "bc1qme0000000000000000000000000000000000";
const BTC_CHANGE = "bc1qchange00000000000000000000000000000";
const BTC_BINANCE = "bc1qbinancedeposit000000000000000000000";
const TRON_ME = "TMe00000000000000000000000000000000";
const TRON_OKX = "TOkxDeposit000000000000000000000000";
const TRON_BINANCE_HOT = "TBinanceHot000000000000000000000000";
const USDT_TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const EVM_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVM_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OKX_HOT = "0x0000000000000000000000000000000000000c0c";
const BITHUMB_DEP = "0x00000000000000000000000000000000000b1b1b";
const XRP_ME = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const UPBIT_XRP_HOT = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

function ledger(): LedgerEntry[] {
  const out: LedgerEntry[] = [];

  // 1) 업비트 API: BTC 0.2개를 2천만 원에 매수, 0.1 BTC를 내 지갑으로 출금 (거래 번호 H1)
  out.push(
    ...buildKoreaOrders("upbit", "upbit", [
      { uuid: "o1", side: "bid", market: "KRW-BTC", created_at: "2027-01-05T10:00:00+09:00", executed_volume: "0.2", executed_funds: "20000000", paid_fee: "10000", state: "done" },
    ]),
    ...buildKoreaTransfers("upbit", "upbit", [], [{ uuid: "w1", currency: "BTC", txid: H(1), state: "DONE", created_at: "2027-01-05T11:00:00+09:00", amount: "0.1", fee: "0.0005" }]),
  );

  // 2) 비트코인 지갑: H1로 0.1 받고, H2로 바이낸스에 0.05 보냄 (거스름돈은 내 주소로)
  const btcTxs = [
    { txid: H(1), fee: 1000, status: { confirmed: true, block_time: T("05T11:30:00") / 1000 }, vin: [{ prevout: { scriptpubkey_address: "bc1qupbithot", value: 50_000_000 } }], vout: [{ scriptpubkey_address: BTC_ME, value: 10_000_000 }] },
    {
      txid: H(2),
      fee: 10_000,
      status: { confirmed: true, block_time: T("06T09:00:00") / 1000 },
      vin: [{ prevout: { scriptpubkey_address: BTC_ME, value: 10_000_000 } }],
      vout: [
        { scriptpubkey_address: BTC_BINANCE, value: 5_000_000 },
        { scriptpubkey_address: BTC_CHANGE, value: 4_990_000 },
      ],
    },
  ] as unknown as EsploraTx[];
  out.push(...buildBtcEntries({ sourceId: "btc", addresses: new Set([BTC_ME, BTC_CHANGE]), txs: btcTxs }).entries);

  // 3) 바이낸스 API: H2 입금 0.05 BTC → BTC를 3,000 USDT에 매도 → USDT 2,000을 트론 지갑으로 출금 (H3, 수수료 1)
  out.push(
    ...buildBinanceTransfers(
      "binance",
      [{ id: "d1", amount: "0.05", coin: "BTC", status: 1, txId: H(2), insertTime: T("06T09:40:00") }],
      [{ id: "w1", amount: "2000", transactionFee: "1", coin: "USDT", status: 6, txId: H(3), applyTime: "2027-01-07 01:00:00", completeTime: "2027-01-07 01:05:00" }],
    ),
    ...buildBinanceTrades("binance", [
      { base: "BTC", quote: "USDT", trade: { symbol: "BTCUSDT", id: 1, orderId: 11, qty: "0.05", quoteQty: "3000", commission: "3", commissionAsset: "USDT", time: T("06T12:00:00"), isBuyer: false } },
    ]),
  );

  // 4) 트론 지갑: H3로 2,000 USDT 받고, H4로 OKX 입금 주소에 1,500 보냄
  out.push(
    ...buildTronEntries({
      sourceId: "tron",
      address: TRON_ME,
      txs: [],
      trc20: [
        { transaction_id: H(3), block_timestamp: T("07T10:10:00"), from: TRON_BINANCE_HOT, to: TRON_ME, type: "Transfer", value: "2000000000", token_info: { symbol: "USDT", address: USDT_TRC20, decimals: 6 } },
        { transaction_id: H(4), block_timestamp: T("08T10:00:00"), from: TRON_ME, to: TRON_OKX, type: "Transfer", value: "1500000000", token_info: { symbol: "USDT", address: USDT_TRC20, decimals: 6 } },
      ],
    }).entries,
  );

  // 5) OKX 파일 3개: 입금(H4, 파일 이름 GMT+9) / 거래(USDT 1,500으로 ETH 0.5 매수, UTC+8) / 출금(ETH 0.49 + 수수료 0.002, H5)
  const okxFile = (text: string, fileName: string) => {
    const found = detect(text);
    if (!found.adapter) throw new Error(`OKX 파일 인식 실패: ${fileName}`);
    const table = { ...found.table, preamble: [...(found.table.preamble ?? []), `file: ${fileName}`] };
    return found.adapter.convert(table, "okx").entries;
  };
  out.push(
    ...okxFile(["UID: 1,Account type: Main,Time: 01/31/2027 10:00", "", "Time,Crypto,Deposit address,Network,Transaction ID,Amount,Status", `01/08/2027 10:20:00,USDT,${TRON_OKX},TRC20,${H(4)},1500,Completed`].join("\n"), "OKX_deposit_history(GMT+9).csv"),
    ...okxFile(
      [
        "UID:1,Account Type:Trading,Time Zone:UTC+8",
        "id,Order id,Time,Trade Type,Symbol,Action,Amount,Trading Unit,Filled Price,PnL,Fee,Fee Unit,Position Change,Position Balance,Balance Change,Balance,Balance Unit",
        "3,900,2027-01-08 10:00:00,Transfer,,Transfer in,0,cont,0,0,0,USDT,0,0,1500,1500,USDT",
        "2,901,2027-01-08 11:00:00,Spot,ETH-USDT,Buy,0.5,ETH,3000,0,-0.0005,ETH,0,0,0.4995,0.4995,ETH",
        "1,901,2027-01-08 11:00:00,Spot,ETH-USDT,Sell,1500,ETH,3000,0,0,USDT,0,0,-1500,0,USDT",
        "4,902,2027-01-08 11:30:00,Transfer,,Transfer out,0,cont,0,0,0,ETH,0,0,-0.4995,0,ETH",
      ].join("\n"),
      "OKX_trading.csv",
    ),
    ...okxFile(
      ["UID: 1,Account type: Main,Time: 01/31/2027 10:00", "", "Time,Crypto,Withdrawal address,Network,Transaction ID,Amount,Fee,Status,Reference no.", `01/08/2027 12:40:00,ETH,${EVM_A},Arbitrum One,0x${H(5)},0.49,0.002,Sent,1`].join("\n"),
      "OKX_withdrawal_history(GMT+9).csv",
    ),
  );

  // 6) 이더리움 지갑 A(아비트럼): H5로 0.49 받고 → H6으로 지갑 B에 0.3 → 지갑 B가 H7로 빗썸 입금 주소에 0.25
  const evm = (sourceId: string, address: string, txs: { hash: string; from: string; to: string; value: string; fee: string; time: number }[]) =>
    buildEvmEntries({ sourceId, chain: "arb", address, internal: [], tokens: [], txs: txs.map((t) => ({ ...t, hash: `0x${t.hash}`, success: true })) }).entries;
  const wei = (eth: string) => new Decimal(eth).mul("1e18").toFixed(0);
  const tx5 = { hash: H(5), from: OKX_HOT, to: EVM_A, value: wei("0.49"), fee: wei("0.00002"), time: T("08T12:45:00") };
  const tx6 = { hash: H(6), from: EVM_A, to: EVM_B, value: wei("0.3"), fee: wei("0.00001"), time: T("09T09:00:00") };
  const tx7 = { hash: H(7), from: EVM_B, to: BITHUMB_DEP, value: wei("0.25"), fee: wei("0.00001"), time: T("10T09:00:00") };
  out.push(...evm("evmA", EVM_A, [tx5, tx6]), ...evm("evmB", EVM_B, [tx6, tx7]));

  // 7) 빗썸 엑셀(거래 번호 없음): ETH 0.25 입금 → 매도 → 원화 출금
  const bithumb = detect(
    [
      "Bithumb 기간별 거래 내역",
      "기간 : 2027-01-01 00:00:00 ~ 2027-01-31 23:59:59",
      "거래일시\t자산\t거래구분\t거래수량\t체결가격\t거래금액\t수수료\t정산금액",
      "2027-01-10 12:00:00\t원화\t출금\t1,250,000 KRW\t-\t1,249,000 KRW\t1,000 KRW\t-1,250,000 KRW",
      "2027-01-10 11:00:00\t이더리움\t매도\t0.25 ETH\t5,000,000 KRW\t1,250,000 KRW\t500 KRW\t+1,249,500 KRW",
      "2027-01-10 09:40:00\t이더리움\t입금\t0.25 ETH\t-\t0.25 ETH\t- ETH\t+0.25 ETH",
    ].join("\n"),
  );
  if (!bithumb.adapter) throw new Error("빗썸 인식 실패");
  out.push(...bithumb.adapter.convert(bithumb.table, "bithumb").entries);

  // 8) 업비트 붙여넣기: XRP 100개 매수 → 100개 출금(수수료 1 XRP, 거래 번호 없음) → XRP 지갑이 받음 (H8)
  const paste = parseUpbitPaste(
    [
      "체결시간\t코인\t마켓\t종류\t거래수량\t거래단가\t거래금액\t수수료\t정산금액\t주문시간",
      "2027.01.12\n15:14\tXRP\t-\t출금\t100 XRP\t3,000 KRW\t300,000 KRW\t1 XRP\t101 XRP\t-",
      "2027.01.12\n15:00\tXRP\tKRW\t매수\t101 XRP\t3,000 KRW\t303,000 KRW\t151.5 KRW\t303,152 KRW\t2027.01.12\n15:00",
    ].join("\n"),
  );
  if (!paste) throw new Error("업비트 붙여넣기 인식 실패");
  out.push(...upbitHistory.convert(paste.table, "upbitPaste").entries);
  out.push(
    ...buildXrpEntries({
      sourceId: "xrp",
      address: XRP_ME,
      txs: [
        {
          hash: H(8).toUpperCase(),
          ledgerIndex: 1,
          date: T("12T15:20:00") / 1000 - 946_684_800,
          type: "Payment",
          account: UPBIT_XRP_HOT,
          destination: XRP_ME,
          fee: "12",
          result: "tesSUCCESS",
          nodes: [{ kind: "ModifiedNode", node: { LedgerEntryType: "AccountRoot", FinalFields: { Account: XRP_ME, Balance: "110000000" }, PreviousFields: { Balance: "10000000" } } }],
        },
      ],
    }),
  );
  return out;
}

describe("여러 계정을 오가는 흐름 (국내 ↔ 지갑 ↔ 해외)", () => {
  const entries = ledger();
  const own = new Set([BTC_ME, BTC_CHANGE, TRON_ME, EVM_A, EVM_B, XRP_ME]);
  const groups = classifyAll({ entries, ownAddresses: own, decisions: new Map() });
  const cat = (g: (typeof groups)[number]) => `${g.classification.category}/${g.classification.rule}`;

  it("검토가 필요한 거래가 하나도 남지 않는다", () => {
    const open = groups.filter((g) => g.classification.status === "needs_review");
    expect(open.map((g) => `${g.key} ${cat(g)} ${g.classification.reason}`)).toEqual([]);
  });

  it("이체 7건이 모두 내 계정 간 이체로 짝지어진다", () => {
    const transfers = groups.filter((g) => g.classification.category === "internal_transfer");
    // 업비트→BTC지갑(H1), BTC지갑→바이낸스(H2), 바이낸스→트론(H3), 트론→OKX(H4), OKX→지갑A(H5), A→B(H6), B→빗썸(R11), 업비트 XRP→XRP지갑(R11)
    const rules = transfers.map((g) => g.classification.rule).sort();
    expect(rules).toEqual(["R11", "R11", "R11", "R11", "R4", "R4", "R4", "R4", "R4", "R4"]);
  });

  it("세금은 매도에서만 생긴다 (BTC→USDT, USDT→ETH, ETH→원화)", () => {
    const prices = new Map<string, Decimal | null>();
    const P: Record<string, number> = { BTC: 100_000_000, USDT: 1_400, ETH: 5_000_000, XRP: 3_000 };
    for (const q of priceQueries(groups)) prices.set(priceKey(q.symbol, q.time), new Decimal(P[q.symbol] ?? 0));
    const built = buildTaxEvents(groups, prices);
    expect(built.unresolved.map((u) => `${u.category} ${u.reason}`)).toEqual([]);
    const engine = runEngine(built.events, {});
    const sold = [...new Set(engine.disposals.filter((d) => d.proceedsKrw.gt(0)).map((d) => d.asset))].sort();
    expect(sold).toEqual(["BTC", "ETH", "USDT"]);
    // 이체는 원가를 끊지 않는다: 빗썸에서 판 ETH의 원가 = OKX에서 산 ETH의 평균단가(USDT 1,500 × 1,400원 ÷ 0.5)
    const ethSale = engine.disposals.find((d) => d.asset === "ETH" && d.proceedsKrw.gt(0))!;
    expect(ethSale.costKrw.toFixed(0)).toBe(new Decimal(1500).mul(1400).div("0.5").mul("0.25").toFixed(0));
    expect(engine.warnings.filter((w) => w.message.includes("부족"))).toEqual([]);
  });
});

describe("까다로운 경우", () => {
  const evmEntries = (sourceId: string, chain: "eth" | "arb", address: string, txs: { hash: string; from: string; to: string; value: string; fee: string; time: number }[]) =>
    buildEvmEntries({ sourceId, chain, address, internal: [], tokens: [], txs: txs.map((t) => ({ ...t, success: true })) }).entries;
  const wei = (eth: string) => new Decimal(eth).mul("1e18").toFixed(0);
  const BRIDGE = "0x00000000000000000000000000000000000b4d6e";

  it("같은 지갑에서 이더리움 → 아비트럼으로 브리지 (체인이 달라 거래 번호가 다름) → 내 계정 간 이체로 추정", () => {
    const entries = [
      ...evmEntries("w", "eth", EVM_A, [{ hash: `0x${H(20)}`, from: EVM_A, to: BRIDGE, value: wei("1"), fee: wei("0.001"), time: T("15T10:00:00") }]),
      ...evmEntries("w", "arb", EVM_A, [{ hash: `0x${H(21)}`, from: BRIDGE, to: EVM_A, value: wei("0.999"), fee: "0", time: T("15T10:12:00") }]),
    ];
    const groups = classifyAll({ entries, ownAddresses: new Set([EVM_A]), decisions: new Map() });
    expect(groups.map((g) => [g.classification.category, g.classification.status])).toEqual([
      ["internal_transfer", "suggested"],
      ["internal_transfer", "suggested"],
    ]);
  });

  it("같은 계정 같은 체인에서 보냈다가 다시 받은 건 짝짓지 않는다 (서로 다른 거래)", () => {
    const entries = evmEntries("w", "arb", EVM_A, [
      { hash: `0x${H(22)}`, from: EVM_A, to: BITHUMB_DEP, value: wei("1"), fee: wei("0.0001"), time: T("16T10:00:00") },
      { hash: `0x${H(23)}`, from: OKX_HOT, to: EVM_A, value: wei("1"), fee: "0", time: T("16T11:00:00") },
    ]);
    const groups = classifyAll({ entries, ownAddresses: new Set([EVM_A]), decisions: new Map() });
    expect(groups.every((g) => g.classification.rule !== "R11")).toBe(true);
  });

  it("같은 금액을 업비트에서 두 거래소로 보내도(거래 번호 없음) 모두 내 계정 간 이체로 짝지어진다", () => {
    const paste = parseUpbitPaste(
      [
        "체결시간\t코인\t마켓\t종류\t거래수량\t거래단가\t거래금액\t수수료\t정산금액\t주문시간",
        "2027.01.20\n10:00\tXRP\t-\t출금\t100 XRP\t3,000 KRW\t300,000 KRW\t1 XRP\t101 XRP\t-",
        "2027.01.20\n10:05\tXRP\t-\t출금\t100 XRP\t3,000 KRW\t300,000 KRW\t1 XRP\t101 XRP\t-",
      ].join("\n"),
    )!;
    const entries = [
      ...upbitHistory.convert(paste.table, "up").entries,
      ...buildBinanceTransfers("bn", [{ id: "x1", amount: "100", coin: "XRP", status: 1, txId: H(30), insertTime: T("20T10:20:00") }], []),
      ...buildKoreaTransfers("bithumb", "bt", [{ uuid: "x2", currency: "XRP", txid: H(31), state: "DEPOSIT_ACCEPTED", created_at: "2027-01-20T10:30:00+09:00", amount: "100" }], []),
    ];
    const groups = classifyAll({ entries, ownAddresses: new Set(), decisions: new Map() });
    expect(groups.filter((g) => g.classification.category === "internal_transfer")).toHaveLength(4);
  });

  it("연결하지 않은 남의 지갑으로 보낸 건 '외부로 나감'으로 남는다", () => {
    const entries = buildBinanceTransfers("bn", [], [{ id: "w9", amount: "50", transactionFee: "1", coin: "USDT", status: 6, txId: H(40), applyTime: "2027-01-21 01:00:00" }]);
    const groups = classifyAll({ entries, ownAddresses: new Set(), decisions: new Map() });
    expect(groups[0].classification.category).toBe("external_out");
  });
});
