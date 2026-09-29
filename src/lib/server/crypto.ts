import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// 민감 필드 봉투 암호화 (docs/architecture.md §5)
// - 값마다 새 데이터 키(DEK, 256비트)로 AES-256-GCM 암호화하고, DEK는 마스터 키(KEK)로 다시 암호화해 함께 저장한다.
// - context(예: "source:<id>:secret")를 AAD로 묶어, 암호문을 다른 행·필드로 옮기면 복호화가 실패한다.
// - 마스터 키는 버전(k1, k2…)을 가지며, 가장 마지막 키로 암호화하고 모든 키로 복호화할 수 있다 (키 교체 대비).
// - 추후 KEK를 AWS KMS로 옮기면 wrapKey/unwrapKey만 바꾸면 된다.
//
// 저장 형식: v1.<keyId>.<wrappedDek>.<iv>.<ciphertext+tag>  (각 부분 base64url)

const VERSION = "v1";

export interface KeyRing {
  currentId: string;
  keys: Map<string, Buffer>;
}

// APP_ENCRYPTION_KEYS="k1:<base64 32바이트>,k2:<base64 32바이트>" (마지막이 현재 키)
export function parseKeyRing(value: string | undefined): KeyRing {
  if (!value) throw new Error("APP_ENCRYPTION_KEYS가 설정되지 않았습니다");
  const keys = new Map<string, Buffer>();
  let currentId = "";
  for (const part of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [id, b64] = part.split(":");
    if (!id || !b64 || !/^[a-z0-9]+$/.test(id)) throw new Error("APP_ENCRYPTION_KEYS 형식 오류 (예: k1:<base64>)");
    const key = Buffer.from(b64, "base64");
    if (key.length !== 32) throw new Error(`암호화 키 ${id}는 32바이트여야 합니다`);
    if (keys.has(id)) throw new Error(`암호화 키 ${id}가 중복되었습니다`);
    keys.set(id, key);
    currentId = id;
  }
  if (!currentId) throw new Error("APP_ENCRYPTION_KEYS에 키가 없습니다");
  return { currentId, keys };
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv, ct };
}

function gcmDecrypt(key: Buffer, iv: Buffer, ctWithTag: Buffer, aad: string) {
  if (ctWithTag.length < 16) throw new Error("암호문이 손상되었습니다");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(ctWithTag.subarray(ctWithTag.length - 16));
  return Buffer.concat([decipher.update(ctWithTag.subarray(0, ctWithTag.length - 16)), decipher.final()]);
}

// DEK를 KEK로 감싼다. 감싼 결과에는 iv를 앞에 붙인다.
function wrapKey(kek: Buffer, dek: Buffer, aad: string) {
  const { iv, ct } = gcmEncrypt(kek, dek, `dek|${aad}`);
  return Buffer.concat([iv, ct]);
}

function unwrapKey(kek: Buffer, wrapped: Buffer, aad: string) {
  return gcmDecrypt(kek, wrapped.subarray(0, 12), wrapped.subarray(12), `dek|${aad}`);
}

export function encryptField(ring: KeyRing, plaintext: string, context: string): string {
  const kek = ring.keys.get(ring.currentId)!;
  const dek = randomBytes(32);
  try {
    const wrapped = wrapKey(kek, dek, context);
    const { iv, ct } = gcmEncrypt(dek, Buffer.from(plaintext, "utf8"), context);
    return [VERSION, ring.currentId, wrapped.toString("base64url"), iv.toString("base64url"), ct.toString("base64url")].join(".");
  } finally {
    dek.fill(0);
  }
}

export function decryptField(ring: KeyRing, token: string, context: string): string {
  const [version, keyId, wrapped, iv, ct] = token.split(".");
  if (version !== VERSION || !keyId || !wrapped || !iv || !ct) throw new Error("알 수 없는 암호문 형식입니다");
  const kek = ring.keys.get(keyId);
  if (!kek) throw new Error(`암호화 키 ${keyId}가 없습니다`);
  let dek: Buffer | null = null;
  try {
    dek = unwrapKey(kek, Buffer.from(wrapped, "base64url"), context);
    return gcmDecrypt(dek, Buffer.from(iv, "base64url"), Buffer.from(ct, "base64url"), context).toString("utf8");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("암호화 키")) throw e;
    throw new Error("복호화에 실패했습니다 (키가 다르거나 암호문이 변조·이동되었습니다)");
  } finally {
    dek?.fill(0);
  }
}

// 이 암호문이 현재 키로 암호화된 것인지 (키 교체 후 재암호화 대상 찾기)
export function needsReencrypt(ring: KeyRing, token: string) {
  return token.split(".")[1] !== ring.currentId;
}
