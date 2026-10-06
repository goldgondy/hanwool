import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import type { Classification, Decision } from "./types";

// 원장 + 사용자 결정 → 그룹별 분류. 규칙 번호는 docs/classification.md §5와 같다.
// 브릿지(R8)는 해당 데이터가 생기면 추가한다. 해시 없는 매칭(R11)은 아래 matchUnhashedTransfers.

const isFiatKey = (assetKey: string) => assetKey.startsWith("fiat:");
// 내 계정 간 이체에서 받은 수량이 보낸 수량보다 적어도 되는 최대 비율 (이체 수수료)
const PAIR_MAX_DIFF = new Decimal("0.05");

// 체인별 공식 USDT·USDC 컨트랙트 (assetKey 형식). EVM은 소문자, 트론·솔라나는 Base58 그대로.
export const OFFICIAL_STABLES: Record<string, Set<string>> = {
  USDT: new Set([
    "eth:0xdac17f958d2ee523a2206206994597c13d831ec7",
    "arb:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
    "opt:0x94b008aa00579c1307b0ef2c499ad98a8ce58e58",
    "polygon:0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
    "base:0xfde4c96c8593536e31f229ea8f37b2ada2699bb2",
    "tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    "sol:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "avax:0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7",
    "plasma:0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb", // USDT0 (이름을 USDT로 맞춤, lib/sources/evm.ts)
    "ton:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe", // TON USD₮
    "aptos:0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b", // Aptos USDt
    "bsc:0x55d398326f99059ff775485246999027b3197955", // BSC-USD (테더 USDT)
  ]),
  USDC: new Set([
    "eth:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "arb:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    "opt:0x0b2c639c533813f4aa9d7837caf62653d097ff85",
    "polygon:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "tron:TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8",
    "sol:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "avax:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
    "aptos:0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
    "bsc:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  ]),
};

// 블록체인 기록(체인:컨트랙트)에서 이름은 USDT·USDC인데 공식 컨트랙트가 아닌 경우
function isImpersonatingStable(e: LedgerEntry) {
  const official = OFFICIAL_STABLES[e.asset.toUpperCase()];
  if (!official || e.origin === "exchange") return false;
  const [chain, contract] = e.assetKey.split(":");
  if (!contract || contract === "native" || !(chain in { eth: 1, arb: 1, opt: 1, polygon: 1, base: 1, avax: 1, plasma: 1, bsc: 1, ton: 1, aptos: 1, tron: 1, sol: 1 })) return false;
  return !official.has(e.assetKey);
}

// 네이티브 코인 래핑 컨트랙트 (소문자). assetKey 형식: `${chain}:${contract}`
export const WRAPPED_NATIVE = new Set([
  "eth:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "avax:0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", // WAVAX
  "plasma:0x6100e367285b01f48d07953803a2d8dca5d19873", // WXPL
  "bsc:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
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

  // R1–R3: 거래소가 남긴 체결·보상 기록과 사용자가 직접 입력한 거래는 추정이 아니므로 확정한다.
  if (entries.every((e) => e.origin === "exchange" || e.origin === "manual")) {
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

  // R3: 블록체인이 직접 지급한 보상 (솔라나 스테이킹 보상, 트론 투표 보상 수령). 프로토콜 기록이라 추정이 아니다.
  if (legs.every((e) => e.tag === "reward" && e.kind === "income")) {
    return { ...base, category: "reward", status: "confirmed", rule: "R3", reason: "블록체인 스테이킹·투표 보상" };
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

  // R4 (차이 허용): 거래 번호로 묶인 서로 다른 계정의 이체인데 수량이 조금 다른 경우
  //  - 받은 쪽이 아주 조금 많음(보낸 수량의 0.0001% 이하): 거래소가 소수점을 반올림해 적은 것
  //  - 받은 쪽이 적음(5% 이하): 거래소가 출금 수량에 수수료를 포함해 적은 것 → 차이를 이체 수수료로
  const hashed = new Set(legs.map((e) => e.sourceId)).size > 1 && legs.some((e) => e.txHash);
  if (hashed && byAsset.size === 1) {
    const [net] = [...byAsset.values()];
    const sent = legs.filter((e) => e.amount.startsWith("-")).reduce((s, e) => s.plus(e.amount), new Decimal(0)).abs();
    const dust = sent.mul("0.000001");
    if (sent.gt(0) && net.abs().lte(dust)) {
      return { ...base, category: "internal_transfer", status: "confirmed", rule: "R4", reason: "같은 거래 번호로 내 두 계정에 나가고 들어옴 (소수점 반올림 차이)" };
    }
    if (sent.gt(0) && net.isNeg() && net.abs().lte(sent.mul(PAIR_MAX_DIFF))) {
      const asset = legs.find((e) => e.amount.startsWith("-"))!.asset;
      return {
        ...base,
        category: "internal_transfer",
        status: "confirmed",
        rule: "R4",
        reason: `같은 거래 번호로 내 두 계정에 나가고 들어옴 (차이 ${net.abs().toString()}은 이체 수수료로 봄)`,
        pair: { key, feeAsset: asset, feeQty: net.abs().toString() },
      };
    }
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
    // R10d: 아주 적은 금액에 광고 메모를 붙인 먼지 송금 (TON 등, 빌더가 rawType "Dust"로 표시)
    if (outs.length === 0 && ins.every((e) => e.rawType === "Dust")) {
      return { ...base, category: "spam", status: "suggested", rule: "R10", reason: "아주 적은 금액의 먼지 송금 (광고 메모 스팸 의심)" };
    }
    // R10c: 이름이 웹 주소인 토큰 (예: "www.basex.cfd") → 사기 사이트로 유도하는 에어드랍 스팸
    if (outs.length === 0 && ins.every((e) => e.origin !== "exchange" && /(^www\.|https?:|\.(com|io|net|org|xyz|cfd|top|site|app|fi|vip|pro|cc|me|gift|claim)\b|t\.me\/)/i.test(e.asset))) {
      return { ...base, category: "spam", status: "suggested", rule: "R10", reason: "이름이 웹 주소인 토큰 (사기 사이트 유도 스팸 의심)" };
    }
    // R10b: 주요 스테이블코인 이름인데 그 체인의 공식 컨트랙트가 아닌 토큰 → 사칭 토큰 의심 (주소 오염 사기에 흔함)
    if (outs.length === 0 && ins.every(isImpersonatingStable)) {
      return { ...base, category: "spam", status: "suggested", rule: "R10", reason: "공식 컨트랙트가 아닌 USDT·USDC (사칭 토큰 의심)" };
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
// 블록체인 거래 번호로 보이는 값만 쓴다 (16진수 32자 이상, 또는 솔라나 등 base58 43자 이상).
// 바이낸스 "Internal transfer", 거래소 내부 번호처럼 여러 기록이 같은 값을 가질 수 있는 것으로 묶으면 남의 거래끼리 합쳐진다.
export const looksLikeChainHash = (h: string) => /^(0x)?[0-9a-f]{32,}$/i.test(h.trim()) || /^[1-9A-HJ-NP-Za-km-z]{43,}$/.test(h.trim());

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
    if (!e.txHash || !looksLikeChainHash(e.txHash)) continue;
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

  const views = [...groups.entries()]
    .map(([key, list]) => {
      const auto = classifyGroup(key, list, ownAddresses);
      const d = decisions.get(key);
      const classification: Classification = d
        ? { key, category: d.category, status: "user", rule: "사용자", reason: d.note ?? "사용자가 지정", decision: d }
        : auto;
      return { key, time: Math.min(...list.map((e) => e.time)), entries: list, classification };
    })
    .sort((a, b) => b.time - a.time);
  matchUnhashedTransfers(views);
  return views;
}

// R11: 거래 번호가 없어 R4로 묶이지 못한 내 계정 간 이체를 수량·시각으로 짝짓는다.
// 예: 업비트 화면 붙여넣기의 USDT 100 출금(거래 번호 없음) → 2시간 뒤 바이낸스 USDT 99 입금 (출금 수수료 1).
// 조건: 한쪽은 외부로 나감(R13), 다른 쪽은 외부에서 들어옴(R12), 서로 다른 계정, 같은 코인, 한 자산만 이동,
//       입금이 출금 2시간 전 ~ 48시간 뒤, 받은 수량이 보낸 수량 이하이고 차이가 5% 이내. 수량 차이·시간 차가 작은 짝부터 정한다.
//       (2시간 전: 파일마다 시간대 표기가 달라 생기는 어긋남, 48시간 뒤: 출금 심사·블록 확인 지연)
// 추정이므로 "제안" 상태로 두며, 분류 검토에서 사용자가 바꿀 수 있다.
const PAIR_BEFORE_MS = 2 * 3600_000;
const PAIR_AFTER_MS = 48 * 3600_000;

interface Side {
  view: GroupView;
  symbol: string;
  qty: Decimal;
  sources: Set<string>;
  hasHash: boolean;
  location: string;
  onChain: boolean; // 블록체인 기록만으로 이뤄진 쪽 (브리지 판단용)
}

function sideOf(view: GroupView, dir: "out" | "in"): Side | null {
  const c = view.classification;
  if (c.status === "user" || c.rule !== (dir === "out" ? "R13" : "R12")) return null;
  const legs = view.entries.filter((e) => e.kind !== "fee" && !isFiatKey(e.assetKey));
  const symbols = new Set(legs.map((e) => e.asset.toUpperCase()));
  if (legs.length === 0 || symbols.size !== 1) return null;
  const qty = legs.reduce((s, e) => s.plus(e.amount), new Decimal(0)).abs();
  if (qty.isZero()) return null;
  return {
    view,
    symbol: [...symbols][0],
    qty,
    sources: new Set(legs.map((e) => e.sourceId)),
    hasHash: legs.some((e) => !!e.txHash),
    location: legs[0].location,
    onChain: legs.every((e) => e.origin !== "exchange" && e.origin !== "manual"), // 지갑 빌더는 origin을 비워 두기도 한다
  };
}

export function matchUnhashedTransfers(views: GroupView[]) {
  const outs = views.map((v) => sideOf(v, "out")).filter((s): s is Side => !!s);
  const ins = views.map((v) => sideOf(v, "in")).filter((s): s is Side => !!s);
  const candidates: { out: Side; in: Side; diff: Decimal; gap: number }[] = [];
  for (const o of outs) {
    for (const i of ins) {
      if (o.symbol !== i.symbol) continue;
      // 같은 계정끼리는 짝짓지 않는다. 단, 같은 지갑이 체인을 옮긴 브리지(예: 이더리움 → 아비트럼)는 체인이 달라 거래 번호가 달라도 짝짓는다.
      const bridge = o.onChain && i.onChain && o.location !== i.location;
      if ([...o.sources].some((s) => i.sources.has(s)) && !bridge) continue;
      if (o.hasHash && i.hasHash && !bridge) continue; // 둘 다 거래 번호가 있는데 다르면 다른 이동이다 (브리지는 체인마다 거래 번호가 따로 생긴다)
      const gap = i.view.time - o.view.time;
      if (gap < -PAIR_BEFORE_MS || gap > PAIR_AFTER_MS) continue;
      const short = o.qty.minus(i.qty);
      if (short.isNeg() || short.gt(o.qty.mul(PAIR_MAX_DIFF))) continue;
      candidates.push({ out: o, in: i, diff: short.div(o.qty), gap: Math.abs(gap) });
    }
  }
  candidates.sort((a, b) => a.diff.comparedTo(b.diff) || a.gap - b.gap);
  const used = new Set<string>();
  for (const { out: o, in: i } of candidates) {
    if (used.has(o.view.key) || used.has(i.view.key)) continue;
    used.add(o.view.key);
    used.add(i.view.key);
    const short = o.qty.minus(i.qty);
    const hours = Math.round(((i.view.time - o.view.time) / 3600_000) * 10) / 10;
    const base = { category: "internal_transfer" as const, status: "suggested" as const, rule: "R11" };
    o.view.classification = {
      ...base,
      key: o.view.key,
      reason: `${i.location}의 입금 ${i.qty.toString()} ${i.symbol}과(와) 수량·시각이 맞아 ${o.onChain && i.onChain && o.location !== i.location ? "체인 간 브리지(내 계정 간 이체)로" : "내 계정 간 이체로"} 보임 (${hours}시간 뒤 입금${short.isZero() ? "" : `, 차이 ${short.toString()}은 이체 수수료로 봄`})`,
      pair: { key: i.view.key, ...(short.isZero() ? {} : { feeAsset: o.symbol, feeQty: short.toString() }) },
    };
    i.view.classification = {
      ...base,
      key: i.view.key,
      reason: `${o.location}의 출금 ${o.qty.toString()} ${o.symbol}과(와) 수량·시각이 맞아 내 계정 간 이체로 보임`,
      pair: { key: o.view.key },
    };
  }
}
