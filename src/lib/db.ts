import Dexie, { type EntityTable, type Table } from "dexie";

// 모든 사용자 데이터는 브라우저 IndexedDB에만 저장된다. 서버로 전송하지 않는다.

export type SourceKind = "binance" | "okx" | "evm";

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

export type Source = BinanceSource | OkxSource | EvmSource;
export type ExchangeSource = BinanceSource | OkxSource;

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

export interface Setting {
  key: string;
  value: string;
}

export const db = new Dexie("crypto-tax-engine") as Dexie & {
  // EntityTable은 유니언 타입의 구분을 잃어버리므로 Table을 쓴다.
  sources: Table<Source, string>;
  snapshots: EntityTable<Snapshot, "id">;
  settings: EntityTable<Setting, "key">;
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

export async function getSetting(key: string): Promise<string | undefined> {
  return (await db.settings.get(key))?.value;
}

export async function setSetting(key: string, value: string) {
  await db.settings.put({ key, value });
}
