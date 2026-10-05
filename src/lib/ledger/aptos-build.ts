import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import type { AptosActivity } from "@/lib/aptos/api";

// Aptos 인덱서의 자산 입출금 기록 → 원장. 기록 하나가 곧 내 잔고 변화다 (입금 +, 출금 −, 가스비 −).
// - APT는 예전 코인 형식("0x1::aptos_coin::AptosCoin")과 새 자산 형식("0xa")이 섞여 나오므로 하나로 합친다.
// - 공식 USDT("USDt")·USDC는 거래소 기록과 짝짓고 시세를 찾을 수 있게 이름을 맞춘다.
// - 실패한 거래는 가스비만 반영된다.

export const APT_NATIVE_KEY = "aptos:native";
const APT_TYPES = new Set(["0x1::aptos_coin::AptosCoin", "0xa", "0x000000000000000000000000000000000000000000000000000000000000000a"]);
export const APTOS_USDT = "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b";
export const APTOS_USDC = "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b";
const CANONICAL: Record<string, string> = { [APTOS_USDT]: "USDT", [APTOS_USDC]: "USDC" };

export function aptosAsset(assetType: string, symbol: string | null | undefined): { key: string; symbol: string } {
  if (APT_TYPES.has(assetType)) return { key: APT_NATIVE_KEY, symbol: "APT" };
  const t = assetType.toLowerCase();
  return { key: `aptos:${t}`, symbol: CANONICAL[t] ?? (symbol ?? t.split("::").pop() ?? "UNKNOWN").toUpperCase() };
}

export const isDeposit = (type: string) => /::Deposit(Event)?$/.test(type);
export const isWithdraw = (type: string) => /::Withdraw(Event)?$/.test(type);

export function buildAptosEntries({ sourceId, activities, hashes }: { sourceId: string; activities: AptosActivity[]; hashes: Map<number, string> }): LedgerEntry[] {
  // 거래(버전)마다 모아 자산 종류가 둘 이상 움직였으면 교환으로 본다
  const byVersion = new Map<number, AptosActivity[]>();
  for (const a of activities) byVersion.set(a.transaction_version, [...(byVersion.get(a.transaction_version) ?? []), a]);

  const entries: LedgerEntry[] = [];
  for (const [version, list] of byVersion) {
    const moves = list.filter((a) => !a.is_gas_fee && a.is_transaction_success && (isDeposit(a.type) || isWithdraw(a.type)));
    const kinds = new Set(moves.map((a) => aptosAsset(a.asset_type, a.metadata?.symbol).key));
    const kind = kinds.size > 1 ? "trade" : "transfer";
    const time = Date.parse(`${list[0].transaction_timestamp}Z`);
    const base = { sourceId, origin: "chain" as const, location: "Aptos", time, groupId: `aptos:${version}`, txHash: hashes.get(version), rawType: list[0].entry_function_id_str ?? undefined };
    for (const a of list) {
      const { key, symbol } = aptosAsset(a.asset_type, a.metadata?.symbol);
      const decimals = a.metadata?.decimals ?? (key === APT_NATIVE_KEY ? 8 : null);
      if (decimals == null || a.amount == null) continue;
      const amount = new Decimal(String(a.amount)).div(new Decimal(10).pow(decimals));
      if (amount.isZero()) continue;
      const id = `${sourceId}:aptos:${version}:${a.event_index}:${a.is_gas_fee ? "gas" : "mv"}`;
      if (a.is_gas_fee) {
        entries.push({ ...base, id, asset: "APT", assetKey: APT_NATIVE_KEY, amount: amount.neg().toString(), kind: "fee" });
      } else if (a.is_transaction_success && (isDeposit(a.type) || isWithdraw(a.type))) {
        entries.push({ ...base, id, asset: symbol, assetKey: key, amount: (isDeposit(a.type) ? amount : amount.neg()).toString(), kind });
      }
    }
  }
  return entries;
}
