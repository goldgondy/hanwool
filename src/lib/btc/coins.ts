import { NETWORK } from "@scure/btc-signer";

// 비트코인과 같은 구조(UTXO)의 코인. 주소 형식·확장 공개키 버전·조회 서버만 다르고 나머지 코드는 같다.

export type UtxoCoin = "btc" | "ltc";

interface CoinConfig {
  symbol: string;
  location: string; // 원장 위치 이름
  assetKey: string;
  network: typeof NETWORK;
  esplora: string; // 기본 Esplora 서버 (CORS 허용)
  txUrl: string; // 거래 보기 주소 (끝에 txid)
  // 이 코인 전용 확장 공개키 버전 (xpub·ypub·zpub는 모든 코인에서 받는다. 지갑 앱이 비트코인 형식으로 내보내는 경우가 많다)
  extraVersions: Record<string, { public: number; private: number; script: "p2pkh" | "p2sh-p2wpkh" | "p2wpkh" }>;
  addressHint: string;
}

export const UTXO_COINS: Record<UtxoCoin, CoinConfig> = {
  btc: {
    symbol: "BTC",
    location: "Bitcoin",
    assetKey: "btc:native",
    network: NETWORK,
    esplora: "https://mempool.space/api",
    txUrl: "https://mempool.space/tx/",
    extraVersions: {},
    addressHint: "zpub6r… / wpkh([…]xpub…/<0;1>/*) / bc1q…",
  },
  ltc: {
    symbol: "LTC",
    location: "Litecoin",
    assetKey: "ltc:native",
    network: { bech32: "ltc", pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 },
    esplora: "https://litecoinspace.org/api",
    txUrl: "https://litecoinspace.org/tx/",
    // SLIP-132 라이트코인 메인넷
    extraVersions: {
      Ltub: { public: 0x019da462, private: 0x019d9cfe, script: "p2pkh" },
      Mtub: { public: 0x01b26ef6, private: 0x01b26792, script: "p2sh-p2wpkh" },
    },
    addressHint: "Ltub… / zpub… / ltc1q… / L… / M…",
  },
};

export const coinOf = (c?: UtxoCoin) => UTXO_COINS[c ?? "btc"];
