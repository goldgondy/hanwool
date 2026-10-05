import Decimal from "@/lib/decimal";
import { db, type XrpSource } from "@/lib/db";
import { buildXrpEntries, currencyName, LOCKING_TYPES, XRP_NATIVE_KEY, xrpTokenKey } from "@/lib/ledger/xrp-build";
import { XrplError, XrplRpc } from "@/lib/xrp/rpc";
import type { RawBalance } from "@/lib/sources/types";

// 증분 동기화 상태 (syncState `${id}:xrp`): 다음에 조회할 원장 번호
interface XrpState {
  minLedger: number;
}

export interface XrpSyncResult {
  added: number;
  warnings: string[];
}

export async function syncXrpHistory(source: XrpSource, onProgress: (msg: string) => void = () => {}, rpc = new XrplRpc()): Promise<XrpSyncResult> {
  const stateKey = `${source.id}:xrp`;
  const saved = await db.syncState.get(stateKey);
  const state: XrpState = saved ? JSON.parse(saved.cursor) : { minLedger: -1 };
  const { entries, warnings, next } = await collectXrp(rpc, source.id, source.address, state.minLedger, onProgress);

  const existing = await db.ledger.bulkGet(entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(entries);
    await db.syncState.put({ key: stateKey, cursor: JSON.stringify({ minLedger: next } satisfies XrpState), syncedAt: Date.now() });
  });
  return { added: existing.filter((x) => !x).length, warnings };
}

// 저장소와 무관한 수집 단계 (실데이터 테스트에서도 쓴다)
export async function collectXrp(rpc: XrplRpc, sourceId: string, address: string, minLedger: number, onProgress: (msg: string) => void = () => {}) {
  const warnings: string[] = [];
  rpc.onWait ??= (s) => onProgress(`XRP 서버 호출 한도로 ${s}초 기다리는 중`);
  let txs;
  try {
    txs = await rpc.accountTx(address, minLedger, (n) => onProgress(`XRP 거래 조회 중 (${n}건)`));
  } catch (e) {
    if (e instanceof XrplError && e.code === "actNotFound") return { entries: [], warnings: ["아직 활성화되지 않은 XRP 주소입니다 (거래 기록 없음)."], next: minLedger };
    throw e;
  }
  const entries = buildXrpEntries({ sourceId, address, txs });
  const locking = txs.filter((t) => LOCKING_TYPES.has(t.type)).length;
  if (locking) warnings.push(`에스크로·결제 채널·수표 거래 ${locking}건이 있습니다. 묶인 XRP도 내 자산이라 잔고 대사에서 차이로 보일 수 있습니다.`);
  const next = txs.length ? Math.max(...txs.map((t) => t.ledgerIndex)) + 1 : minLedger;
  return { entries, warnings, next };
}

export async function fetchXrpBalances(source: XrpSource): Promise<RawBalance[]> {
  return xrpBalances(new XrplRpc(), source.address);
}

// 실제 잔고: XRP(지급 준비금 포함, 원장도 같은 기준) + 신뢰선 토큰
export async function xrpBalances(rpc: XrplRpc, address: string): Promise<RawBalance[]> {
  const out: RawBalance[] = [];
  let info;
  try {
    info = await rpc.call<{ account_data: { Balance: string } }>("account_info", { account: address, ledger_index: "validated" });
  } catch (e) {
    if (e instanceof XrplError && e.code === "actNotFound") return out;
    throw e;
  }
  const xrp = new Decimal(info.account_data.Balance).div(1_000_000);
  if (!xrp.isZero()) out.push({ location: "XRP Ledger", asset: "XRP", rawAsset: "XRP", assetKey: XRP_NATIVE_KEY, amount: xrp });
  let marker: unknown;
  do {
    const r = await rpc.call<{ lines: { account: string; currency: string; balance: string }[]; marker?: unknown }>("account_lines", {
      account: address,
      ledger_index: "validated",
      limit: 400,
      ...(marker ? { marker } : {}),
    });
    for (const l of r.lines) {
      const amount = new Decimal(l.balance);
      if (amount.isZero()) continue;
      out.push({ location: "XRP Ledger", asset: currencyName(l.currency), rawAsset: `${l.currency}.${l.account}`, assetKey: xrpTokenKey(l.currency, l.account), amount });
    }
    marker = r.marker;
  } while (marker);
  return out;
}
