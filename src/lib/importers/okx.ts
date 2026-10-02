import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import { rowKey } from "./csv";
import type { CsvAdapter, ImportResult } from "./types";

// OKX 계정 내역 파일 (OKX → 자산 → 주문 센터/거래 내역 → 내역 다운로드, CSV).
// 첫 줄: "UID:… · Account Type:… · Time Zone:UTC+8", 둘째 줄이 열 이름이다.
// 열: id · Order id · Time · Trade Type · Symbol · Action · Amount · Trading Unit · Filled Price · PnL · Fee · Fee Unit ·
//     Position Change · Position Balance · Balance Change · Balance · Balance Unit
// 2026-10-02 세무사 제공 거래 계정 샘플(화면 캡처)로 확인한 규칙:
//   한 줄 = 한 코인의 잔고 변동. Balance Change(부호 있음)가 Balance Unit 코인의 실제 변동이고 수수료가 포함되어 있다.
//   예) 매수 체결은 두 줄: Buy(BTC +0.001646, 수수료 −0.0000017 BTC 포함) + Sell(USDT −133.268)
//   Transfer in/out = 같은 OKX 안의 자금 계정 ↔ 거래 계정 이동 (API 연결과 같게 원장에서 뺀다)
// 입금·출금은 자금 계정(Funding) 내역에 있다. 그 파일 형식은 아직 샘플이 없어 같은 열이라고 가정한다.

const TRADE = /^(spot|margin|convert|easy convert|small assets? convert|dust)/;
const INTERNAL = /^transfer$/;
const DERIVATIVE = /futures|perpetual|swap|option|delivery|funding fee|liquidation|adl|settlement|expiry/;
const DEPOSIT = /^deposit/;
const WITHDRAW = /^withdraw/;
const REWARD = /reward|bonus|rebate|airdrop|earn|staking|savings|interest|dividend|distribution|cashback|commission/;

// "1,234.5", "-1.7E-06", "", "--" → Decimal 또는 null
function num(s: string | undefined): Decimal | null {
  const t = (s ?? "").replace(/,/g, "").trim();
  if (!t || !/\d/.test(t)) return null;
  try {
    return new Decimal(t);
  } catch {
    return null;
  }
}

const sig = (d: Decimal | null) => (d ? d.toSignificantDigits(6).toString() : "");

// 첫 줄의 "Time Zone:UTC+8" → 분 단위 시차. 없으면 null (OKX 기본값 UTC+8로 본다)
export function okxOffsetMinutes(preamble: string[] | undefined): number | null {
  const m = (preamble ?? []).join(" ").match(/UTC\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i);
  if (!m) return /UTC(?![+-\d])/i.test((preamble ?? []).join(" ")) ? 0 : null;
  return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +(m[3] ?? 0));
}

// "2026-05-11 21:37:12" (파일 시간대) → 밀리초
export function parseLocal(s: string, offsetMin: number): number {
  const m = s.trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se ?? 0)) - offsetMin * 60_000;
}

