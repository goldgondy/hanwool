import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import { koreaAssetKey } from "@/lib/sources/korea";

// 업비트·빗썸 내역 → 원장. 두 거래소의 API 형식이 거의 같다 (빗썸이 업비트 형식을 따름). ⚠ 실제 키로 검증 전.
// - 주문: 체결된 수량(executed_volume)과 체결 금액(빗썸 executed_funds, 업비트는 개별 주문 조회의 trades[].funds 합)
//   수수료(paid_fee)는 결제 통화(원화 마켓이면 원화)로 낸다.
// - 원화 입출금은 법정화폐 이체(과세 대상 아님), 코인 입출금은 블록체인 거래 해시로 내 지갑과 짝지어진다.

export interface KoreaOrder {
  uuid: string;
  side: "bid" | "ask";
  market: string; // "KRW-BTC" = 결제 통화-코인
  created_at: string;
  executed_volume: string;
  executed_funds?: string; // 빗썸. 업비트는 trades[]로 계산해 채운다
  paid_fee: string;
  state: string;
}

export interface KoreaTransfer {
  uuid: string;
  currency: string;
  txid?: string | null;
  state: string;
  created_at: string;
  done_at?: string | null;
  amount: string;
  fee?: string;
  transaction_type?: string; // default | internal
}

type Ex = "upbit" | "bithumb";
const NAME: Record<Ex, string> = { upbit: "업비트", bithumb: "빗썸" };

export function buildKoreaOrders(exchange: Ex, sourceId: string, orders: KoreaOrder[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const o of orders) {
    const volume = new Decimal(o.executed_volume || 0);
    if (volume.isZero() || o.executed_funds == null) continue; // 체결 없음 (취소된 주문 등)
    const [quote, base] = o.market.toUpperCase().split("-");
    const funds = new Decimal(o.executed_funds);
    const bid = o.side === "bid";
    const id = `${sourceId}:${exchange}:o:${o.uuid}`;
    const common = { sourceId, origin: "exchange" as const, location: NAME[exchange], time: Date.parse(o.created_at), groupId: `${exchange}:o:${o.uuid}`, rawType: `${bid ? "매수" : "매도"} ${o.market}` };
    out.push(
      { ...common, id: `${id}:base`, asset: base, assetKey: koreaAssetKey(base), amount: (bid ? volume : volume.neg()).toString(), kind: "trade" },
      { ...common, id: `${id}:quote`, asset: quote, assetKey: koreaAssetKey(quote), amount: (bid ? funds.neg() : funds).toString(), kind: "trade" },
    );
    const fee = new Decimal(o.paid_fee || 0);
    if (!fee.isZero()) out.push({ ...common, id: `${id}:fee`, asset: quote, assetKey: koreaAssetKey(quote), amount: fee.abs().neg().toString(), kind: "fee" });
  }
  return out;
}

// 완료 상태: 업비트 입금 ACCEPTED·출금 DONE, 빗썸 입금 DEPOSIT_ACCEPTED·출금 DONE (원화 입출금도 같은 이름 계열)
const DONE = /^(ACCEPTED|DEPOSIT_ACCEPTED|DONE)$/i;
// 블록체인 거래 해시만 남긴다 (거래소 내부 이체·원화는 해시가 없거나 내부 번호)
const chainHash = (t: KoreaTransfer) => (t.txid && t.transaction_type !== "internal" && !/\s/.test(t.txid) && t.currency.toUpperCase() !== "KRW" ? t.txid : undefined);

export function buildKoreaTransfers(exchange: Ex, sourceId: string, deposits: KoreaTransfer[], withdrawals: KoreaTransfer[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  const base = { sourceId, origin: "exchange" as const, location: NAME[exchange] };
  for (const d of deposits) {
    if (!DONE.test(d.state)) continue;
    const coin = d.currency.toUpperCase();
    out.push({
      ...base,
      id: `${sourceId}:${exchange}:dep:${d.uuid}`,
      time: Date.parse(d.done_at || d.created_at),
      asset: coin,
      assetKey: koreaAssetKey(coin),
      amount: new Decimal(d.amount).toString(),
      kind: "transfer",
      groupId: `${exchange}:dep:${d.uuid}`,
      txHash: chainHash(d),
      rawType: coin === "KRW" ? "원화 입금" : "입금",
    });
    // 입금 수수료(원화 입금 등)가 있으면 따로
    const fee = new Decimal(d.fee || 0);
    if (!fee.isZero()) out.push({ ...base, id: `${sourceId}:${exchange}:dep:${d.uuid}:fee`, time: Date.parse(d.done_at || d.created_at), asset: coin, assetKey: koreaAssetKey(coin), amount: fee.abs().neg().toString(), kind: "fee", groupId: `${exchange}:dep:${d.uuid}`, rawType: "입금 수수료" });
  }
  for (const w of withdrawals) {
    if (!DONE.test(w.state)) continue;
    const coin = w.currency.toUpperCase();
    const common = { ...base, time: Date.parse(w.done_at || w.created_at), asset: coin, assetKey: koreaAssetKey(coin), groupId: `${exchange}:wd:${w.uuid}`, txHash: chainHash(w) };
    out.push({ ...common, id: `${sourceId}:${exchange}:wd:${w.uuid}`, amount: new Decimal(w.amount).neg().toString(), kind: "transfer", rawType: coin === "KRW" ? "원화 출금" : "출금" });
    const fee = new Decimal(w.fee || 0);
    if (!fee.isZero()) out.push({ ...common, id: `${sourceId}:${exchange}:wd:${w.uuid}:fee`, amount: fee.abs().neg().toString(), kind: "fee", rawType: "출금 수수료" });
  }
  return out;
}

// 업비트 개별 주문의 체결 목록에서 체결 금액 합계
export const sumFunds = (trades: { funds: string }[]) => trades.reduce((s, t) => s.plus(t.funds || 0), new Decimal(0)).toString();
