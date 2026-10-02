import Decimal from "@/lib/decimal";
import { fiatAssetKey } from "@/lib/assets";
import type { LedgerEntry } from "@/lib/db";
import { rowKey } from "./csv";
import { parseAmount, parseKst } from "./upbit";
import type { CsvAdapter, ImportResult } from "./types";

// 빗썸 "기간별 거래 내역" 엑셀 (빗썸 → 입출금 → 거래내역 → 엑셀 다운로드).
// 파일 앞 두 줄은 제목("Bithumb 기간별 거래 내역")과 기간이고, 셋째 줄이 열 이름이다.
// 열: 거래일시 · 자산(한글 이름) · 거래구분 · 거래수량 · 체결가격 · 거래금액 · 수수료 · 정산금액
// 칸에 단위가 함께 적혀 있다 ("0.02281208 BTC", "95,340,000.0000 KRW", "-"). 자산 이름이 한글이라 코인 기호는 거래수량의 단위에서 얻는다.
// 2026-10-02 세무사 제공 샘플(화면 캡처)로 확인한 규칙:
//   매수: 정산금액 = −(거래금액 + 수수료)   매도: 정산금액 = 거래금액 − 수수료 (원 단위 내림)
//   출금: 거래수량 = 거래금액 + 수수료, 정산금액 = −거래수량       입금: 정산금액 = +거래수량
//   포인트샵 입금: 빗썸 포인트로 받은 코인 (보상으로 처리)

export const BITHUMB_COLUMNS = ["거래일시", "자산", "거래구분", "거래수량", "체결가격", "거래금액", "수수료", "정산금액"];

// "0.02281208 BTC" → "BTC", "5,034,802 KRW" → "KRW"
export function unitOf(s: string | undefined): string | null {
  const m = (s ?? "").match(/([A-Za-z][A-Za-z0-9]*)\s*$/);
  return m ? m[1].toUpperCase() : null;
}

const keyOf = (coin: string) => (coin === "KRW" ? fiatAssetKey("KRW") : coin);

// 매수·매도·입출금 외 유형: 받은 쪽(+)이면서 이름이 보상 성격이면 보상으로, 그 밖에는 미분류(검토 필요)
const REWARD = /포인트|이벤트|에어드랍|에어드롭|리워드|보상|스테이킹|이자|지급|혜택|캐시백|airdrop|reward/i;

