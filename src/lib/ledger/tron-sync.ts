import Decimal from "@/lib/decimal";
import { db, getSetting, type TronSource } from "@/lib/db";
import { buildTronEntries, TRON_NATIVE_KEY, tronTokenKey } from "@/lib/ledger/tron-build";
import type { RawBalance } from "@/lib/sources/types";
import { toBase58 } from "@/lib/tron/address";
import { TronGrid, type Trc20Transfer, type TronTx } from "@/lib/tron/trongrid";

const DAY = 86_400_000;

// 주요 TRC20 토큰의 소수점 자릿수 (모르는 토큰은 컨트랙트에 직접 묻는다)
const KNOWN_DECIMALS: Record<string, number> = {
  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: 6, // USDT
  TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: 6, // USDC
  TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR: 6, // WTRX
};

async function grid() {
  return new TronGrid((await getSetting("trongridKey")) || undefined);
}

export interface TronSyncResult {
  added: number;
  unknownTypes: string[];
  warnings: string[];
}

export async function syncTronHistory(source: TronSource, onProgress: (msg: string) => void = () => {}): Promise<TronSyncResult> {
  const g = await grid();
  const stateKey = `${source.id}:tron`;
  const last = Number((await db.syncState.get(stateKey))?.cursor ?? 0);
  const min = last ? `&min_timestamp=${last - DAY}` : ""; // 마지막 동기화 하루 전부터 (결정적 ID로 중복 없음)
  const now = Date.now();

  const txs = await g.pages<TronTx>(`/v1/accounts/${source.address}/transactions?limit=200&only_confirmed=true${min}`, (n) =>
    onProgress(`트론 거래 조회 중 (${n}건)`),
  );
  const trc20 = await g.pages<Trc20Transfer>(`/v1/accounts/${source.address}/transactions/trc20?limit=200&only_confirmed=true${min}`, (n) =>
    onProgress(`트론 토큰 전송 조회 중 (${n}건)`),
  );

  // 투표 보상 수령액은 거래 목록에 없어 거래 정보에서 받아 온다
  const rewardAmounts: Record<string, number> = {};
  for (const t of txs) {
    const c = t.raw_data?.contract?.[0];
    if (c?.type === "WithdrawBalanceContract" && toBase58(String(c.parameter.value.owner_address)) === source.address) {
      const info = await g.post<{ withdraw_amount?: number }>("/wallet/gettransactioninfobyid", { value: t.txID });
      rewardAmounts[t.txID] = info.withdraw_amount ?? 0;
    }
  }

  const built = buildTronEntries({ sourceId: source.id, address: source.address, txs, trc20, rewardAmounts });
  const existing = await db.ledger.bulkGet(built.entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(built.entries);
    await db.syncState.put({ key: stateKey, cursor: String(now), syncedAt: now });
  });

  const warnings: string[] = [];
  if (built.skipped) warnings.push(`0원·형식 불명 토큰 전송 ${built.skipped}건은 건너뛰었습니다 (주소 오염 사기 전송 등).`);
  return { added: existing.filter((x) => !x).length, unknownTypes: built.unknownTypes, warnings };
}

async function decimalsOf(g: TronGrid, contract: string): Promise<number | null> {
  if (KNOWN_DECIMALS[contract] != null) return KNOWN_DECIMALS[contract];
  try {
    const r = await g.post<{ constant_result?: string[] }>("/wallet/triggerconstantcontract", {
      owner_address: contract,
      contract_address: contract,
      function_selector: "decimals()",
      visible: true,
    });
    const hex = r.constant_result?.[0];
    return hex ? parseInt(hex, 16) : null;
  } catch {
    return null;
  }
}

// 실제 잔고: TRX는 일반 잔고 + 동결분 + 해제 대기분, TRC20은 계정 정보의 토큰 잔고
export async function fetchTronBalances(source: TronSource): Promise<RawBalance[]> {
  // 심볼은 원장에 기록된 이름을 쓴다 (계정 정보에는 컨트랙트 주소만 있음)
  const symbols = new Map<string, string>();
  for (const e of await db.ledger.where("sourceId").equals(source.id).toArray()) symbols.set(e.assetKey, e.asset);
  return tronBalances(await grid(), source.address, symbols);
}

export async function tronBalances(g: TronGrid, address: string, symbols: Map<string, string>): Promise<RawBalance[]> {
  const acc = await g.account(address);
  if (!acc) return [];
  const out: RawBalance[] = [];

  const sunTotal =
    (acc.balance ?? 0) +
    (acc.frozenV2 ?? []).reduce((s, f) => s + (f.amount ?? 0), 0) +
    (acc.unfrozenV2 ?? []).reduce((s, u) => s + (u.unfreeze_amount ?? 0), 0);
  const trx = new Decimal(sunTotal).div(1_000_000);
  if (!trx.isZero()) out.push({ location: "Tron", asset: "TRX", rawAsset: "TRX", assetKey: TRON_NATIVE_KEY, amount: trx });

  for (const entry of acc.trc20 ?? []) {
    for (const [contract, raw] of Object.entries(entry)) {
      if (!raw || raw === "0") continue;
      const decimals = await decimalsOf(g, contract);
      if (decimals == null) continue;
      const key = tronTokenKey(contract);
      out.push({
        location: "Tron",
        asset: symbols.get(key) ?? (contract === "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" ? "USDT" : contract.slice(0, 6)),
        rawAsset: contract,
        assetKey: key,
        amount: new Decimal(raw).div(new Decimal(10).pow(decimals)),
      });
    }
  }

  // TRC10은 원장과 같게 소수점 없이 원시 수량으로 비교한다
  for (const { key: id, value } of acc.assetV2 ?? []) {
    if (!value) continue;
    out.push({ location: "Tron", asset: `TRC10-${id}`, rawAsset: id, assetKey: `tron:trc10:${id}`, amount: new Decimal(value) });
  }
  return out;
}
