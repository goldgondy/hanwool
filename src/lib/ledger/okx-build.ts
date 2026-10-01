import Decimal from "@/lib/decimal";
import type { LedgerEntry, LedgerKind } from "@/lib/db";

// OKX API 내역 → 원장. 공식 문서 기준 (2026-10-01 확인). ⚠ 실제 키로 검증 전.
// - 거래 계정 내역(/api/v5/account/bills-archive, 최근 3개월): 행마다 잔고 변동 balChg (수수료 fee 포함)
// - 펀딩 계정 내역(/api/v5/asset/bills-history): 행마다 balChg
// - 입출금(/api/v5/asset/deposit-history, withdrawal-history): 블록체인 거래 해시(txId)가 있어 내 지갑과 짝지을 수 있다
// - 심플 언(Simple Earn) 이자(/api/v5/finance/savings/lending-history): 예치 잔고에 거래 없이 붙는다
// OKX 전체를 한 계정으로 보므로 거래↔펀딩↔심플 언 사이 이동은 건너뛴다 (잔고 대조도 세 곳을 합친다).

export interface OkxBill {
  billId: string;
  type: string;
  subType?: string;
  ccy: string;
  balChg: string;
  fee?: string;
  ts: string;
  instType?: string; // SPOT, MARGIN, SWAP, FUTURES, OPTION
  instId?: string;
  ordId?: string;
  tradeId?: string;
}

export interface OkxAssetBill {
  billId: string;
  ccy: string;
  balChg: string;
  type: string;
  ts: string;
}

export interface OkxDeposit {
  depId: string;
  ccy: string;
  amt: string;
  txId?: string;
  state: string; // 2 = 입금 완료
  ts: string;
}

export interface OkxWithdrawal {
  wdId: string;
  ccy: string;
  amt: string;
  fee?: string;
  feeCcy?: string;
  txId?: string;
  state: string; // 2 = 출금 완료
  ts: string;
}

export interface OkxLending {
  ccy: string;
  earnings: string;
  ts: string;
}

type Family = "trade" | "convert" | "reward" | "airdrop" | "fee" | "derivative" | "loan" | "transfer" | "product" | "skip";

// 거래 계정 내역 유형 (type)
const BILL_TYPES: Record<string, Family> = {
  "1": "skip", // 펀딩 ↔ 거래 계정 이체
  "2": "trade",
  "3": "derivative", // 인도
  "4": "convert", // 강제 상환·자동 토큰 전환
  "5": "derivative", // 청산
  "6": "skip", // 마진 이동 (계정 안)
  "7": "fee", // 이자 차감
  "8": "derivative", // 펀딩비
  "9": "derivative", // ADL
  "10": "derivative", // 클로백
  "11": "convert", // 시스템 토큰 전환
  "12": "skip", // 전략 이체
  "13": "derivative", // DDH
  "14": "trade", // 블록 거래
  "16": "loan", // 차입
  "22": "loan", // 상환
  "24": "derivative", // 스프레드 거래
  "27": "convert",
  "28": "convert", // 소액 전환
  "29": "loan", // 일괄 상환
  "30": "convert", // 간편 거래
  "33": "loan",
  "34": "derivative", // 정산
};

// 펀딩 계정 내역 유형 (type)
const ASSET_TYPES: Record<string, Family> = {
  "1": "skip", // 입금 → 입금 내역에서 기록 (거래 해시 포함)
  "2": "skip", // 출금 → 출금 내역에서 기록
  "13": "skip", // 출금 취소
  "20": "transfer", // 하위 계정으로
  "21": "transfer", // 하위 계정에서
  "22": "transfer",
  "23": "transfer",
  "28": "airdrop", // 에어드랍 수령
  "48": "reward", // 이벤트 보상
  "49": "airdrop", // 이벤트 증정
  "68": "reward", // 수수료 리베이트
  "75": "skip", // 심플 언 예치 (잔고 대조에 포함)
  "76": "skip", // 심플 언 환매
  "80": "product", // 스테이킹 상품 가입
  "82": "product", // 스테이킹 상품 환매
  "83": "reward", // 스테이킹 수익
  "85": "reward", // 채굴 수익
  "87": "reward",
  "89": "reward", // 스테이킹 수익
  "102": "convert", // 소액 전환
  "103": "convert",
  "130": "skip", // 거래 계정에서
  "131": "skip", // 거래 계정으로
  "136": "convert",
  "137": "product", // ETH 스테이킹
  "138": "product",
  "139": "reward",
  "150": "reward", // 추천 수수료
  "151": "reward", // 추천 보상
  "152": "reward",
  "153": "reward",
  "154": "airdrop", // 미스터리 박스
  "156": "reward", // 수수료 리베이트
  "160": "product", // 듀얼 인베스트먼트 가입
  "161": "product",
  "162": "reward", // 듀얼 인베스트먼트 수익
  "173": "reward",
};

const KIND: Record<Exclude<Family, "skip">, LedgerKind> = {
  trade: "trade",
  convert: "trade",
  reward: "income",
  airdrop: "income",
  fee: "fee",
  derivative: "other",
  loan: "other",
  transfer: "transfer",
  product: "other",
};

const DERIVATIVE_INST = new Set(["SWAP", "FUTURES", "OPTION"]);

export interface OkxBuildResult {
  entries: LedgerEntry[];
  unknownTypes: string[];
  warnings: string[];
}