export const okxHistory: CsvAdapter = {
  id: "okx-account-history-v1",
  exchange: "okx",
  exchangeName: "OKX",
  formatName: "계정 내역 (Trading/Funding account history)",
  howToExport:
    "OKX 웹 → 자산(Assets) → 주문 센터·내역(Order center / Bills) → 거래 계정(Trading account) 내역 → 다운로드(최대 1년씩). 입금·출금은 자금 계정(Funding account) 내역에 따로 있으니 그것도 받아 올리세요.",
  verified: false,

  detect: (h) => ["Time", "Trade Type", "Action", "Balance Change", "Balance Unit"].every((c) => h.includes(c)),

  convert(table, sourceId): ImportResult {
    const entries: LedgerEntry[] = [];
    const warnings: string[] = [];
    const unknown = new Set<string>();
    const seen = new Map<string, number>();
    let from = Infinity;
    let to = -Infinity;
    let bad = 0;
    let internal = 0;
    let derivatives = 0;

    const offset = okxOffsetMinutes(table.preamble);
    if (offset === null) warnings.push("파일 첫 줄에서 시간대를 찾지 못해 OKX 기본값(UTC+8)으로 읽었습니다.");
    const off = offset ?? 480;
    const pre = (table.preamble ?? []).join(" ");
    const location = /funding/i.test(pre) ? "OKX 펀딩 계정" : "OKX 거래 계정";

    for (const row of table.rows) {
      const time = parseLocal(row["Time"] ?? "", off);
      const typeRaw = (row["Trade Type"] ?? "").trim();
      const type = typeRaw.toLowerCase();
      const action = (row["Action"] ?? "").trim();
      const change = num(row["Balance Change"]);
      const coin = (row["Balance Unit"] ?? "").trim().toUpperCase();
      if (Number.isNaN(time) || !typeRaw || !coin || !change) {
        bad++;
        continue;
      }
      if (change.isZero()) continue;
      if (INTERNAL.test(type)) {
        internal++;
        continue;
      }
      from = Math.min(from, time);
      to = Math.max(to, time);
      const fee = num(row["Fee"]);
      const feeUnit = (row["Fee Unit"] ?? "").trim().toUpperCase() || coin;

      // 같은 기록인지는 내용으로만 판단한다: 시각(분 단위)·종류·코인·잔고 변동·수수료(유효숫자 6자리).
      // 주문번호·행 번호는 빼서, 원본 CSV와 엑셀에서 다시 저장한 파일(초·자릿수가 잘림)을 섞어 올려도 같은 기록으로 알아본다.
      // 같은 파일 안에서 내용이 똑같은 기록이 여러 개면 rowKey가 순번을 붙여 구분한다.
      const key = rowKey([String(Math.floor(time / 60_000)), type, action.toLowerCase(), coin, sig(change), sig(fee), feeUnit], seen);
      const id = `${sourceId}:file:${key}`;
      const rawType = action ? `${typeRaw} ${action}` : typeRaw;
      const base = { sourceId, origin: "exchange" as const, location, time, asset: coin, assetKey: coin, rawType };

      if (TRADE.test(type)) {
        // 같은 주문의 체결(코인 +, 대금 −)을 한 거래로 묶는다. 엑셀이 주문번호를 "3.56E+18"로 줄였으면 시각으로 묶는다.
        const ord = (row["Order id"] ?? "").trim();
        const symbol = (row["Symbol"] ?? "").trim();
        const groupId = ord && /^\d+$/.test(ord) ? `okx:ord:${ord}` : `okx:file:${time}:${symbol}`;
        // Balance Change에는 수수료가 포함되어 있다 → 거래분과 수수료를 나눈다 (API의 balChg − fee와 같은 방식)
        const split = fee && fee.isNegative() && feeUnit === coin;
        entries.push({ ...base, id: `${id}:trade`, amount: (split ? change.minus(fee) : change).toString(), kind: "trade", groupId });
        if (split) entries.push({ ...base, id: `${id}:fee`, amount: fee.toString(), kind: "fee", groupId, rawType: `${rawType} fee` });
        continue;
      }

      const groupId = `okx:file:${key}`;
      if (DEPOSIT.test(type) || WITHDRAW.test(type)) {
        const out = WITHDRAW.test(type);
        // 출금 수수료가 잔고 변동에 포함되어 있으면 나눈다
        const split = out && fee && !fee.isZero() && feeUnit === coin;
        const feeAmt = split ? fee.abs().neg() : null;
        entries.push({ ...base, id: `${id}:${out ? "out" : "in"}`, amount: (feeAmt ? change.minus(feeAmt) : change).toString(), kind: "transfer", groupId });
        if (feeAmt) entries.push({ ...base, id: `${id}:fee`, amount: feeAmt.toString(), kind: "fee", groupId, rawType: `${rawType} fee` });
        continue;
      }
      if (DERIVATIVE.test(type)) {
        derivatives++;
        entries.push({ ...base, id: `${id}:other`, amount: change.toString(), kind: "other", groupId });
        continue;
      }
      if (REWARD.test(type) || REWARD.test(action.toLowerCase())) {
        if (change.isPositive()) {
          entries.push({ ...base, id: `${id}:in`, amount: change.toString(), kind: "income", tag: /airdrop/i.test(rawType) ? "airdrop" : "reward", groupId });
        } else {
          entries.push({ ...base, id: `${id}:fee`, amount: change.toString(), kind: "fee", groupId }); // 대출 이자 등 비용
        }
        continue;
      }
      unknown.add(typeRaw);
      entries.push({ ...base, id: `${id}:other`, amount: change.toString(), kind: "other", groupId });
    }

    if (bad) warnings.push(`${bad}줄은 시각·종류·잔고 변동을 읽지 못해 건너뛰었습니다.`);
    if (internal) {
      warnings.push(
        `자금 계정 ↔ 거래 계정 이동 ${internal}건은 같은 OKX 안의 이동이라 뺐습니다. 외부 입금·출금은 자금 계정(Funding) 내역에 있으니, 그 파일도 올리거나 OKX API를 연결해 ‘같은 계정’으로 묶으세요.`,
      );
    }
    if (derivatives) warnings.push(`선물·파생상품 기록 ${derivatives}건은 과세 여부 검토가 필요해 미분류로 두고 세금 계산에서 제외했습니다.`);
    return { entries, warnings, unknownTypes: [...unknown], range: entries.length ? { from, to } : null, rowCount: table.rows.length };
  },
};
