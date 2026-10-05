// 백업 파일 형식 (암호화·복호화). 브라우저 데이터베이스와 무관한 부분이라 테스트에서 바로 쓴다. 설명은 lib/backup.ts
// - 파일 = 압축(gzip)한 JSON을 백업 비밀번호로 암호화 (PBKDF2-SHA256 600,000회 → AES-GCM 256)

export const TABLES = ["sources", "snapshots", "settings", "ledger", "syncState", "decisions", "reconciliations"] as const;
export type TableName = (typeof TABLES)[number];

export const FORMAT = "btax-backup";
const ITERATIONS = 600_000;

export interface BackupPayload {
  format: typeof FORMAT;
  version: 1;
  createdAt: number;
  tables: Record<TableName, unknown[]>;
}

interface Envelope {
  format: "btax-backup-encrypted";
  version: 1;
  kdf: { name: "PBKDF2-SHA256"; iterations: number; salt: string };
  iv: string;
  data: string; // base64(AES-GCM(gzip(JSON)))
}

// ── base64 (큰 데이터도 처리하도록 나눠서 변환) ──
function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptBackup(payload: BackupPayload, password: string): Promise<string> {
  const zipped = await pipe(new TextEncoder().encode(JSON.stringify(payload)), new CompressionStream("gzip"));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, zipped as BufferSource));
  const env: Envelope = {
    format: "btax-backup-encrypted",
    version: 1,
    kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS, salt: toB64(salt) },
    iv: toB64(iv),
    data: toB64(ct),
  };
  return JSON.stringify(env);
}

export async function decryptBackup(text: string, password: string): Promise<BackupPayload> {
  let env: Envelope;
  try {
    env = JSON.parse(text);
  } catch {
    throw new Error("B택스 백업 파일이 아닙니다.");
  }
  if (env?.format !== "btax-backup-encrypted") throw new Error("B택스 백업 파일이 아닙니다.");
  const key = await deriveKey(password, fromB64(env.kdf.salt), env.kdf.iterations);
  let zipped: Uint8Array;
  try {
    zipped = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(env.iv) as BufferSource }, key, fromB64(env.data) as BufferSource));
  } catch {
    throw new Error("비밀번호가 맞지 않거나 파일이 손상되었습니다.");
  }
  const payload = JSON.parse(new TextDecoder().decode(await pipe(zipped, new DecompressionStream("gzip")))) as BackupPayload;
  if (payload.format !== FORMAT || !payload.tables) throw new Error("백업 내용을 읽지 못했습니다.");
  return payload;
}

export function summarize(p: BackupPayload) {
  const n = (t: TableName) => p.tables[t]?.length ?? 0;
  return { createdAt: p.createdAt, sources: n("sources"), ledger: n("ledger"), decisions: n("decisions"), snapshots: n("snapshots") };
}