export function buildOkxEntries(input: {
  sourceId: string;
  bills: OkxBill[];
  assetBills: OkxAssetBill[];
  deposits: OkxDeposit[];
  withdrawals: OkxWithdrawal[];
  lending: OkxLending[];
}): OkxBuildResult {
  const { sourceId } = input;
  const entries: LedgerEntry[] = [];
  const unknown = new Set<string>();
  let derivatives = 0;
  let products = 0;
  const base = { sourceId, origin: "exchange" as const };
  const coin = (c: string) => c.toUpperCase();

  for (const b of input.bills) {
    let family = BILL_TYPES[b.type];
    if (!family) unknown.add(`거래 계정 ${b.type}`);
    if (family === "skip") continue;
    if (family === "trade" && b.instType && DERIVATIVE_INST.has(b.instType)) family = "derivative";
    if (family === "derivative") derivatives++;

    const total = new Decimal(b.balChg || 0);
    const fee = new Decimal(b.fee || 0); // 음수 = 낸 수수료
    const time = Number(b.ts);
    const groupId = family === "trade" ? `okx:ord:${b.ordId || b.tradeId || b.billId}` : family === "convert" ? `okx:conv:${b.ts}` : `okx:bill:${b.billId}`;
    const common = { ...base, location: "OKX 거래 계정", time, asset: coin(b.ccy), assetKey: coin(b.ccy), groupId };
    const rawType = `bill ${b.type}${b.subType ? `/${b.subType}` : ""}${b.instId ? ` (${b.instId})` : ""}`;

    // 체결은 수수료를 따로 기록한다. balChg = 체결 수량 + 수수료이므로 합계는 그대로 잔고 변동과 같다.
    const split = family === "trade" && !fee.isZero();
    const main = split ? total.minus(fee) : total;
    if (!main.isZero()) {
      entries.push({
        ...common,
        id: `${sourceId}:okx:bill:${b.billId}`,
        amount: main.toString(),
        kind: family ? KIND[family] : "other",
        tag: family === "reward" ? "reward" : family === "airdrop" ? "airdrop" : undefined,
        rawType,
      });
    }
    if (split) entries.push({ ...common, id: `${sourceId}:okx:bill:${b.billId}:fee`, amount: fee.toString(), kind: "fee", rawType: `${rawType} fee` });
  }

  for (const b of input.assetBills) {
    const family = ASSET_TYPES[b.type];
    if (!family) unknown.add(`펀딩 계정 ${b.type}`);
    if (family === "skip") continue;
    if (family === "product") products++;
    const amount = new Decimal(b.balChg || 0);
    if (amount.isZero()) continue;
    entries.push({
      ...base,
      id: `${sourceId}:okx:asset:${b.billId}`,
      location: "OKX 펀딩 계정",
      time: Number(b.ts),
      asset: coin(b.ccy),
      assetKey: coin(b.ccy),
      amount: amount.toString(),
      kind: family ? KIND[family] : "other",
      groupId: family === "convert" ? `okx:conv:${b.ts}` : `okx:asset:${b.billId}`,
      tag: family === "reward" ? "reward" : family === "airdrop" ? "airdrop" : undefined,
      rawType: `funding ${b.type}`,
    });
  }

  for (const d of input.deposits) {
    if (d.state !== "2") continue;
    entries.push({
      ...base,
      id: `${sourceId}:okx:dep:${d.depId}`,
      location: "OKX 펀딩 계정",
      time: Number(d.ts),
      asset: coin(d.ccy),
      assetKey: coin(d.ccy),
      amount: new Decimal(d.amt).toString(),
      kind: "transfer",
      groupId: `okx:dep:${d.depId}`,
      txHash: d.txId || undefined,
      rawType: "Deposit",
    });
  }

  for (const w of input.withdrawals) {
    if (w.state !== "2") continue;
    const common = { ...base, location: "OKX 펀딩 계정", time: Number(w.ts), groupId: `okx:wd:${w.wdId}`, txHash: w.txId || undefined };
    entries.push({ ...common, id: `${sourceId}:okx:wd:${w.wdId}`, asset: coin(w.ccy), assetKey: coin(w.ccy), amount: new Decimal(w.amt).neg().toString(), kind: "transfer", rawType: "Withdrawal" });
    const fee = new Decimal(w.fee || 0).abs();
    const feeCcy = coin(w.feeCcy || w.ccy);
    if (!fee.isZero()) entries.push({ ...common, id: `${sourceId}:okx:wd:${w.wdId}:fee`, asset: feeCcy, assetKey: feeCcy, amount: fee.neg().toString(), kind: "fee", rawType: "Withdrawal fee" });
  }

  for (const l of input.lending) {
    const amount = new Decimal(l.earnings || 0);
    if (amount.isZero()) continue;
    const id = `${coin(l.ccy)}:${l.ts}`;
    entries.push({
      ...base,
      id: `${sourceId}:okx:earn:${id}`,
      location: "OKX 심플 언",
      time: Number(l.ts),
      asset: coin(l.ccy),
      assetKey: coin(l.ccy),
      amount: amount.toString(),
      kind: "income",
      groupId: `okx:earn:${id}`,
      tag: "reward",
      rawType: "Simple Earn interest",
    });
  }

  const warnings: string[] = [];
  if (derivatives > 0) warnings.push(`선물·파생상품 관련 기록 ${derivatives}건은 과세 여부 검토가 필요해 미분류로 두었습니다.`);
  if (products > 0) warnings.push(`스테이킹·듀얼 인베스트먼트 등 상품 가입·환매 기록 ${products}건이 있습니다. 상품에 묶인 금액은 잔고 대조에 포함되지 않습니다.`);
  return { entries, unknownTypes: [...unknown], warnings };
}
