import { HDKey } from "@scure/bip32";
import { Address, p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer";
import { coinOf, type UtxoCoin } from "./coins";

// 사용자가 입력한 비트코인 지갑 정보를 해석해 주소를 계산한다.
// 지원: 단일 주소, xpub/ypub/zpub(라이트코인은 Ltub/Mtub도), 단일 키 디스크립터 pkh/sh(wpkh)/wpkh/tr. 코인은 lib/btc/coins.ts
// 멀티시그와 테스트넷은 아직 지원하지 않는다.

export type ScriptType = "p2pkh" | "p2sh-p2wpkh" | "p2wpkh" | "p2tr";

export const SCRIPT_LABEL: Record<ScriptType, string> = {
  p2pkh: "Legacy (1…)",
  "p2sh-p2wpkh": "Nested SegWit (3…)",
  p2wpkh: "Native SegWit (bc1q…)",
  p2tr: "Taproot (bc1p…)",
};

export type ParsedWallet =
  | { kind: "address"; address: string }
  | { kind: "addresses"; addresses: string[] } // xpub을 지우고 찾아 둔 주소만 남긴 지갑
  | { kind: "hd"; key: HDKey; scriptType: ScriptType; xpub: string; coin?: UtxoCoin };

// SLIP-132 확장 공개키 버전 바이트 (메인넷, 단일 서명)
const VERSIONS = {
  xpub: { public: 0x0488b21e, private: 0x0488ade4, script: "p2pkh" as ScriptType },
  ypub: { public: 0x049d7cb2, private: 0x049d7878, script: "p2sh-p2wpkh" as ScriptType },
  zpub: { public: 0x04b24746, private: 0x04b2430c, script: "p2wpkh" as ScriptType },
};

const DESCRIPTOR_SCRIPT: Record<string, ScriptType> = {
  pkh: "p2pkh",
  "sh(wpkh": "p2sh-p2wpkh",
  wpkh: "p2wpkh",
  tr: "p2tr",
};

export class WalletInputError extends Error {}

function parseExtendedKey(key: string, coin?: UtxoCoin): { key: HDKey; defaultScript: ScriptType; xpub: string } {
  const prefix = key.slice(0, 4);
  if (["Ypub", "Zpub"].includes(prefix)) {
    throw new WalletInputError("멀티시그 지갑(Ypub/Zpub)은 아직 지원하지 않습니다");
  }
  if (["tpub", "upub", "vpub"].includes(prefix)) {
    throw new WalletInputError("테스트넷 키는 지원하지 않습니다");
  }
  if (["xprv", "yprv", "zprv", "tprv", "Ltpv", "Mtpv"].includes(prefix)) {
    throw new WalletInputError("개인키(xprv)를 입력하셨습니다. 즉시 지우고, 공개키(xpub/zpub)만 입력하세요");
  }
  const v = VERSIONS[prefix as keyof typeof VERSIONS] ?? coinOf(coin).extraVersions[prefix];
  if (!v) throw new WalletInputError(coin === "ltc" ? "Ltub, Mtub, xpub, zpub 중 하나여야 합니다" : "xpub, ypub, zpub 중 하나여야 합니다");
  let hd: HDKey;
  try {
    hd = HDKey.fromExtendedKey(key, { public: v.public, private: v.private });
  } catch {
    throw new WalletInputError("확장 공개키 형식이 올바르지 않습니다");
  }
  // 저장·표시용으로 xpub 형식으로 통일한다.
  const normalized = new HDKey({
    versions: { public: VERSIONS.xpub.public, private: VERSIONS.xpub.private },
    depth: hd.depth,
    index: hd.index,
    parentFingerprint: hd.parentFingerprint,
    chainCode: hd.chainCode!,
    publicKey: hd.publicKey!,
  }).publicExtendedKey;
  return { key: hd, defaultScript: v.script, xpub: normalized };
}

// scriptOverride: xpub만 입력했을 때 사용자가 고른 주소 형식 (Taproot·SegWit를 xpub로 내보내는 지갑 대응)
export function parseWalletInput(raw: string, scriptOverride?: ScriptType, coin?: UtxoCoin): ParsedWallet {
  const input = raw.trim().replace(/#[a-z0-9]{8}$/, ""); // 디스크립터 체크섬 제거

  // 디스크립터: wpkh([fingerprint/84h/0h/0h]xpub.../<0;1>/*)
  const desc = input.match(/^(pkh|wpkh|tr|sh\(wpkh)\((?:\[[^\]]*\])?([a-zA-Z0-9]+)(\/[^)]*)?\)\)?$/);
  if (desc) {
    const script = DESCRIPTOR_SCRIPT[desc[1]];
    const suffix = desc[3] ?? "";
    if (suffix && !["/<0;1>/*", "/0/*", "/1/*", "/*"].includes(suffix)) {
      throw new WalletInputError(`지원하지 않는 디스크립터 경로입니다: ${suffix}`);
    }
    const { key, xpub } = parseExtendedKey(desc[2], coin);
    return { kind: "hd", key, scriptType: script, xpub, coin };
  }
  if (/^(wsh|sh\(wsh|sh\(multi|sh\(sortedmulti)/.test(input)) {
    throw new WalletInputError("멀티시그 디스크립터는 아직 지원하지 않습니다");
  }

  if (/^[xyzYZtuv]pub|^[xyzt]prv|^(Ltub|Mtub|Ltpv|Mtpv)/.test(input)) {
    const { key, defaultScript, xpub } = parseExtendedKey(input, coin);
    return { kind: "hd", key, scriptType: scriptOverride ?? defaultScript, xpub, coin };
  }

  try {
    Address(coinOf(coin).network).decode(input);
  } catch {
    throw new WalletInputError(coin === "ltc" ? "라이트코인 주소(ltc1·L·M), Ltub·xpub·zpub, 디스크립터 중 하나를 입력하세요" : "비트코인 주소, xpub/ypub/zpub, 디스크립터 중 하나를 입력하세요");
  }
  return { kind: "address", address: input };
}

export function addressFromPubkey(pub: Uint8Array, script: ScriptType, coin?: UtxoCoin): string {
  const net = coinOf(coin).network;
  switch (script) {
    case "p2pkh":
      return p2pkh(pub, net).address!;
    case "p2sh-p2wpkh":
      return p2sh(p2wpkh(pub, net), net).address!;
    case "p2wpkh":
      return p2wpkh(pub, net).address!;
    case "p2tr":
      return p2tr(pub.slice(1), undefined, net).address!; // BIP86: x-only 공개키
  }
}

// chain 0 = 받는 주소, 1 = 거스름돈 주소
export function deriveAddress(wallet: Extract<ParsedWallet, { kind: "hd" }>, chain: 0 | 1, index: number) {
  const pub = wallet.key.deriveChild(chain).deriveChild(index).publicKey!;
  return addressFromPubkey(pub, wallet.scriptType, wallet.coin);
}
