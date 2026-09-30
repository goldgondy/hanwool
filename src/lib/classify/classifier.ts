import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import type { Classification, Decision } from "./types";

// 원장 + 사용자 결정 → 그룹별 분류. 규칙 번호는 docs/classification.md §5와 같다.
// 브릿지(R8), 해시 없는 매칭(R11)은 해당 데이터가 생기면 추가한다.

const isFiatKey = (assetKey: string) => assetKey.startsWith("fiat:");

// 네이티브 코인 래핑 컨트랙트 (소문자). assetKey 형식: `${chain}:${contract}`
export const WRAPPED_NATIVE = new Set([
  "eth:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "arb:0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
  "base:0x4200000000000000000000000000000000000006", // WETH
  "opt:0x4200000000000000000000000000000000000006", // WETH
  "polygon:0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // WPOL
]);

export interface ClassifyInput {
  entries: LedgerEntry[];
  ownAddresses: Set<string>; // 사용자의 모든 계정 주소 (소문자, BTC는 원문)
  decisions: Map<string, Decision>;
}

export interface GroupView {
  key: string;
  time: number;
  entries: LedgerEntry[];
  classification: Classification;
}

const norm = (a?: string) => (a?.startsWith("0x") ? a.toLowerCase() : a);

export function classifyGroup(key: string, entries: LedgerEntry[], ownAddresses: Set<string>): Classification {
  const legs = entries.filter((e) => e.kind !== "fee");
  const base = { key };

  // R6: 수수료만
  if (legs.length === 0) {
    return { ...base, category: "fee_only", status: "confirmed", rule: "R6", reason: "수수료만 지불한 거래 (approve, 실패, UTXO 통합 등)" };
  }

  // R1–R3: 거래소가 남긴 체결·보상 기록은 추정이 아니므로 확정한다.
  if (entries.every((e) => e.origin === "exchange")) {
    if (legs.some((e) => e.tag === "airdrop")) {
      return { ...base, category: "airdrop", status: "confirmed", rule: "R3", reason: "거래소 에어드랍 기록" };
    }
    if (legs.some((e) => e.tag === "reward")) {
      return { ...base, category: "reward", status: "confirmed", rule: "R3", reason: "거래소 보상·이자 기록" };
    }
    if (legs.some((e) => e.kind === "trade")) {
      const fiatOut = legs.some((e) => isFiatKey(e.assetKey) && e.amount.startsWith("-"));
      const fiatIn = legs.some((e) => isFiatKey(e.assetKey) && !e.amount.startsWith("-"));
      if (fiatOut && !fiatIn) return { ...base, category: "buy_fiat", status: "confirmed", rule: "R2", reason: "거래소 법정화폐 매수 체결" };
      if (fiatIn && !fiatOut) return { ...base, category: "sell_fiat", status: "confirmed", rule: "R2", reason: "거래소 법정화폐 매도 체결" };
      return { ...base, category: "trade", status: "confirmed", rule: "R1", reason: "거래소 체결 기록" };
    }
  }

  // 법정화폐만 오가는 입출금 (예: 업비트 원화 입금) → 과세 대상 아님
  if (legs.every((e) => isFiatKey(e.assetKey))) {
    return { ...base, category: "fiat_transfer", status: "confirmed", rule: "R0", reason: "원화·법정화폐 입출금" };
  }

  // 자산 비교 기준: 거래소 기록은 자산을 심볼("BTC")로, 지갑은 체인·컨트랙트("btc:native")로 적는다.
  // 둘이 섞인 거래(거래소 ↔ 내 지갑 이체)는 심볼로 비교하고, 지갑끼리는 컨트랙트까지 구분한다(가짜 토큰 방지).
  const mixed = entries.some((e) => e.origin === "exchange") && entries.some((e) => e.origin !== "exchange");
  const assetOf = (e: LedgerEntry) => (mixed ? e.asset.toUpperCase() : e.assetKey);

  // R4: 수수료 외 항목이 자산별로 합계 0 → 내 계정 사이에서만 움직임
  const byAsset = new Map<string, Decimal>();
  for (const e of legs) byAsset.set(assetOf(e), (byAsset.get(assetOf(e)) ?? new Decimal(0)).plus(e.amount));
  if ([...byAsset.values()].every((v) => v.isZero())) {
    const sources = new Set(legs.map((e) => e.sourceId)).size;
    return {
      ...base,
      category: "internal_transfer",
      status: "confirmed",
      rule: "R4",
      reason: sources > 1 ? "같은 트랜잭션이 내 두 계정에 나가고 들어옴" : "자기 자신에게 보냄",
    };
  }

  const ins = legs.filter((e) => !e.amount.startsWith("-"));
  const outs = legs.filter((e) => e.amount.startsWith("-"));

  // R5: 한 방향 이동인데 상대 주소가 내 다른 계정
  if ((ins.length === 0 || outs.length === 0) && legs.every((e) => e.counterparty && ownAddresses.has(norm(e.counterparty)!))) {
    return { ...base, category: "internal_transfer", status: "confirmed", rule: "R5", reason: "상대 주소가 내 다른 계정 (해당 체인 미동기화)" };
  }

  if (ins.length > 0 && outs.length > 0) {
    const inKeys = new Set(ins.map(assetOf));
    const outKeys = new Set(outs.map(assetOf));
    // R7: 네이티브 코인 ↔ 래핑 토큰 (같은 체인)
    const all = [...inKeys, ...outKeys];
    const chain = all[0].split(":")[0];
    if (
      all.length === 2 &&
      all.every((k) => k.startsWith(`${chain}:`)) &&
      all.some((k) => k.endsWith(":native")) &&
      all.some((k) => WRAPPED_NATIVE.has(k))
    ) {
      return { ...base, category: "wrap", status: "confirmed", rule: "R7", reason: "네이티브 코인 ↔ 래핑 토큰" };
    }
    // R9: 서로 다른 자산이 나가고 들어옴
    if ([...inKeys].some((k) => !outKeys.has(k))) {
      return { ...base, category: "trade", status: "suggested", rule: "R9", reason: "한 거래에서 다른 자산이 나가고 들어옴 (DEX 스왑 추정)" };
    }
  }

  // 여기부터는 자산별 순변동의 방향으로 판단한다.
  // 예: 내 지갑 A가 한 거래로 내 지갑 B와 외부에 동시에 보내면, B로 간 부분은 상쇄되고 외부로 나간 순금액만 남는다.
  const nets = [...byAsset.values()];

  if (nets.every((v) => v.gte(0))) {
    // R10: 토큰 컨트랙트가 직접 보낸 입금 → 스팸 의심
    const selfSent =
      outs.length === 0 &&
      ins.every((e) => {
        // 컨트랙트 주소가 있는 토큰(EVM)만 해당한다. 거래소 기록처럼 주소가 없으면 적용하지 않는다.
        const contract = e.assetKey.split(":")[1];
        return !!contract?.startsWith("0x") && !!e.counterparty && norm(e.counterparty) === contract;
      });
    if (selfSent) {
      return { ...base, category: "spam", status: "suggested", rule: "R10", reason: "토큰 컨트랙트가 직접 보낸 토큰 (스팸 의심)" };
    }
    // R12: 출처 불명 입금
    return { ...base, category: "external_in", status: "needs_review", rule: "R12", reason: "연결하지 않은 곳에서 들어옴. 취득 경위를 확인하세요" };
  }

  if (nets.every((v) => v.lte(0))) {
    // R13: 외부로 보냄 (정책: 양도로 계산하고 미확인 표시)
    return { ...base, category: "external_out", status: "needs_review", rule: "R13", reason: "연결하지 않은 곳으로 나감. 선물·결제인지, 내 다른 계정인지 확인하세요" };
  }

  return { ...base, category: "unknown", status: "needs_review", rule: "-", reason: "규칙으로 판단하지 못함" };
}

