import Decimal from "@/lib/decimal";
import { fiatAssetKey } from "@/lib/assets";
import type { LedgerEntry } from "@/lib/db";
import { rowKey } from "./csv";
import type { CsvAdapter, CsvTable, ImportResult } from "./types";

// 업비트 거래내역 화면 복사·붙여넣기 (업비트는 거래내역 파일 내보내기를 주지 않는다).
// 업비트 웹 → 투자내역 → 거래내역 표를 드래그해 복사한 글자를 표로 바꾼다.
// 표의 열: 체결시간 · 코인 · 마켓 · 종류(매수/매도/입금/출금) · 거래수량 · 거래단가 · 거래금액 · 수수료 · 정산금액 · 주문시간
// 복사 방식(브라우저·화면)에 따라 칸이 탭으로 나뉘거나 줄로 나뉘므로, 열 순서 대신 '시각'과 '종류'를 기준으로 기록을 찾는다.
// ⚠ 실제 화면으로 검증 전. 미리보기에서 건수·기간을 확인한 뒤 가져온다.

export const UPBIT_COLUMNS = ["체결시간", "코인", "마켓", "종류", "거래수량", "거래단가", "거래금액", "수수료", "정산금액", "주문시간"];

const DATE = /^\d{4}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}\.?$/;
const TIME = /^\d{1,2}:\d{2}(:\d{2})?$/;
const DATETIME = /^\d{4}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}\.?\s+\d{1,2}:\d{2}(:\d{2})?$/;
const TYPES = new Set(["매수", "매도", "입금", "출금"]);
const MARKETS = new Set(["KRW", "BTC", "USDT"]);

// "2027.01.02 09:00:05" (한국 시각) → 밀리초
export function parseKst(s: string): number {
  const m = s.match(/^(\d{4})[.\-/]\s?(\d{1,2})[.\-/]\s?(\d{1,2})\.?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se] = m;
  return Date.UTC(+y, +mo - 1, +d, +h - 9, +mi, +(se ?? 0));
}

// "1,234.5678 BTC", "50,000,000KRW", "-" → 숫자 문자열 또는 null
export function parseAmount(s: string | undefined): string | null {
  if (!s) return null;
  const n = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return n ? new Decimal(n[0]).toString() : null;
}

// "비트코인(BTC)", "BTC", "KRW-BTC" → { coin, market? }
function coinOf(token: string): { coin?: string; market?: string } {
  const pair = token.match(/^(KRW|BTC|USDT)-([A-Z0-9]+)$/);
  if (pair) return { market: pair[1], coin: pair[2] };
  const paren = token.match(/\(([A-Z0-9]+)\)\s*$/);
  if (paren) return { coin: paren[1] };
  if (/^[A-Z0-9]{2,15}$/.test(token)) return { coin: token };
  return {};
}

// 붙여넣은 글자 → 표준 열 이름의 표. 기록을 하나도 찾지 못하면 null.
export function parseUpbitPaste(text: string): { table: CsvTable; skipped: number } | null {
  // 1) 칸 나누기: 줄과 탭 모두 칸 경계로 본다. 날짜와 시간이 다른 칸으로 나뉘면 합친다.
  const raw = text
    .replace(/\r/g, "")
    .split(/[\n\t]/)
    .map((t) => t.trim())
    .filter((t) => t && !UPBIT_COLUMNS.includes(t));
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (DATE.test(raw[i]) && TIME.test(raw[i + 1] ?? "")) {
      tokens.push(`${raw[i]} ${raw[i + 1]}`);
      i++;
    } else tokens.push(raw[i]);
  }

  // 2) 시각 칸마다 끊어 조각으로 나눈다. 종류(매수 등)가 있는 조각이 기록이고, 없는 조각은 앞 기록의 주문시간이다.
  const segments: string[][] = [];
  for (const t of tokens) {
    if (DATETIME.test(t)) segments.push([t]);
    else if (segments.length) segments[segments.length - 1].push(t);
  }
  const rows: Record<string, string>[] = [];
  let skipped = 0;
  for (const seg of segments) {
    const typeAt = seg.findIndex((t) => TYPES.has(t));
    if (typeAt < 0) {
      // 시각만 있는 조각 = 바로 앞 기록의 주문시간
      if (rows.length && seg.length === 1 && !rows[rows.length - 1]["주문시간"]) rows[rows.length - 1]["주문시간"] = seg[0];
      else skipped++;
      continue;
    }
    const before = seg.slice(1, typeAt);
    let coin: string | undefined;
    let market: string | undefined;
    for (const t of before) {
      if (MARKETS.has(t) && coin) market = t;
      else {
        const c = coinOf(t);
        coin ??= c.coin;
        market ??= c.market;
      }
    }
    const nums = seg.slice(typeAt + 1);
    if (!coin) {
      skipped++;
      continue;
    }
    rows.push({
      체결시간: seg[0],
      코인: coin,
      마켓: market ?? "",
      종류: seg[typeAt],
      거래수량: nums[0] ?? "",
      거래단가: nums[1] ?? "",
      거래금액: nums[2] ?? "",
      수수료: nums[3] ?? "",
      정산금액: nums[4] ?? "",
      주문시간: "",
    });
  }
  if (!rows.length) return null;
  return { table: { headers: UPBIT_COLUMNS, rows }, skipped };
}