export const bithumbHistory: CsvAdapter = {
  id: "bithumb-period-history-v1",
  exchange: "bithumb",
  exchangeName: "빗썸",
  formatName: "기간별 거래 내역 (엑셀)",
  howToExport:
    "빗썸 → 입출금 → 거래내역(또는 마이페이지 → 거래내역) → 기간 선택 → 엑셀 다운로드. 받은 파일(.xlsx)을 그대로 올리면 됩니다. 올라가지 않으면 엑셀에서 표 전체를 복사해 ‘붙여넣기’ 칸에 넣으세요.",
  verified: true,

  detect: (h) => ["거래일시", "자산", "거래구분", "거래수량", "정산금액"].every((c) => h.includes(c)),

  convert(table, sourceId): ImportResult {
    const entries: LedgerEntry[] = [];
    const warnings: string[] = [];
    const unknown = new Set<string>();
    const seen = new Map<string, number>();
    let from = Infinity;
    let to = -Infinity;
    let bad = 0;

    for (const row of table.rows) {
      const time = parseKst(row["거래일시"] ?? "");
      const type = (row["거래구분"] ?? "").trim();
      const qtyRaw = row["거래수량"];
      const qty = parseAmount(qtyRaw);
      const coin = unitOf(qtyRaw) ?? (row["자산"] === "원화" ? "KRW" : null);
      if (Number.isNaN(time) || !qty || !coin || !type) {
        bad++;
        continue;
      }
      from = Math.min(from, time);
      to = Math.max(to, time);
      const key = rowKey(BITHUMB_COLUMNS.map((c) => row[c] ?? ""), seen);
      const id = `${sourceId}:file:${key}`;
      const base = { sourceId, origin: "exchange" as const, location: "빗썸", time, rawType: type };
      const q = new Decimal(qty).abs();
      const funds = parseAmount(row["거래금액"]);
      const fundsUnit = unitOf(row["거래금액"]);
      const settled = parseAmount(row["정산금액"]);
      const settledUnit = unitOf(row["정산금액"]);
      const feeRaw = parseAmount(row["수수료"]);
      const feeUnit = unitOf(row["수수료"]);

      if (type === "매수" || type === "매도") {
        if (!funds || !fundsUnit) {
          bad++;
          continue;
        }
        const buy = type === "매수";
        const quote = fundsUnit;
        const f = new Decimal(funds).abs();
        // 같은 초·같은 코인·같은 방향의 체결은 한 거래로 묶는다 (한 주문이 여러 가격에 나눠 체결된 것)
        const groupId = `bithumb:file:${time}:${coin}-${quote}:${type}`;
        entries.push(
          { ...base, id: `${id}:coin`, asset: coin, assetKey: keyOf(coin), amount: (buy ? q : q.neg()).toString(), kind: "trade", groupId },
          { ...base, id: `${id}:quote`, asset: quote, assetKey: keyOf(quote), amount: (buy ? f.neg() : f).toString(), kind: "trade", groupId },
        );
        // 수수료: 정산금액과 거래금액의 차이가 실제로 빠진 금액이다 (수수료 칸은 소수점까지 적혀 있지만 정산은 원 단위)
        let fee: Decimal | null = null;
        let feeAsset = quote;
        if (settled && settledUnit === quote) fee = new Decimal(settled).abs().minus(f).abs();
        else if (feeRaw) {
          fee = new Decimal(feeRaw).abs();
          feeAsset = feeUnit ?? quote;
        }
        if (fee && !fee.isZero()) entries.push({ ...base, id: `${id}:fee`, asset: feeAsset, assetKey: keyOf(feeAsset), amount: fee.neg().toString(), kind: "fee", groupId });
        continue;
      }

      const groupId = `bithumb:file:${key}`;
      if (type === "입금") {
        entries.push({ ...base, id: `${id}:in`, asset: coin, assetKey: keyOf(coin), amount: q.toString(), kind: "transfer", groupId });
        continue;
      }
      if (type === "출금") {
        // 거래수량 = 보낸 금액 + 수수료. 보낸 금액은 거래금액 칸, 없으면 거래수량 − 수수료
        const fee = feeRaw && (feeUnit ?? coin) === coin ? new Decimal(feeRaw).abs() : new Decimal(0);
        const sent = funds && (fundsUnit ?? coin) === coin ? new Decimal(funds).abs() : q.minus(fee);
        entries.push({ ...base, id: `${id}:out`, asset: coin, assetKey: keyOf(coin), amount: sent.neg().toString(), kind: "transfer", groupId });
        if (!fee.isZero()) entries.push({ ...base, id: `${id}:fee`, asset: coin, assetKey: keyOf(coin), amount: fee.neg().toString(), kind: "fee", groupId });
        continue;
      }

      // 그 밖의 유형: 정산금액 부호로 들어온 것인지 나간 것인지 판단
      const sign = settled && new Decimal(settled).isNegative() ? -1 : 1;
      const amount = sign < 0 ? q.neg() : q;
      if (sign > 0 && REWARD.test(type)) {
        const airdrop = /에어드[랍롭]|airdrop/i.test(type);
        entries.push({ ...base, id: `${id}:in`, asset: coin, assetKey: keyOf(coin), amount: amount.toString(), kind: "income", tag: airdrop ? "airdrop" : "reward", groupId });
      } else {
        unknown.add(type);
        entries.push({ ...base, id: `${id}:other`, asset: coin, assetKey: keyOf(coin), amount: amount.toString(), kind: "other", groupId });
      }
    }

    if (bad) warnings.push(`${bad}줄은 시각·수량·종류를 읽지 못해 건너뛰었습니다.`);
    if (entries.some((e) => e.kind === "transfer" && e.assetKey !== fiatAssetKey("KRW"))) {
      warnings.push("빗썸 내역에는 블록체인 거래 번호가 없어, 내 지갑·다른 거래소와의 코인 입출금은 수량·시각으로 짝을 찾습니다. 못 찾은 것은 분류 검토에서 확인하세요.");
    }
    return { entries, warnings, unknownTypes: [...unknown], range: entries.length ? { from, to } : null, rowCount: table.rows.length };
  },
};
