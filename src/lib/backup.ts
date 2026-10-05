import { db, getSetting, setSetting } from "@/lib/db";
import { lockVault } from "@/lib/vault";
import { FORMAT, TABLES, type BackupPayload, type TableName } from "./backup-file";

// 암호화 백업·복원. 데이터가 이 브라우저에만 있어 브라우저 데이터를 지우거나 기기를 바꾸면 모두 사라지므로,
// 전체 데이터베이스를 하나의 파일로 내려받아 둔다 (파일 형식: lib/backup-file.ts).
// - 거래소 API Secret은 원래부터 거래소 키 비밀번호로 암호화되어 있으므로, 복원 뒤에도 그 비밀번호로 잠금을 해제해야 쓸 수 있다.
// - 서버로 보내지 않는다. 파일을 어디에 보관할지는 사용자가 정한다.

export { decryptBackup, encryptBackup, summarize, type BackupPayload } from "./backup-file";

export const LAST_BACKUP_KEY = "lastBackupAt";

export async function collectBackup(): Promise<BackupPayload> {
  const tables = {} as Record<TableName, unknown[]>;
  await db.transaction("r", TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) tables[t] = await db.table(t).toArray();
  });
  return { format: FORMAT, version: 1, createdAt: Date.now(), tables };
}

// 내려받은 시각을 남긴다 (첫 화면의 백업 알림용)
export async function markBackedUp() {
  await setSetting(LAST_BACKUP_KEY, String(Date.now()));
}

export async function lastBackupAt(): Promise<number | null> {
  const v = await getSetting(LAST_BACKUP_KEY);
  return v ? Number(v) : null;
}

// 지금 데이터를 모두 지우고 백업 내용으로 바꾼다.
export async function restoreBackup(p: BackupPayload) {
  await db.transaction("rw", TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) {
      await db.table(t).clear();
      const rows = p.tables[t] ?? [];
      if (rows.length) await db.table(t).bulkPut(rows);
    }
  });
  // 거래소 키 비밀번호도 백업 시점의 것으로 바뀌었으므로 다시 잠근다
  lockVault();
}
