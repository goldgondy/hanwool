import Dexie, { type EntityTable, type Table } from "dexie";
import type { Decision } from "@/lib/classify/types";

// 모든 사용자 데이터는 브라우저 IndexedDB에만 저장된다. 서버로 전송하지 않는다.

export type SourceKind = "binance" | "okx" | "xapi" | "evm" | "btc" | "csv";

// AES-GCM 암호문. 복호화는 lib/vault.ts 참고.
export interface EncryptedBlob {
  iv: string; // base64
  ct: string; // base64
}

export interface BinanceSource {
  id: string;
  kind: "binance";
  label: string;
  apiKey: string;
  encSecret: EncryptedBlob;
  createdAt: number;
}

export interface OkxSource {
  id: string;
  kind: "okx";
  label: string;
  apiKey: string;
  encSecret: EncryptedBlob;
  encPassphrase: EncryptedBlob;
  createdAt: number;
}

export interface EvmSource {
  id: string;
  kind: "evm";
  label: string;
  address: string;
  chains: EvmChain[];
  createdAt: number;
}

export interface BtcSource {
  id: string;
  kind: "btc";
  label: string;
  input: string; // 주소, xpub/ypub/zpub, 또는 디스크립터 (lib/btc/descriptor.ts)
  scriptType?: "p2pkh" | "p2sh-p2wpkh" | "p2wpkh" | "p2tr"; // xpub만 입력한 경우 사용자가 고른 주소 형식
  gapLimit: number;
  esploraUrl: string; // mempool.space 또는 개인 노드
  createdAt: number;
}

// 거래소 CSV로 가져온 계정. 같은 거래소 파일을 여러 번 올려도 중복 없이 합쳐진다.
export interface CsvSource {
  id: string;
  kind: "csv";
  label: string;
  exchange: string; // 변환기 거래소 ID (lib/importers)
  imports: { at: number; fileName: string; format: string; rows: number; added: number }[];
  createdAt: number;
}

// 그 밖의 거래소 API 계정 (바이비트, 비트겟, MEXC, 게이트). lib/sources/exchanges.ts
export interface XapiSource {
  id: string;
  kind: "xapi";
  exchange: "bybit" | "bitget" | "mexc" | "gate" | "coinbase";
  label: string;
  apiKey: string;
  encSecret: EncryptedBlob;
  encPassphrase?: EncryptedBlob; // 비트겟
  createdAt: number;
}

export type Source = BinanceSource | OkxSource | XapiSource | EvmSource | BtcSource | CsvSource;
export type ExchangeSource = BinanceSource | OkxSource | XapiSource;
export const isExchangeKind = (kind: SourceKind) => kind === "binance" || kind === "okx" || kind === "xapi";

export type EvmChain = "eth" | "arb" | "base" | "opt" | "polygon";

export interface Holding {
  sourceId: string;
  sourceLabel: string;
  location: string; // "Binance Spot", "Ethereum" 등
  asset: string; // 정규화된 심볼 (예: BTC)
  rawAsset: string; // 원본 표기 (예: LDBTC, 컨트랙트 주소)
  amount: string; // Decimal 문자열
  priceKrw: string | null;
  priceVia: string | null; // 가격 출처 (대체 가격이면 표시)
  valueKrw: string | null;
}

export interface Snapshot {
  id: string;
  takenAt: number;
  priceSource: string;
  holdings: Holding[];
  totalKrw: string;
  errors: { sourceLabel: string; message: string }[];
  note?: string;
}

// 원장: 계정별 자산 이동 한 건. 수량은 부호 있음 (+ 입금, - 출금).
export type LedgerKind =
  | "trade" // 같은 그룹에 들어오고 나가는 자산이 함께 있음 (스왑 등)
  | "transfer" // 한 방향 이동 (입금 또는 출금). 본인 계정 간 이체인지는 매칭 단계에서 판단
  | "fee" // 가스비, 거래 수수료
  | "income" // 보상, 에어드랍 등 (분류 확정된 경우)
  | "other";

