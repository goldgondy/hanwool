import { db, getSetting, setSetting, type EncryptedBlob } from "@/lib/db";

// 거래소 Secret 등 민감 정보를 사용자 비밀번호로 암호화한다.
// - PBKDF2(SHA-256, 600,000회)로 AES-GCM 256 키를 유도한다.
// - 유도된 키는 추출 불가능한 CryptoKey로 메모리에만 두며, 새로고침하면 사라진다.
// - 비밀번호는 어디에도 저장하지 않는다. 잊어버리면 복구할 수 없다.

const ITERATIONS = 600_000;
const CHECK_PLAINTEXT = "crypto-tax-engine-vault-v1";

let key: CryptoKey | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function subscribeVault(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isUnlocked() {
  return key !== null;
}

function toB64(buf: ArrayBuffer | Uint8Array) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes));
}

function fromB64(s: string) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function deriveKey(passphrase: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ITERATIONS },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptWith(k: CryptoKey, plaintext: string): Promise<EncryptedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    k,
    new TextEncoder().encode(plaintext),
  );
  return { iv: toB64(iv), ct: toB64(ct) };
}

async function decryptWith(k: CryptoKey, blob: EncryptedBlob) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(blob.iv) as BufferSource },
    k,
    fromB64(blob.ct) as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

export async function isVaultInitialized() {
  return (await getSetting("vaultCheck")) !== undefined;
}

export async function initVault(passphrase: string) {
  if (await isVaultInitialized()) throw new Error("이미 비밀번호가 설정되어 있습니다");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await deriveKey(passphrase, salt);
  const check = await encryptWith(k, CHECK_PLAINTEXT);
  await setSetting("vaultSalt", toB64(salt));
  await setSetting("vaultCheck", JSON.stringify(check));
  key = k;
  emit();
}

export async function unlockVault(passphrase: string) {
  const salt = await getSetting("vaultSalt");
  const check = await getSetting("vaultCheck");
  if (!salt || !check) throw new Error("비밀번호가 아직 설정되지 않았습니다");
  const k = await deriveKey(passphrase, fromB64(salt));
  try {
    if ((await decryptWith(k, JSON.parse(check))) !== CHECK_PLAINTEXT) throw new Error();
  } catch {
    throw new Error("비밀번호가 올바르지 않습니다");
  }
  key = k;
  emit();
}

export function lockVault() {
  key = null;
  emit();
}

// 비밀번호를 잊었을 때: 암호화된 거래소 키를 모두 삭제하고 초기화한다.
export async function resetVault() {
  await db.transaction("rw", db.sources, db.settings, async () => {
    await db.sources.where("kind").anyOf("binance", "okx").delete();
    await db.settings.bulkDelete(["vaultSalt", "vaultCheck"]);
  });
  lockVault();
}

export async function encrypt(plaintext: string) {
  if (!key) throw new Error("잠금을 먼저 해제하세요");
  return encryptWith(key, plaintext);
}

export async function decrypt(blob: EncryptedBlob) {
  if (!key) throw new Error("잠금을 먼저 해제하세요");
  return decryptWith(key, blob);
}
