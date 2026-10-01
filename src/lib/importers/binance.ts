import Decimal from "@/lib/decimal";
import { fiatAssetKey, isFiat } from "@/lib/assets";
import type { LedgerEntry, LedgerKind } from "@/lib/db";
import { rowKey } from "./csv";
import type { CsvAdapter, ImportResult } from "./types";

// 바이낸스 "Transaction History" (전체 거래 명세서) CSV
// 열: User_ID, UTC_Time, Account, Operation, Coin, Change, Remark
// 한 행 = 한 계정(Spot/Funding/Earn…)의 잔고 변동 한 건. 우리 원장과 구조가 같다.
// ⚠ 실제 샘플로 검증 전: 공개된 형식 기준으로 작성. 유형 이름은 바이낸스가 바꿀 수 있어 모르는 유형은 검토 필요로 보낸다.

type Family = "trade" | "fee" | "transfer" | "internal" | "reward" | "airdrop" | "derivative";

// 유형 이름(소문자) → 성격
const OPERATIONS: Record<string, Family> = {
  buy: "trade",
  sell: "trade",
  "transaction buy": "trade",
  "transaction spend": "trade",
  "transaction sold": "trade",
  "transaction revenue": "trade",
  "transaction related": "trade",
  "binance convert": "trade",
  "small assets exchange bnb": "trade",
  "large otc trading": "trade",
  "auto-invest transaction": "trade",
  fee: "fee",
  "transaction fee": "fee",

  deposit: "transfer",
  "crypto deposit": "transfer",
  "fiat deposit": "transfer",
  withdraw: "transfer",
  withdrawal: "transfer",
  "crypto withdrawal": "transfer",
  "fiat withdraw": "transfer",
  send: "transfer",

  "transfer between main and funding wallet": "internal",
  "main and funding account transfer": "internal",
  "transfer funds to spot": "internal",
  "transfer funds to funding wallet": "internal",
  "transfer between spot account and um futures account": "internal",
  "transfer between spot account and cm futures account": "internal",
  "simple earn flexible subscription": "internal",
  "simple earn flexible redemption": "internal",
  "simple earn locked subscription": "internal",
  "simple earn locked redemption": "internal",
  "savings purchase": "internal",
  "savings principal redemption": "internal",
  "staking purchase": "internal",
  "staking redemption": "internal",
  "launchpool subscription/redemption": "internal",

  "simple earn flexible interest": "reward",
  "simple earn locked rewards": "reward",
  "simple earn flexible airdrop": "airdrop",
  "staking rewards": "reward",
  "savings interest": "reward",
  "pos savings interest": "reward",
  "launchpool interest": "reward",
  "launchpool airdrop": "airdrop",
  "bnb vault rewards": "reward",
  "eth 2.0 staking rewards": "reward",
  "commission history": "reward",
  "commission rebate": "reward",
  "referral kickback": "reward",
  "cash voucher distribution": "reward",
  "mission reward distribution": "reward",
  "airdrop assets": "airdrop",
  distribution: "airdrop",

  "realized profit and loss": "derivative",
  "realize profit and loss": "derivative",
  "funding fee": "derivative",
  "insurance fund compensation": "derivative",
};

const KIND: Record<Family, LedgerKind> = {
  trade: "trade",
  fee: "fee",
  transfer: "transfer",
  internal: "transfer",
  reward: "income",
  airdrop: "income",
  derivative: "other",
};

// "2024-01-15 10:23:45" (UTC)
function parseUtc(s: string): number {
  const t = Date.parse(`${s.replace(" ", "T")}Z`);
  if (Number.isNaN(t)) throw new Error(`시각 형식을 읽을 수 없습니다: ${s}`);
  return t;
}

export const binanceStatement: CsvAdapter = {
  id: "binance-statement-v1",
  exchange: "binance",
  exchangeName: "바이낸스",
  formatName: "전체 거래 명세서 (Transaction History)",
  howToExport: "바이낸스 → 지갑 → 거래 내역 → 내보내기(Export Transaction Records) → 기간 선택 후 생성·다운로드. 한 번에 최대 1년씩 받을 수 있습니다.",
  verified: false,

  detect: (h) => ["UTC_Time", "Operation", "Coin", "Change"].every((c) => h.includes(c)),

  convert(table, sourceId): ImportResult {
    const entries: LedgerEntry[] = [];
    const warnings: string[] = [];
    const unknown = new Set<string>();
    const seen = new Map<string, number>();
    let from = Infinity;
    let to = -Infinity;

    table.rows.forEach((row, i) => {
      const op = row["Operation"] ?? "";
      const coin = (row["Coin"] ?? "").toUpperCase();
      const changeRaw = row["Change"] ?? "";
      if (!row["UTC_Time"] || !coin || !changeRaw) return;

      let time: number;
      let amount: Decimal;
      try {
        time = parseUtc(row["UTC_Time"]);
        amount = new Decimal(changeRaw);
      } catch {
        warnings.push(`${i + 2}번째 줄을 읽지 못해 건너뛰었습니다`);
        return;
      }
      if (amount.isZero()) return;
      from = Math.min(from, time);
      to = Math.max(to, time);

      let family = OPERATIONS[op.toLowerCase()];
      if (!family) unknown.add(op);
      // 선물 계정(USDT-Futures, Coin-Futures 등)의 체결·수수료는 파생상품 손익의 일부다.
      // 손익과 같은 기준으로 다루도록 함께 미분류로 둔다 (손익은 빼고 수수료만 손실로 잡히는 일을 막음).
      if (/futures/i.test(row["Account"] ?? "") && (family === "trade" || family === "fee")) family = "derivative";

      // 체결·수수료·전환은 같은 시각끼리, 내부 이동은 같은 시각끼리 한 거래로 묶는다. 나머지는 행마다 따로.
      const key = rowKey([row["UTC_Time"], row["Account"] ?? "", op, coin, changeRaw, row["Remark"] ?? ""], seen);
      const groupId =
        family === "trade" || family === "fee"
          ? `binance:trade:${time}`
          : family === "internal"
            ? `binance:internal:${time}`
            : `binance:row:${key}`;

      entries.push({
        id: `${sourceId}:csv:${key}`,
        sourceId,
        location: `Binance ${row["Account"] || ""}`.trim(),
        time,
        asset: coin,
        assetKey: isFiat(coin) ? fiatAssetKey(coin) : coin,
        amount: amount.toString(),
        kind: family ? KIND[family] : "other",
        groupId,
        origin: "exchange",
        tag: family === "reward" ? "reward" : family === "airdrop" ? "airdrop" : undefined,
        rawType: op,
      });
    });

    if (entries.some((e) => e.kind === "other" && (OPERATIONS[e.rawType!.toLowerCase()] === "derivative" || /futures/i.test(e.location)))) {
      warnings.push("선물 손익·펀딩비·선물 수수료가 있습니다. 파생상품 손익의 과세 여부는 검토가 필요해 미분류로 두고 세금 계산에서 제외했습니다.");
    }

    return {
      entries,
      warnings,
      unknownTypes: [...unknown],
      range: entries.length ? { from, to } : null,
      rowCount: table.rows.length,
    };
  },
};
