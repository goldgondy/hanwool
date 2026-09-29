import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { describe, expect, it } from "vitest";
import { deriveAddress, parseWalletInput, WalletInputError, type ParsedWallet } from "./descriptor";

// BIP44/49/84/86 문서의 공식 테스트 벡터 니모닉
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));

// 계정 키를 SLIP-132 버전으로 내보낸다 (지갑 앱이 보여 주는 형태)
function accountKey(path: string, version: number) {
  const acct = root.derive(path);
  return new HDKey({
    versions: { public: version, private: 0 },
    depth: acct.depth,
    index: acct.index,
    parentFingerprint: acct.parentFingerprint,
    chainCode: acct.chainCode!,
    publicKey: acct.publicKey!,
  }).publicExtendedKey;
}

const XPUB44 = accountKey("m/44'/0'/0'", 0x0488b21e);
const YPUB49 = accountKey("m/49'/0'/0'", 0x049d7cb2);
const ZPUB84 = accountKey("m/84'/0'/0'", 0x04b24746);
const XPUB84 = accountKey("m/84'/0'/0'", 0x0488b21e);
const XPUB86 = accountKey("m/86'/0'/0'", 0x0488b21e);

const hd = (w: ParsedWallet) => {
  if (w.kind !== "hd") throw new Error("expected hd");
  return w;
};

describe("BIP 테스트 벡터와 주소 일치", () => {
  it("BIP84 zpub → bc1q", () => {
    expect(ZPUB84).toBe(
      "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs",
    );
    const w = hd(parseWalletInput(ZPUB84));
    expect(w.scriptType).toBe("p2wpkh");
    expect(deriveAddress(w, 0, 0)).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(deriveAddress(w, 0, 1)).toBe("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
    expect(deriveAddress(w, 1, 0)).toBe("bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
  });

  it("BIP49 ypub → 3", () => {
    const w = hd(parseWalletInput(YPUB49));
    expect(w.scriptType).toBe("p2sh-p2wpkh");
    expect(deriveAddress(w, 0, 0)).toBe("37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf");
  });

  it("BIP44 xpub → 1", () => {
    const w = hd(parseWalletInput(XPUB44));
    expect(w.scriptType).toBe("p2pkh");
    expect(deriveAddress(w, 0, 0)).toBe("1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA");
  });

  it("BIP86 tr() 디스크립터 → bc1p", () => {
    const w = hd(parseWalletInput(`tr([73c5da0a/86h/0h/0h]${XPUB86}/<0;1>/*)#abcdefgh`));
    expect(w.scriptType).toBe("p2tr");
    expect(deriveAddress(w, 0, 0)).toBe("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr");
    expect(deriveAddress(w, 0, 1)).toBe("bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh");
    expect(deriveAddress(w, 1, 0)).toBe("bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7");
  });
});

describe("입력 형식", () => {
  it("Sparrow wpkh() 디스크립터를 해석한다", () => {
    const w = hd(parseWalletInput(`wpkh([73c5da0a/84h/0h/0h]${XPUB84}/<0;1>/*)`));
    expect(deriveAddress(w, 0, 0)).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });

  it("sh(wpkh()) 디스크립터를 해석한다", () => {
    const xpub49 = accountKey("m/49'/0'/0'", 0x0488b21e);
    const w = hd(parseWalletInput(`sh(wpkh([73c5da0a/49h/0h/0h]${xpub49}/<0;1>/*))`));
    expect(deriveAddress(w, 0, 0)).toBe("37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf");
  });

  it("xpub에 주소 형식을 직접 지정할 수 있다", () => {
    const w = hd(parseWalletInput(XPUB84, "p2wpkh"));
    expect(deriveAddress(w, 0, 0)).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });

  it("zpub을 xpub 형식으로 정규화해 보관한다", () => {
    expect(hd(parseWalletInput(ZPUB84)).xpub).toBe(XPUB84);
  });

  it("단일 주소를 받는다", () => {
    for (const a of [
      "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
      "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf",
      "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA",
      "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
    ]) {
      expect(parseWalletInput(`  ${a} `)).toEqual({ kind: "address", address: a });
    }
  });

  it("개인키, 멀티시그, 테스트넷, 잘못된 값은 거부한다", () => {
    const xprv = root.derive("m/84'/0'/0'").privateExtendedKey;
    expect(() => parseWalletInput(xprv)).toThrow(/개인키/);
    expect(() => parseWalletInput("wsh(sortedmulti(2,xpubA,xpubB))")).toThrow(/멀티시그/);
    expect(() => parseWalletInput("tpubD6NzVbkrYhZ4X")).toThrow(/테스트넷/);
    expect(() => parseWalletInput("bc1qinvalid")).toThrow(WalletInputError);
    expect(() => parseWalletInput(ZPUB84.slice(0, -1) + "x")).toThrow(/형식/);
  });
});
