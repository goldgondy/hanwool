import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import type { EsploraTx } from "@/lib/btc/esplora";
import { coinOf, type UtxoCoin } from "@/lib/btc/coins";

export const BTC_ASSET_KEY = "btc:native";

export interface BtcBuildInput {
  sourceId: string;
  addresses: Set<string>; // 지갑의 모든 (사용된) 주소
  txs: EsploraTx[];
  coin?: UtxoCoin; // 기본 비트코인 (라이트코인도 같은 방식)
}

export interface BtcBuildResult {
  entries: LedgerEntry[];
  warnings: string[];
}

const sats = (n: number | bigint) => new Decimal(n.toString()).div(1e8);

// 지갑 전체를 하나의 계정으로 보고 트랜잭션별 순변동을 기록한다.
// 거스름돈처럼 내 주소끼리 오간 금액은 자연히 상쇄된다. 미확정 트랜잭션은 제외한다.
export function buildBtcEntries({ sourceId, addresses, txs, coin }: BtcBuildInput): BtcBuildResult {
  const c = coinOf(coin);
  const prefix = coin ?? "btc";
  const entries: LedgerEntry[] = [];
  const warnings: string[] = [];
  const mine = (a?: string) => !!a && addresses.has(a);

  for (const tx of txs) {
    if (!tx.status.confirmed) continue;
    const time = (tx.status.block_time ?? 0) * 1000;

    let ourIn = BigInt(0);
    let allInputsOurs = true;
    for (const v of tx.vin) {
      if (v.prevout && mine(v.prevout.scriptpubkey_address)) ourIn += BigInt(v.prevout.value);
      else allInputsOurs = false;
    }
    let ourOut = BigInt(0);
    for (const o of tx.vout) if (mine(o.scriptpubkey_address)) ourOut += BigInt(o.value);

    const base = {
      sourceId,
      location: c.location,
      time,
      asset: c.symbol,
      assetKey: c.assetKey,
      groupId: `${prefix}:${tx.txid}`,
      txHash: tx.txid,
    };
    const push = (suffix: string, amountSats: bigint, kind: LedgerEntry["kind"], counterparty?: string) => {
      if (amountSats === BigInt(0)) return;
      entries.push({ ...base, id: `${sourceId}:${prefix}:${tx.txid}:${suffix}`, amount: sats(amountSats).toString(), kind, counterparty });
    };

    if (ourIn === BigInt(0)) {
      // 받기: 보낸 쪽 주소를 상대방으로 기록 (첫 입력)
      push("in", ourOut, "transfer", tx.vin.find((v) => v.prevout?.scriptpubkey_address)?.prevout?.scriptpubkey_address);
      continue;
    }

    if (!allInputsOurs) {
      // CoinJoin·PayJoin 등 다른 사람과 입력을 합친 트랜잭션: 수수료 분담을 알 수 없어 순변동만 기록한다.
      push("net", ourOut - ourIn, "other");
      warnings.push(`${tx.txid.slice(0, 12)}…: 다른 지갑과 입력을 합친 트랜잭션입니다. 순변동만 기록했습니다.`);
      continue;
    }

    // 보내기: 내 입력 전체 - 내게 돌아온 금액(거스름돈) - 수수료 = 외부로 나간 금액
    const fee = BigInt(tx.fee);
    const external = ourIn - ourOut - fee;
    const firstExternal = tx.vout.find((o) => o.scriptpubkey_address && !mine(o.scriptpubkey_address));
    push("out", -external, "transfer", firstExternal?.scriptpubkey_address);
    push("fee", -fee, "fee");
  }

  return { entries, warnings };
}
