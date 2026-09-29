import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import type { Classification, Decision } from "./types";

// 원장 + 사용자 결정 → 그룹별 분류. 규칙 번호는 docs/classification.md §5와 같다.
// 거래소 체결·보상 기록(R1–R3), 브릿지(R8), 해시 없는 매칭(R11)은 해당 데이터가 생기면 추가한다.

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

  // R4: 수수료 외 항목이 자산별로 합계 0 → 내 계정 사이에서만 움직임
  const byAsset = new Map<string, Decimal>();
  for (const e of legs) byAsset.set(e.assetKey, (byAsset.get(e.assetKey) ?? new Decimal(0)).plus(e.amount));
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
    const inKeys = new Set(ins.map((e) => e.assetKey));
    const outKeys = new Set(outs.map((e) => e.assetKey));
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
        const contract = e.assetKey.split(":")[1];
        return contract !== "native" && norm(e.counterparty) === contract;
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
export function classifyAll({ entries, ownAddresses, decisions }: ClassifyInput): GroupView[] {
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries) groups.set(e.groupId, [...(groups.get(e.groupId) ?? []), e]);

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
