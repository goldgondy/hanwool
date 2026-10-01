import Decimal from "@/lib/decimal";
import type { LedgerEntry, LedgerKind } from "@/lib/db";

// 비트겟 현물 계정 내역(/api/v2/spot/account/bills) → 원장. ⚠ 실제 키로 검증 전.
// 공식 문서 페이지를 직접 확인하지 못해 필드는 공식 SDK 구조체 기준 (2026-10-01):
// cTime, coin, groupType, businessType, size, balance, fees, billId, bizOrderId
// size에 수수료가 포함되는지 문서로 확인하지 못했으므로, 각 행의 잔고(balance) 변화와 맞는 해석을 데이터에서 고른다.
// 입출금 기록(deposit-records, withdrawal-records)에서 블록체인 거래 해시(tradeId)를 붙인다.

export interface BitgetBill {
  billId: string;
  cTime: string;
  coin: string;
  groupType: string; // deposit, withdraw, transaction, transfer, other
  businessType: string;
  size: string;
  balance?: string;
  fees?: string;
  bizOrderId?: string;
}

export interface BitgetTransfer {
  orderId: string;
  tradeId?: string; // 블록체인 거래 해시
  coin: string;
  size: string;
  status: string;
  cTime: string;
}

type Convention = "net" | "plusFee" | "minusAbsFee";

const changeOf = (b: BitgetBill, c: Convention) => {
  const size = new Decimal(b.size || 0);
  const fee = new Decimal(b.fees || 0);
  return c === "net" ? size : c === "plusFee" ? size.plus(fee) : size.minus(fee.abs());
};

// 같은 코인의 연속된 두 행: 잔고 차이 = 뒤 행의 잔고 변동. 가장 많이 맞는 해석을 고른다.
export function inferConvention(bills: BitgetBill[]): Convention {
  const score: Record<Convention, number> = { net: 0, plusFee: 0, minusAbsFee: 0 };
  const byCoin = new Map<string, BitgetBill[]>();
  for (const b of bills) if (b.balance != null) byCoin.set(b.coin, [...(byCoin.get(b.coin) ?? []), b]);
  for (const rows of byCoin.values()) {
    const sorted = [...rows].sort((a, b) => Number(a.cTime) - Number(b.cTime) || a.billId.localeCompare(b.billId, undefined, { numeric: true }));
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i];
      if (new Decimal(cur.fees || 0).isZero()) continue; // 수수료 없는 행은 구별이 안 된다
      const diff = new Decimal(cur.balance!).minus(sorted[i - 1].balance!);
      for (const c of Object.keys(score) as Convention[]) if (diff.eq(changeOf(cur, c))) score[c]++;
    }
  }
  const best = (Object.keys(score) as Convention[]).sort((a, b) => score[b] - score[a])[0];
  return score[best] > 0 ? best : "plusFee";
}

const REWARD = /REBATE|REWARD|BONUS|INTEREST|EARN|STAKING|DIVIDEND|COMMISSION/i;
const AIRDROP = /AIRDROP|CANDY|LAUNCHPOOL|GIFT/i;

export function buildBitgetEntries(input: { sourceId: string; bills: BitgetBill[]; deposits: BitgetTransfer[]; withdrawals: BitgetTransfer[] }) {
  const { sourceId, bills } = input;
  const convention = inferConvention(bills);
  const txHash = new Map<string, string>();
  for (const t of [...input.deposits, ...input.withdrawals]) if (t.tradeId) txHash.set(t.orderId, t.tradeId);

  const entries: LedgerEntry[] = [];
  const unknown = new Set<string>();
  const base = { sourceId, origin: "exchange" as const, location: "Bitget 현물" };

  for (const b of bills) {
    const coin = b.coin.toUpperCase();
    const total = changeOf(b, convention);
    const fee = new Decimal(b.fees || 0).abs().neg();
    const time = Number(b.cTime);
    let kind: LedgerKind = "other";
    let tag: LedgerEntry["tag"];
    let groupId = `bitget:bill:${b.billId}`;
    switch (b.groupType) {
      case "transaction":
        kind = "trade";
        groupId = `bitget:ord:${b.bizOrderId || b.billId}`;
        break;
      case "deposit":
      case "withdraw":
        kind = "transfer";
        break;
      case "transfer":
        kind = "other"; // 현물 ↔ 선물·마진 계정 이동 (잔고 대조는 현물만)
        break;
      default:
        if (AIRDROP.test(b.businessType)) [kind, tag] = ["income", "airdrop"];
        else if (REWARD.test(b.businessType)) [kind, tag] = ["income", "reward"];
        else unknown.add(`${b.groupType}/${b.businessType}`);
    }
    const common = { ...base, time, asset: coin, assetKey: coin, groupId, txHash: (b.bizOrderId && txHash.get(b.bizOrderId)) || undefined };
    const rawType = `${b.groupType}/${b.businessType}`;
    // 수수료는 따로 기록한다 (합계 = 잔고 변동)
    const split = !fee.isZero() && (kind === "trade" || kind === "transfer");
    const main = split ? total.minus(fee) : total;
    if (!main.isZero()) entries.push({ ...common, id: `${sourceId}:bitget:${b.billId}`, amount: main.toString(), kind, tag, rawType });
    if (split) entries.push({ ...common, id: `${sourceId}:bitget:${b.billId}:fee`, amount: fee.toString(), kind: "fee", rawType: `${rawType} fee` });
  }
  return { entries, unknownTypes: [...unknown], convention };
}