// 전체 원장을 그룹으로 묶어 분류하고, 사용자 결정이 있으면 그것을 우선한다.
// 트랜잭션 해시 표기 통일 (대소문자, 0x 유무)
const normHash = (h: string) => h.trim().toLowerCase().replace(/^0x/, "");

// 같은 트랜잭션 해시를 가진 그룹을 하나로 합친다.
// 예: 거래소 출금 기록(bybit:wd:…)과 내 지갑 입금 기록(btc:<txid>)은 같은 이동이다 → 합쳐서 R4로 내 계정 간 이체.
// 합친 그룹의 키는 블록체인 쪽 groupId를 우선한다 (재동기화해도 바뀌지 않게).
export function groupByTransaction(entries: LedgerEntry[]): Map<string, LedgerEntry[]> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const chainFirst = (a: string, b: string, aChain: boolean, bChain: boolean) =>
    aChain !== bChain ? (aChain ? a : b) : a < b ? a : b;
  const isChainGroup = new Map<string, boolean>();
  for (const e of entries) {
    if (!parent.has(e.groupId)) parent.set(e.groupId, e.groupId);
    if (e.origin !== "exchange") isChainGroup.set(e.groupId, true);
  }

  const byHash = new Map<string, string>();
  for (const e of entries) {
    if (!e.txHash) continue;
    const h = normHash(e.txHash);
    const other = byHash.get(h);
    if (!other) {
      byHash.set(h, e.groupId);
      continue;
    }
    const a = find(e.groupId);
    const b = find(other);
    if (a === b) continue;
    const root = chainFirst(a, b, !!isChainGroup.get(a), !!isChainGroup.get(b));
    parent.set(a, root);
    parent.set(b, root);
    isChainGroup.set(root, !!isChainGroup.get(a) || !!isChainGroup.get(b));
  }

  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const key = find(e.groupId);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return groups;
}

export function classifyAll({ entries, ownAddresses, decisions }: ClassifyInput): GroupView[] {
  const groups = groupByTransaction(entries);

  return [...groups.entries()]
    .map(([key, list]) => {
      const auto = classifyGroup(key, list, ownAddresses);
      const d = decisions.get(key);
      const classification: Classification = d
        ? { key, category: d.category, status: "user", rule: "사용자", reason: d.note ?? "사용자가 지정", decision: d }
        : auto;
      return { key, time: Math.min(...list.map((e) => e.time)), entries: list, classification };
    })
    .sort((a, b) => b.time - a.time);
}