const keyOf = (coin: string) => (coin === "KRW" ? fiatAssetKey("KRW") : coin);

export const upbitHistory: CsvAdapter = {
  id: "upbit-history-paste-v1",
  exchange: "upbit",
  exchangeName: "업비트",
  formatName: "거래내역 화면 붙여넣기",
  howToExport: "업비트 웹 → 투자내역 → 거래내역 → 기간·종류(전체) 선택 → 표를 끝까지 내려 모두 불러온 뒤 마우스로 드래그(또는 Ctrl+A)해 복사 → 아래 칸에 붙여넣기",
  verified: false,

  detect: (h) => UPBIT_COLUMNS.slice(0, 5).every((c) => h.includes(c)),

  convert(table, sourceId): ImportResult {
    const entries: LedgerEntry[] = [];
    const warnings: string[] = [];
    const seen = new Map<string, number>();
    let from = Infinity;
    let to = -Infinity;
    let bad = 0;

    for (const row of table.rows) {
      const time = parseKst(row["체결시간"]);
      const coin = row["코인"].toUpperCase();
      const type = row["종류"];
      const qty = parseAmount(row["거래수량"]);
      if (Number.isNaN(time) || !qty) {
        bad++;
        continue;
      }
      from = Math.min(from, time);
      to = Math.max(to, time);
      const key = rowKey(UPBIT_COLUMNS.map((c) => row[c] ?? ""), seen);
      const id = `${sourceId}:paste:${key}`;
      const base = { sourceId, origin: "exchange" as const, location: "업비트", time, rawType: type };
      const q = new Decimal(qty);
      const fee = new Decimal(parseAmount(row["수수료"]) ?? 0).abs();

      if (type === "매수" || type === "매도") {
        const market = (row["마켓"] || "KRW").toUpperCase();
        const funds = parseAmount(row["거래금액"]);
        if (!funds) {
          bad++;
          continue;
        }
        const buy = type === "매수";
        // 같은 주문의 여러 체결을 한 거래로 묶는다 (주문시간이 없으면 체결시간)
        const groupId = `upbit:paste:${row["주문시간"] || row["체결시간"]}:${market}-${coin}:${type}`;
        const f = new Decimal(funds);
        entries.push(
          { ...base, id: `${id}:coin`, asset: coin, assetKey: keyOf(coin), amount: (buy ? q : q.neg()).toString(), kind: "trade", groupId },
          { ...base, id: `${id}:quote`, asset: market, assetKey: keyOf(market), amount: (buy ? f.neg() : f).toString(), kind: "trade", groupId },
        );
        if (!fee.isZero()) entries.push({ ...base, id: `${id}:fee`, asset: market, assetKey: keyOf(market), amount: fee.neg().toString(), kind: "fee", groupId });
      } else {
        const deposit = type === "입금";
        const groupId = `upbit:paste:${key}`;
        entries.push({ ...base, id: `${id}:${deposit ? "in" : "out"}`, asset: coin, assetKey: keyOf(coin), amount: (deposit ? q : q.neg()).toString(), kind: "transfer", groupId });
        if (!deposit && !fee.isZero()) entries.push({ ...base, id: `${id}:fee`, asset: coin, assetKey: keyOf(coin), amount: fee.neg().toString(), kind: "fee", groupId });
      }
    }

    if (bad) warnings.push(`${bad}줄은 수량·금액·시각을 읽지 못해 건너뛰었습니다.`);
    if (entries.some((e) => e.kind === "transfer" && e.assetKey !== fiatAssetKey("KRW"))) {
      warnings.push("화면 내역에는 블록체인 거래 번호가 없어, 내 지갑·해외 거래소로 보낸 출금은 분류 검토에서 직접 '내 계정 간 이체'로 확인해야 합니다.");
    }
    return { entries, warnings, unknownTypes: [], range: entries.length ? { from, to } : null, rowCount: table.rows.length };
  },
};