export interface LedgerEntry {
  id: string; // 원본 데이터에서 결정적으로 생성 → 재동기화해도 중복되지 않음
  sourceId: string;
  location: string; // "Ethereum", "Binance" 등
  time: number;
  asset: string; // 표시용 심볼
  assetKey: string; // 대사용 식별자 (RawBalance.assetKey와 같은 규칙)
  amount: string; // Decimal 문자열, 부호 있음
  kind: LedgerKind;
  groupId: string; // 같은 트랜잭션/주문의 항목끼리 묶음
  txHash?: string;
  counterparty?: string; // 상대 주소
  // 기록 출처. 거래소 체결·보상 기록은 추정이 아니므로 분류를 확정한다 (분류 규칙 R1–R3). 없으면 블록체인.
  origin?: "chain" | "exchange";
  // 거래소가 명시한 성격 (예: reward, airdrop). 분류 규칙에서 쓴다.
  tag?: "reward" | "airdrop";
  // 원본 기록의 유형 이름 (예: 바이낸스 "Transaction Buy"). 검토 화면 표시용.
  rawType?: string;
}

export interface SyncState {
  key: string; // `${sourceId}:${scope}`
  cursor: string; // 예: 마지막으로 가져온 블록 번호
  syncedAt: number;
}

export interface Setting {
  key: string;
  value: string;
}

export const db = new Dexie("crypto-tax-engine") as Dexie & {
  // EntityTable은 유니언 타입의 구분을 잃어버리므로 Table을 쓴다.
  sources: Table<Source, string>;
  snapshots: EntityTable<Snapshot, "id">;
  settings: EntityTable<Setting, "key">;
  ledger: EntityTable<LedgerEntry, "id">;
  syncState: EntityTable<SyncState, "key">;
  decisions: EntityTable<Decision, "key">;
};

db.version(1).stores({
  sources: "id, kind, createdAt",
  snapshots: "id, takenAt",
  settings: "key",
});

// v2: 거래소 Secret 암호화. 평문으로 저장된 v1 바이낸스 키는 삭제하고 다시 등록받는다.
db.version(2)
  .stores({
    sources: "id, kind, createdAt",
    snapshots: "id, takenAt",
    settings: "key",
  })
  .upgrade((tx) =>
    tx
      .table("sources")
      .filter((s) => s.kind === "binance" && "apiSecret" in s)
      .delete(),
  );

// v3: 원장
db.version(3).stores({
  sources: "id, kind, createdAt",
  snapshots: "id, takenAt",
  settings: "key",
  ledger: "id, sourceId, time, groupId, [sourceId+assetKey]",
  syncState: "key",
});

// v4: EVM 데이터 소스를 Alchemy → Blockscout으로 교체. 항목 ID 규칙이 바뀌어 원장을 다시 동기화한다.
db.version(4)
  .stores({
    sources: "id, kind, createdAt",
    snapshots: "id, takenAt",
    settings: "key",
    ledger: "id, sourceId, time, groupId, [sourceId+assetKey]",
    syncState: "key",
  })
  .upgrade(async (tx) => {
    await tx.table("ledger").clear();
    await tx.table("syncState").clear();
    await tx.table("settings").delete("alchemyKey");
  });

// v5: 사용자 분류 결정 (docs/classification.md §7). 원장과 따로 저장해 재동기화해도 유지된다.
db.version(5).stores({
  sources: "id, kind, createdAt",
  snapshots: "id, takenAt",
  settings: "key",
  ledger: "id, sourceId, time, groupId, [sourceId+assetKey]",
  syncState: "key",
  decisions: "key",
});

export async function getSetting(key: string): Promise<string | undefined> {
  return (await db.settings.get(key))?.value;
}

export async function setSetting(key: string, value: string) {
  await db.settings.put({ key, value });
}
