import Decimal from "@/lib/decimal";
import type { EvmChain, LedgerEntry } from "@/lib/db";
import { EVM_CHAINS, evmAssetKey, fromBaseUnits, isFakeStable } from "@/lib/sources/evm";

// Blockscout 응답을 정규화한 입력 형식. 금액은 모두 최소 단위(wei 등)의 정수 문자열이다.

// 주소가 보내거나 받은 일반 트랜잭션 (approve·실패한 트랜잭션 포함)
export interface NativeTx {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  fee: string; // 실제 지불한 수수료 (OP 스택 L2는 L1 수수료 포함)
  success: boolean;
  time: number;
}

// 컨트랙트가 보낸 네이티브 코인 (예: DEX에서 ETH로 스왑해 받은 금액)
export interface InternalTx {
  hash: string;
  index: number;
  from: string;
  to: string | null;
  value: string;
  success: boolean;
  time: number;
}

export interface TokenTransfer {
  hash: string;
  logIndex: number;
  from: string;
  to: string;
  value: string;
  decimals: number | null;
  token: string; // 컨트랙트 주소
  symbol: string | null;
  time: number;
}

export interface BuildInput {
  sourceId: string;
  chain: EvmChain;
  address: string;
  txs: NativeTx[];
  internal: InternalTx[];
  tokens: TokenTransfer[];
  knownTokens?: Iterable<string>; // 이전 동기화에서 이미 받은 적 있는 토큰 (assetKey)
}

export interface BuildResult {
  entries: LedgerEntry[];
  skipped: { id: string; reason: string; spoof?: boolean }[];
}

export function buildEvmEntries(input: BuildInput): BuildResult {
  const { sourceId, chain } = input;
  const me = input.address.toLowerCase();
  const { name: location, native } = EVM_CHAINS[chain];
  const nativeKey = evmAssetKey(chain, null);

  const entries: LedgerEntry[] = [];
  const skipped: BuildResult["skipped"] = [];

  const push = (
    suffix: string,
    hash: string,
    time: number,
    asset: string,
    assetKey: string,
    amount: Decimal,
    kind: LedgerEntry["kind"],
    counterparty?: string | null,
  ) => {
    if (amount.isZero()) return;
    entries.push({
      id: `${sourceId}:${chain}:${hash}:${suffix}`,
      sourceId,
      location,
      time,
      asset,
      assetKey,
      amount: amount.toString(),
      kind,
      groupId: `${chain}:${hash}`,
      txHash: hash,
      counterparty: counterparty ?? undefined,
    });
  };

  for (const t of input.txs) {
    const fromMe = t.from.toLowerCase() === me;
    const toMe = t.to?.toLowerCase() === me;
    const value = fromBaseUnits(t.value, 18);
    // 실패한 트랜잭션은 금액이 이동하지 않지만 수수료는 지불된다.
    if (t.success && fromMe) push("native:out", t.hash, t.time, native, nativeKey, value.neg(), "transfer", t.to);
    if (t.success && toMe) push("native:in", t.hash, t.time, native, nativeKey, value, "transfer", t.from);
    if (fromMe) push("gas", t.hash, t.time, native, nativeKey, fromBaseUnits(t.fee, 18).neg(), "fee");
  }

  for (const t of input.internal) {
    if (!t.success) continue;
    const value = fromBaseUnits(t.value, 18);
    if (t.from.toLowerCase() === me) push(`int:${t.index}:out`, t.hash, t.time, native, nativeKey, value.neg(), "transfer", t.to);
    if (t.to?.toLowerCase() === me) push(`int:${t.index}:in`, t.hash, t.time, native, nativeKey, value, "transfer", t.from);
  }

  // 주소 오염(address poisoning) 사기: 가짜 토큰 컨트랙트가 "내가 보냈다"는 전송 기록을 만들어 낸다.
  // 받은 적 없는 토큰을, 내가 서명하지 않은 트랜잭션에서 보냈다고 나오면 가짜로 보고 뺀다.
  // (진짜 토큰은 받은 적이 있어야 보낼 수 있다. 증분 동기화에서는 이전에 받은 토큰 목록을 knownTokens로 받는다.)
  const sentByMe = new Set(input.txs.filter((t) => t.from.toLowerCase() === me).map((t) => t.hash));
  const received = new Set(input.knownTokens ?? []);
  for (const t of [...input.tokens].sort((a, b) => a.time - b.time || a.logIndex - b.logIndex)) {
    if (t.decimals == null) {
      skipped.push({ id: `${t.hash}:${t.logIndex}`, reason: "토큰 소수점 자릿수를 알 수 없음" });
      continue;
    }
    // 영문·숫자가 아닌 글자로 진짜 토큰 이름을 흉내 낸 사칭 토큰은 원장에서도 뺀다 (잔고 조회와 같은 기준, lib/sources/evm.ts)
    if ((t.symbol && !/^[\x20-\x7E]+$/.test(t.symbol)) || isFakeStable(chain, t.token, t.symbol)) {
      skipped.push({ id: `${t.hash}:${t.logIndex}`, reason: "이름을 흉내 낸 사칭 토큰", spoof: true });
      continue;
    }
    const amount = fromBaseUnits(t.value, t.decimals);
    const symbol = (t.symbol ?? "UNKNOWN").toUpperCase();
    const key = evmAssetKey(chain, t.token);
    if (t.to.toLowerCase() === me && !amount.isZero()) received.add(key);
    if (t.from.toLowerCase() === me) {
      if (!received.has(key) && !sentByMe.has(t.hash)) {
        skipped.push({ id: `${t.hash}:${t.logIndex}`, reason: "받은 적 없는 토큰의 가짜 전송 기록 (주소 오염 사기)", spoof: true });
        continue;
      }
      push(`log:${t.logIndex}:out`, t.hash, t.time, symbol, key, amount.neg(), "transfer", t.to);
    }
    if (t.to.toLowerCase() === me) push(`log:${t.logIndex}:in`, t.hash, t.time, symbol, key, amount, "transfer", t.from);
  }

  classifyGroups(entries);
  return { entries, skipped };
}

// 같은 트랜잭션 안에서 서로 다른 자산이 들어오고 나가면 스왑(trade)으로 본다.
// 자기 자신에게 보낸 경우(같은 자산이 들어오고 나감)는 이체로 남긴다.
function classifyGroups(entries: LedgerEntry[]) {
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    if (e.kind === "fee") continue;
    groups.set(e.groupId, [...(groups.get(e.groupId) ?? []), e]);
  }
  for (const legs of groups.values()) {
    const inKeys = new Set(legs.filter((e) => !e.amount.startsWith("-")).map((e) => e.assetKey));
    const outKeys = new Set(legs.filter((e) => e.amount.startsWith("-")).map((e) => e.assetKey));
    const isSwap =
      inKeys.size > 0 && outKeys.size > 0 && new Set([...inKeys, ...outKeys]).size > 1;
    if (isSwap) legs.forEach((e) => (e.kind = "trade"));
  }
}
