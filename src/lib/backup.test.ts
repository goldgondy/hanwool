import { describe, expect, it } from "vitest";
import { decryptBackup, encryptBackup, summarize, type BackupPayload } from "./backup-file";

const payload: BackupPayload = {
  format: "btax-backup",
  version: 1,
  createdAt: Date.UTC(2026, 9, 5),
  tables: {
    sources: [{ id: "s1", kind: "csv", label: "OKX (파일)", exchange: "okx", imports: [], createdAt: 0 }],
    snapshots: [],
    settings: [{ key: "vaultSalt", value: "abc" }],
    // 큰 원장도 처리되는지 (base64를 나눠서 변환)
    ledger: Array.from({ length: 20000 }, (_, i) => ({ id: `e${i}`, sourceId: "s1", time: i, asset: "BTC", assetKey: "BTC", amount: "0.001", kind: "trade", groupId: `g${i}` })),
    syncState: [],
    decisions: [{ key: "g1", category: "self_transfer", decidedAt: 1 }],
    reconciliations: [],
  },
};

describe("암호화 백업", () => {
  it("같은 비밀번호로 열면 그대로 돌아온다", async () => {
    const file = await encryptBackup(payload, "correct horse");
    expect(file).not.toContain("파일"); // 내용이 그대로 보이지 않는다 (암호문은 영문·숫자뿐이라 한글이 나오면 평문)
    const back = await decryptBackup(file, "correct horse");
    expect(back).toEqual(payload);
    expect(summarize(back)).toMatchObject({ sources: 1, ledger: 20000, decisions: 1 });
  });

  it("비밀번호가 틀리면 열리지 않는다", async () => {
    const file = await encryptBackup(payload, "correct horse");
    await expect(decryptBackup(file, "wrong")).rejects.toThrow("비밀번호");
  });

  it("다른 파일은 백업 파일이 아니라고 알려 준다", async () => {
    await expect(decryptBackup("id,Time\n1,2", "x")).rejects.toThrow("백업 파일이 아닙니다");
  });
});
