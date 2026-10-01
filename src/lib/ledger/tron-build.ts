import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import { toBase58 } from "@/lib/tron/address";
import type { Trc20Transfer, TronTx } from "@/lib/tron/trongrid";

// 트론 내역 → 원장. TronGrid 응답 형식 확인: 2026-10-01
// - TRX: 1 TRX = 1,000,000 sun
// - 내가 보낸 거래는 실패해도 수수료(ret.fee, 소각된 TRX)를 낸다
// - 동결·해제·자원 위임·투표는 잔고 총액이 바뀌지 않는다 (대사 때 동결분을 잔고에 포함)
// - 0원 TRC20 전송은 주소 오염(address poisoning) 사기에 쓰이므로 건너뛴다

export const TRON_NATIVE_KEY = "tron:native";
export const tronTokenKey = (contract: string) => `tron:${contract}`; // Base58은 대소문자를 구분하므로 그대로 둔다

const sun = (n: number | string) => new Decimal(String(n)).div(1_000_000);

// 잔고 총액에 영향이 없는 계약 유형 (수수료만 기록)
const NEUTRAL = new Set([
  "FreezeBalanceV2Contract",
  "UnfreezeBalanceV2Contract",
  "WithdrawExpireUnfreezeContract",
  "CancelAllUnfreezeV2Contract",
  "DelegateResourceContract",
  "UnDelegateResourceContract",
  "VoteWitnessContract",
  "AccountPermissionUpdateContract",
  "AccountUpdateContract",
]);

export interface TronBuildInput {
  sourceId: string;
  address: string; // Base58
  txs: TronTx[];
  trc20: Trc20Transfer[];
  rewardAmounts?: Record<string, number>; // 투표 보상 수령 거래의 수령액 (sun), txID → 금액
}

export interface TronBuildResult {
  entries: LedgerEntry[];
  unknownTypes: string[];
  skipped: number; // 0원·소수점 미상 TRC20 전송
}

export function buildTronEntries({ sourceId, address, txs, trc20, rewardAmounts = {} }: TronBuildInput): TronBuildResult {
  const me = address;
  const entries: LedgerEntry[] = [];
  const unknown = new Set<string>();
  let skipped = 0;

  const push = (txid: string, suffix: string, time: number, asset: string, assetKey: string, amount: Decimal, kind: LedgerEntry["kind"], counterparty?: string, tag?: LedgerEntry["tag"]) => {
    if (amount.isZero()) return;
    entries.push({
      id: `${sourceId}:tron:${txid}:${suffix}`,
      sourceId,
      location: "Tron",
      time,
      asset,
      assetKey,
      amount: amount.toString(),
      kind,
      groupId: `tron:${txid}`,
      txHash: txid,
      counterparty,
      tag,
    });
  };

  for (const tx of txs) {
    const c = tx.raw_data?.contract?.[0];
    if (!c) continue;
    const v = c.parameter.value;
    const owner = typeof v.owner_address === "string" ? toBase58(v.owner_address) : "";
    const success = tx.ret?.[0]?.contractRet === "SUCCESS";
    const time = tx.block_timestamp;
    const fromMe = owner === me;

    if (fromMe) push(tx.txID, "fee", time, "TRX", TRON_NATIVE_KEY, sun(tx.ret?.[0]?.fee ?? 0).neg(), "fee");
    if (!success) continue;

    switch (c.type) {
      case "TransferContract": {
        const to = toBase58(String(v.to_address));
        const amount = sun(Number(v.amount ?? 0));
        if (fromMe) push(tx.txID, "trx:out", time, "TRX", TRON_NATIVE_KEY, amount.neg(), "transfer", to);
        if (to === me) push(tx.txID, "trx:in", time, "TRX", TRON_NATIVE_KEY, amount, "transfer", owner);
        break;
      }
      case "TriggerSmartContract": {
        // 토큰 이동은 TRC20 목록에서 처리한다. 함께 보낸 TRX만 여기서 기록.
        const callValue = sun(Number(v.call_value ?? 0));
        if (fromMe) push(tx.txID, "trx:call", time, "TRX", TRON_NATIVE_KEY, callValue.neg(), "transfer", toBase58(String(v.contract_address)));
        break;
      }
      case "TransferAssetContract": {
        // TRC10 토큰
        const id = String(v.asset_name ?? "");
        const to = toBase58(String(v.to_address));
        const amount = new Decimal(Number(v.amount ?? 0));
        const asset = `TRC10-${id}`;
        if (fromMe) push(tx.txID, "trc10:out", time, asset, `tron:trc10:${id}`, amount.neg(), "transfer", to);
        if (to === me) push(tx.txID, "trc10:in", time, asset, `tron:trc10:${id}`, amount, "transfer", owner);
        break;
      }
      case "WithdrawBalanceContract": {
        // 투표(SR) 보상 수령. 수령액은 거래 정보에서 따로 받아 온다.
        if (fromMe) push(tx.txID, "reward", time, "TRX", TRON_NATIVE_KEY, sun(rewardAmounts[tx.txID] ?? 0), "income", undefined, "reward");
        break;
      }
      default:
        if (!NEUTRAL.has(c.type)) unknown.add(c.type);
    }

    // 컨트랙트가 보낸 TRX (예: TRX로 받는 스왑)
    tx.internal_transactions?.forEach((it, i) => {
      const amount = Number(it.data?.call_value?._ ?? 0);
      if (!amount || it.data?.rejected || !it.to_address) return;
      if (toBase58(it.to_address) === me) push(tx.txID, `int:${i}:in`, time, "TRX", TRON_NATIVE_KEY, sun(amount), "transfer", it.from_address ? toBase58(it.from_address) : undefined);
    });
  }

  // TRC20: 같은 거래 안의 여러 전송을 순번으로 구분한다
  const seq = new Map<string, number>();
  for (const t of trc20) {
    if (t.type !== "Transfer") continue;
    const n = seq.get(t.transaction_id) ?? 0;
    seq.set(t.transaction_id, n + 1);
    const decimals = t.token_info.decimals;
    if (!t.value || t.value === "0" || decimals == null) {
      skipped++;
      continue;
    }
    const amount = new Decimal(t.value).div(new Decimal(10).pow(decimals));
    const symbol = (t.token_info.symbol ?? "UNKNOWN").toUpperCase();
    const key = tronTokenKey(t.token_info.address);
    if (t.from === me) push(t.transaction_id, `trc20:${n}:out`, t.block_timestamp, symbol, key, amount.neg(), "transfer", t.to);
    if (t.to === me) push(t.transaction_id, `trc20:${n}:in`, t.block_timestamp, symbol, key, amount, "transfer", t.from);
  }

  // 한 거래에서 서로 다른 자산이 오가면 스왑으로 표시 (EVM과 같은 기준)
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries) if (e.kind !== "fee") groups.set(e.groupId, [...(groups.get(e.groupId) ?? []), e]);
  for (const legs of groups.values()) {
    const ins = new Set(legs.filter((e) => !e.amount.startsWith("-")).map((e) => e.assetKey));
    const outs = new Set(legs.filter((e) => e.amount.startsWith("-")).map((e) => e.assetKey));
    if (ins.size && outs.size && new Set([...ins, ...outs]).size > 1) legs.forEach((e) => (e.kind = e.kind === "transfer" ? "trade" : e.kind));
  }

  return { entries, unknownTypes: [...unknown], skipped };
}
