import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, sources } from "@/db/schema";
import { decryptField, encryptField, parseKeyRing, type KeyRing } from "./crypto";

// 연결 계정 저장소. 주소·xpub·API 키(config)와 API Secret(secret)은 암호화해 저장한다.
// 모든 함수는 clientId를 받아 조건에 넣는다 → 다른 고객의 계정은 ID를 알아도 읽거나 지울 수 없다.

export type SourceConfig =
  | { kind: "binance"; apiKey: string }
  | { kind: "okx"; apiKey: string }
  | { kind: "evm"; address: string; chains: string[] }
  | { kind: "btc"; input: string; scriptType?: string; gapLimit: number; esploraUrl: string };

export interface SourceSecret {
  apiSecret: string;
  passphrase?: string; // OKX
}

export interface SourceView {
  id: string;
  kind: SourceConfig["kind"];
  label: string;
  config: SourceConfig;
  hasSecret: boolean;
  createdAt: Date;
}

let ring: KeyRing | null = null;
const keyRing = () => (ring ??= parseKeyRing(process.env.APP_ENCRYPTION_KEYS));

const ctx = (id: string, field: "config" | "secret") => `source:${id}:${field}`;

export async function createSource(input: {
  clientId: string;
  label: string;
  config: SourceConfig;
  secret?: SourceSecret;
  createdBy: string | null;
}): Promise<string> {
  const needsSecret = input.config.kind === "binance" || input.config.kind === "okx";
  if (needsSecret && !input.secret?.apiSecret) throw new Error("거래소 계정에는 API Secret이 필요합니다");

  const id = randomUUID(); // 암호문을 이 ID에 묶기 위해 미리 만든다
  await db.transaction(async (tx) => {
    await tx.insert(sources).values({
      id,
      clientId: input.clientId,
      kind: input.config.kind,
      label: input.label,
      configEnc: encryptField(keyRing(), JSON.stringify(input.config), ctx(id, "config")),
      secretEnc: input.secret ? encryptField(keyRing(), JSON.stringify(input.secret), ctx(id, "secret")) : null,
      createdBy: input.createdBy,
    });
    await tx.insert(auditLog).values({
      actorId: input.createdBy,
      clientId: input.clientId,
      action: "source.created",
      detail: { sourceId: id, kind: input.config.kind },
    });
  });
  return id;
}

function view(row: typeof sources.$inferSelect): SourceView {
  return {
    id: row.id,
    kind: row.kind as SourceConfig["kind"],
    label: row.label,
    config: JSON.parse(decryptField(keyRing(), row.configEnc, ctx(row.id, "config"))),
    hasSecret: row.secretEnc !== null,
    createdAt: row.createdAt,
  };
}

export async function listSources(clientId: string): Promise<SourceView[]> {
  const rows = await db.select().from(sources).where(eq(sources.clientId, clientId)).orderBy(sources.createdAt);
  return rows.map(view);
}

export async function getSource(clientId: string, sourceId: string): Promise<SourceView | null> {
  const [row] = await db.select().from(sources).where(and(eq(sources.clientId, clientId), eq(sources.id, sourceId)));
  return row ? view(row) : null;
}

// API Secret 복호화. 사용할 때마다 누가·왜 썼는지 기록한다 (actorId null = 시스템 작업).
export async function useSourceSecret(
  clientId: string,
  sourceId: string,
  actorId: string | null,
  purpose: string,
): Promise<SourceSecret | null> {
  const [row] = await db
    .select({ secretEnc: sources.secretEnc })
    .from(sources)
    .where(and(eq(sources.clientId, clientId), eq(sources.id, sourceId)));
  if (!row?.secretEnc) return null;
  const secret = JSON.parse(decryptField(keyRing(), row.secretEnc, ctx(sourceId, "secret"))) as SourceSecret;
  await db.insert(auditLog).values({ actorId, clientId, action: "source.secret_used", detail: { sourceId, purpose } });
  return secret;
}

export async function deleteSource(clientId: string, sourceId: string, actorId: string | null): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(sources)
      .where(and(eq(sources.clientId, clientId), eq(sources.id, sourceId)))
      .returning({ id: sources.id, kind: sources.kind });
    if (deleted.length === 0) return false;
    await tx.insert(auditLog).values({ actorId, clientId, action: "source.deleted", detail: { sourceId, kind: deleted[0].kind } });
    return true;
  });
}
