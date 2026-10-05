import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vitest";
import { buildBtcEntries } from "@/lib/ledger/btc-build";
import { deriveAddress, parseWalletInput } from "./descriptor";

const seed = new Uint8Array(32).fill(7);
const account = HDKey.fromMasterSeed(seed).derive("m/84'/2'/0'");
const ext = (pub: number) => new HDKey({ versions: { public: pub, private: 0 }, depth: account.depth, index: account.index, parentFingerprint: account.parentFingerprint, chainCode: account.chainCode!, publicKey: account.publicKey! }).publicExtendedKey;

describe("라이트코인", () => {
  it("Ltub → L 주소, Mtub → M 주소, zpub(라이트코인으로) → ltc1q 주소", () => {
    const ltub = parseWalletInput(ext(0x019da462), undefined, "ltc");
    const mtub = parseWalletInput(ext(0x01b26ef6), undefined, "ltc");
    const zpub = parseWalletInput(ext(0x04b24746), undefined, "ltc");
    if (ltub.kind !== "hd" || mtub.kind !== "hd" || zpub.kind !== "hd") throw new Error("hd 아님");
    expect(deriveAddress(ltub, 0, 0)).toMatch(/^L/);
    expect(deriveAddress(mtub, 0, 0)).toMatch(/^M/);
    expect(deriveAddress(zpub, 0, 0)).toMatch(/^ltc1q/);
    // 같은 키라도 비트코인으로 해석하면 bc1q
    const btc = parseWalletInput(ext(0x04b24746));
    if (btc.kind !== "hd") throw new Error("hd 아님");
    expect(deriveAddress(btc, 0, 0)).toMatch(/^bc1q/);
  });

  it("주소 검사: 라이트코인 지갑에 비트코인 주소를 넣으면 거절", () => {
    const z = parseWalletInput(ext(0x04b24746), undefined, "ltc");
    if (z.kind !== "hd") throw new Error("hd 아님");
    const ltcAddr = deriveAddress(z, 0, 1);
    expect(parseWalletInput(ltcAddr, undefined, "ltc")).toEqual({ kind: "address", address: ltcAddr });
    expect(() => parseWalletInput("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", undefined, "ltc")).toThrow("라이트코인");
  });

  it("원장은 LTC·ltc:native·ltc:<txid>로 기록", () => {
    const { entries } = buildBtcEntries({
      sourceId: "s",
      coin: "ltc",
      addresses: new Set(["ltc1qme"]),
      txs: [{ txid: "ab".repeat(32), fee: 1000, status: { confirmed: true, block_time: 1 }, vin: [{ prevout: { scriptpubkey_address: "ltc1qother", value: 200_000_000 } }], vout: [{ scriptpubkey_address: "ltc1qme", value: 150_000_000 }] }] as never,
    });
    expect(entries.map((e) => [e.asset, e.assetKey, e.groupId.split(":")[0], e.amount])).toEqual([["LTC", "ltc:native", "ltc", "1.5"]]);
  });
});
