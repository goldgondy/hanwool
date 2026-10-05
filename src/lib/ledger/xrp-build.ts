import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import { RIPPLE_EPOCH, type XrplNode, type XrplTx } from "@/lib/xrp/rpc";

// XRP Ledger 거래 → 원장. 거래 종류마다 해석하지 않고, 거래가 바꾼 "내 잔고"를 그대로 읽는다 (솔라나와 같은 방식).
// - XRP: 내 AccountRoot의 Balance 변화 (drops = 0.000001 XRP). 보낸 쪽이면 수수료가 포함되어 있어 따로 뺀다.
// - 발행 토큰(IOU, 예: RLUSD): 내 RippleState(신뢰선)의 Balance 변화. Balance는 LowLimit 계정 기준이라 내가 High 쪽이면 부호를 바꾼다.
// 이렇게 하면 송금·DEX 교환(OfferCreate)·AMM·부분 지급(Partial Payment, 받는 금액이 적힌 것보다 적은 사기 수법)도 실제 받은 만큼만 기록된다.

export const XRP_NATIVE_KEY = "xrp:native";
const DROPS = new Decimal(1_000_000);

// 통화 코드: 3글자 또는 40자리 16진수(긴 이름, 예: 524C555344… = RLUSD)
export function currencyName(code: string): string {
  if (/^[0-9A-F]{40}$/i.test(code)) {
    const bytes = code.match(/../g)!.map((h) => parseInt(h, 16)).filter((b) => b !== 0);
    const text = String.fromCharCode(...bytes);
    return /^[\x20-\x7e]+$/.test(text) ? text.trim().toUpperCase() : code.slice(0, 8);
  }
  return code.toUpperCase();
}

export const xrpTokenKey = (currency: string, issuer: string) => `xrp:${currency}.${issuer}`;

interface Limit {
  issuer: string;
}
interface TrustBalance {
  currency: string;
  value: string;
}

const fieldsOf = (kind: string, n: XrplNode) => ({
  final: (kind === "CreatedNode" ? n.NewFields : kind === "DeletedNode" ? undefined : n.FinalFields) ?? {},
  prev: (kind === "CreatedNode" ? undefined : (n.PreviousFields ?? n.FinalFields)) ?? {},
  any: n.FinalFields ?? n.NewFields ?? {},
});

// 한 거래가 바꾼 내 잔고 (자산 키 → 변화량, 표시 이름)
export function balanceChanges(tx: XrplTx, me: string): Map<string, { asset: string; delta: Decimal }> {
  const out = new Map<string, { asset: string; delta: Decimal }>();
  const add = (key: string, asset: string, d: Decimal) => {
    if (d.isZero()) return;
    const cur = out.get(key);
    out.set(key, { asset, delta: (cur?.delta ?? new Decimal(0)).plus(d) });
  };
  for (const { kind, node } of tx.nodes) {
    const { final, prev, any } = fieldsOf(kind, node);
    if (node.LedgerEntryType === "AccountRoot" && any.Account === me) {
      // 수정된 노드에서 PreviousFields에 Balance가 없으면 잔고는 그대로다
      if (kind === "ModifiedNode" && !(node.PreviousFields && "Balance" in node.PreviousFields)) continue;
      const after = new Decimal(String(final.Balance ?? 0));
      const before = new Decimal(String(kind === "CreatedNode" ? 0 : (prev.Balance ?? 0)));
      add(XRP_NATIVE_KEY, "XRP", after.minus(before).div(DROPS));
    }
    if (node.LedgerEntryType === "RippleState") {
      const low = (any.LowLimit as Limit | undefined)?.issuer;
      const high = (any.HighLimit as Limit | undefined)?.issuer;
      if (low !== me && high !== me) continue;
      if (kind === "ModifiedNode" && !(node.PreviousFields && "Balance" in node.PreviousFields)) continue;
      const sign = low === me ? 1 : -1;
      const issuer = low === me ? high! : low!;
      const currency = ((any.Balance as TrustBalance | undefined)?.currency ?? "") as string;
      const val = (f: Record<string, unknown>) => new Decimal((f.Balance as TrustBalance | undefined)?.value ?? 0);
      const after = kind === "DeletedNode" ? new Decimal(0) : val(final);
      const before = kind === "CreatedNode" ? new Decimal(0) : val(prev);
      add(xrpTokenKey(currency, issuer), currencyName(currency), after.minus(before).mul(sign));
    }
  }
  return out;
}

const TRADE_TYPES = new Set(["OfferCreate", "AMMDeposit", "AMMWithdraw", "AMMCreate", "AMMBid"]);
// 내 자산이 장부상 다른 곳에 묶일 뿐 내 소유인 거래 (잔고 대사에서 차이로 보일 수 있음)
export const LOCKING_TYPES = new Set(["EscrowCreate", "EscrowFinish", "EscrowCancel", "PaymentChannelCreate", "PaymentChannelFund", "PaymentChannelClaim", "CheckCreate", "CheckCash"]);

export function buildXrpEntries({ sourceId, address, txs }: { sourceId: string; address: string; txs: XrplTx[] }): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const tx of txs) {
    const time = (tx.date + RIPPLE_EPOCH) * 1000;
    const groupId = `xrp:${tx.hash}`;
    const base = { sourceId, origin: "chain" as const, location: "XRP Ledger", time, groupId, txHash: tx.hash, rawType: tx.type };
    const changes = balanceChanges(tx, address);
    const iPaid = tx.account === address;
    const fee = iPaid ? new Decimal(tx.fee).div(DROPS) : new Decimal(0);

    // 수수료는 XRP 잔고 변화에 들어 있으므로 떼어 낸다
    if (!fee.isZero()) {
      const x = changes.get(XRP_NATIVE_KEY);
      const rest = (x?.delta ?? new Decimal(0)).plus(fee);
      if (rest.isZero()) changes.delete(XRP_NATIVE_KEY);
      else changes.set(XRP_NATIVE_KEY, { asset: "XRP", delta: rest });
      entries.push({ ...base, id: `${sourceId}:xrp:${tx.hash}:fee`, asset: "XRP", assetKey: XRP_NATIVE_KEY, amount: fee.neg().toString(), kind: "fee" });
    }

    const kind = TRADE_TYPES.has(tx.type) || changes.size > 1 ? "trade" : "transfer";
    const counterparty = tx.type === "Payment" ? (iPaid ? tx.destination : tx.account) : undefined;
    for (const [key, { asset, delta }] of changes) {
      entries.push({ ...base, id: `${sourceId}:xrp:${tx.hash}:${key}`, asset, assetKey: key, amount: delta.toString(), kind, counterparty });
    }
  }
  return entries;
}
