import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import { tonHashHex } from "@/lib/ton/address";
import type { TonJettonTransfer, TonMeta, TonTx } from "@/lib/ton/api";

// TON 지갑 거래 → 원장.
// - TON: 거래마다 계정 잔고(전·후)의 차이를 읽는다. 처리 수수료(total_fees)는 이 계정 잔고에서 빠지므로 따로 적고 나머지를 송금으로 본다.
// - 제톤(USDT 등 토큰): 제톤 전송 기록에서 내가 보낸 사람(source) 또는 받는 사람(destination)인 것.
// - 같은 처리 흐름(trace)에 속한 기록은 한 거래로 묶는다. 내가 제톤을 보낸 흐름에서 오간 TON(전송 가스, 남은 가스 환불)은 순액을 수수료로 본다
//   (그렇지 않으면 "USDT와 TON이 나가고 TON이 들어옴"이 교환으로 잘못 분류된다).
// - 0.001 TON 미만이 들어온 거래는 광고 메모를 붙인 먼지 송금이 대부분이라 rawType "Dust"로 표시한다 (분류에서 스팸 추정).

const NANO = new Decimal(1_000_000_000);
export const TON_NATIVE_KEY = "ton:native";
const DUST = new Decimal("0.001");

export const tonJettonKey = (master: string) => `ton:${master.split(":")[1]?.toLowerCase() ?? master.toLowerCase()}`;

// 공식 USDT는 이름이 "USD₮"라 거래소 기록(USDT)과 짝짓고 시세를 찾을 수 있게 USDT로 맞춘다
const CANONICAL: Record<string, string> = { "ton:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe": "USDT" };

export function jettonInfo(meta: Record<string, TonMeta>, master: string): { symbol: string; decimals: number | null } {
  const info = meta[master]?.token_info?.find((t) => t.type === "jetton_masters") ?? meta[master]?.token_info?.[0];
  const dec = info?.extra?.decimals;
  return { symbol: CANONICAL[tonJettonKey(master)] ?? (info?.symbol ?? master.slice(2, 8)).toUpperCase(), decimals: dec === undefined || dec === null || dec === "" ? 9 : Number(dec) };
}

export function buildTonEntries({ sourceId, address, txs, jettons, meta }: { sourceId: string; address: string; txs: TonTx[]; jettons: TonJettonTransfer[]; meta: Record<string, TonMeta> }): LedgerEntry[] {
  const me = address.toUpperCase();
  const entries: LedgerEntry[] = [];
  const base = (time: number, trace: string, hash: string) => ({ sourceId, origin: "chain" as const, location: "TON", time, groupId: `ton:${trace}`, txHash: tonHashHex(hash) });

  // 1) 제톤 전송
  const sentJettonTraces = new Set<string>();
  for (const j of jettons) {
    if (j.transaction_aborted) continue;
    const out = j.source?.toUpperCase() === me;
    const inn = j.destination?.toUpperCase() === me;
    if (!out && !inn) continue;
    const { symbol, decimals } = jettonInfo(meta, j.jetton_master);
    const amount = new Decimal(j.amount).div(new Decimal(10).pow(decimals ?? 9));
    if (amount.isZero()) continue;
    const trace = j.trace_id ?? j.transaction_hash;
    if (out) sentJettonTraces.add(trace);
    const b = base(j.transaction_now * 1000, trace, j.transaction_hash);
    const key = tonJettonKey(j.jetton_master);
    if (out) entries.push({ ...b, id: `${sourceId}:ton:j:${j.transaction_hash}:out`, asset: symbol, assetKey: key, amount: amount.neg().toString(), kind: "transfer", counterparty: j.destination ?? undefined, rawType: "Jetton transfer" });
    if (inn) entries.push({ ...b, id: `${sourceId}:ton:j:${j.transaction_hash}:in`, asset: symbol, assetKey: key, amount: amount.toString(), kind: "transfer", counterparty: j.source ?? undefined, rawType: "Jetton transfer" });
  }

  // 2) TON 잔고 변화
  const gasByTrace = new Map<string, { delta: Decimal; time: number; hash: string }>();
  for (const t of txs) {
    // 아직 만들어지지 않은 계정(첫 입금 전)의 잔고는 null로 온다 → 0
    const before = new Decimal(t.account_state_before?.balance ?? 0);
    const after = new Decimal(t.account_state_after?.balance ?? 0);
    const delta = after.minus(before).div(NANO);
    if (delta.isZero()) continue;
    if (sentJettonTraces.has(t.trace_id)) {
      const g = gasByTrace.get(t.trace_id) ?? { delta: new Decimal(0), time: t.now * 1000, hash: t.hash };
      g.delta = g.delta.plus(delta);
      gasByTrace.set(t.trace_id, g);
      continue;
    }
    const fee = new Decimal(t.total_fees || 0).div(NANO);
    const moved = delta.plus(fee);
    const b = base(t.now * 1000, t.trace_id, t.hash);
    const counterparty = moved.isNegative() ? (t.out_msgs.find((m) => m.destination)?.destination ?? undefined) : (t.in_msg?.source ?? undefined);
    if (moved.isPositive() && moved.lt(DUST)) {
      // 먼지 송금: 수수료와 합쳐 한 줄로 (잔고 변화와 같게)
      entries.push({ ...b, id: `${sourceId}:ton:${t.hash}`, asset: "TON", assetKey: TON_NATIVE_KEY, amount: delta.toString(), kind: "transfer", counterparty, rawType: "Dust" });
      continue;
    }
    if (!fee.isZero()) entries.push({ ...b, id: `${sourceId}:ton:${t.hash}:fee`, asset: "TON", assetKey: TON_NATIVE_KEY, amount: fee.neg().toString(), kind: "fee" });
    if (!moved.isZero()) entries.push({ ...b, id: `${sourceId}:ton:${t.hash}`, asset: "TON", assetKey: TON_NATIVE_KEY, amount: moved.toString(), kind: "transfer", counterparty, rawType: "TON transfer" });
  }
  // 제톤을 보낸 흐름의 TON 순변화 = 전송 수수료
  for (const [trace, g] of gasByTrace) {
    if (g.delta.isZero()) continue;
    entries.push({ ...base(g.time, trace, g.hash), id: `${sourceId}:ton:gas:${trace}`, asset: "TON", assetKey: TON_NATIVE_KEY, amount: g.delta.toString(), kind: "fee", rawType: "Jetton transfer gas" });
  }
  return entries;
}
