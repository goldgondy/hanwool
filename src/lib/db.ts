import Dexie, { type EntityTable, type Table } from "dexie";
import type { Decision } from "@/lib/classify/types";

// 모든 사용자 데이터는 브라우저 IndexedDB에만 저장된다. 서버로 전송하지 않는다.

export type SourceKind = "binance" | "okx" | "xapi" | "evm" | "btc" | "tron" | "solana" | "csv" | "manual";

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
  input: string; // 주소, xpub/ypub/zpub, 또는 디스크립터 (lib/btc/descriptor.ts). xpub을 지웠으면 ""
  // xpub을 지우고 남긴 주소 목록. 있으면 이 주소들만 조회한다 (새로 생긴 주소는 찾지 못함)
  frozenAddresses?: string[];
  frozenAt?: number; // xpub을 지운 시각. 이후 보낸 거래는 거스름돈 주소를 몰라 외부 송금으로 잘못 잡힐 수 있다
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
  // 같은 거래소 계정의 API 연결. 연결되면 CSV가 덮는 기간은 CSV를, 그 밖은 API 내역을 쓰고 (lib/ledger/dedup.ts),
  // 잔고는 API 실시간 잔고만 쓴다.
  linkedSourceId?: string;
  createdAt: number;
}

// 그 밖의 거래소 API 계정 (바이비트, 비트겟, MEXC, 게이트). lib/sources/exchanges.ts
export interface XapiSource {
  id: string;
  kind: "xapi";
  exchange: "bybit" | "bitget" | "mexc" | "gate" | "coinbase" | "upbit" | "bithumb";
  label: string;
  apiKey: string;
  encSecret: EncryptedBlob;
  encPassphrase?: EncryptedBlob; // 비트겟
  createdAt: number;
}

// 트론 지갑 (TronLink, 트러스트 월렛 등). lib/ledger/tron-sync.ts
export interface TronSource {
  id: string;
  kind: "tron";
  label: string;
  address: string; // Base58 ("T…")
  createdAt: number;
}

// 솔라나 지갑 (팬텀, 솔플레어 등). lib/ledger/solana-sync.ts
export interface SolanaSource {
  id: string;
  kind: "solana";
  label: string;
  address: string; // Base58
  createdAt: number;
}

// 직접 입력한 거래 (연결할 수 없는 거래소·오래된 거래·2026년 말 보유분). lib/manual.ts
export interface ManualSource {
  id: string;
  kind: "manual";
  label: string;
  createdAt: number;
}

export type Source = BinanceSource | OkxSource | XapiSource | EvmSource | BtcSource | TronSource | SolanaSource | CsvSource | ManualSource;
export type ExchangeSource = BinanceSource | OkxSource | XapiSource;
export const isExchangeKind = (kind: SourceKind) => kind === "binance" || kind === "okx" || kind === "xapi";

// 거래소 ID (CSV 변환기의 exchange와 같은 이름). 거래소 계정이 아니면 null.
export function exchangeIdOf(s: Source): string | null {
  if (s.kind === "binance" || s.kind === "okx") return s.kind;
  if (s.kind === "xapi" || s.kind === "csv") return s.exchange;
  return null;
}

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
  origin?: "chain" | "exchange" | "manual"; // manual: 잔고 대사 조정 등 사용자가 추가한 항목
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

// 계정별 최근 잔고 대사 결과 (lib/reconcile)
export interface ReconciliationRecord {
  key: string; // 계정 키 (대표 계정 ID)
  label: string;
  memberIds: string[]; // 대사에 포함한 계정 (대표 + 연결된 CSV)
  at: number;
  status: "ok" | "no_history" | "error";
  error?: string;
  rows: { assetKey: string; asset: string; location: string; ledger: string; actual: string; diff: string }[];
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
  reconciliations: EntityTable<ReconciliationRecord, "key">;
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

// v6: 잔고 대사 결과
db.version(6).stores({
  sources: "id, kind, createdAt",
  snapshots: "id, takenAt",
  settings: "key",
  ledger: "id, sourceId, time, groupId, [sourceId+assetKey]",
  syncState: "key",
  decisions: "key",
  reconciliations: "key",
});

export async function getSetting(key: string): Promise<string | undefined> {
  return (await db.settings.get(key))?.value;
}

export async function setSetting(key: string, value: string) {
  await db.settings.put({ key, value });
}
