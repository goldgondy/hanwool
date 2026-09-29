// 실제 Supabase DB에서 연결 계정 암호화 저장·조회·격리·삭제를 확인한다.
// 실행: npm run test:live -- src/lib/server/sources.live.test.ts
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLog, clients, sources } from "@/db/schema";
import { createSource, deleteSource, getSource, listSources, useSourceSecret } from "./sources";

const created: string[] = [];
async function makeClient(name: string) {
  const [c] = await db.insert(clients).values({ name }).returning({ id: clients.id });
  created.push(c.id);
  return c.id;
}

afterAll(async () => {
  if (created.length) await db.delete(clients).where(inArray(clients.id, created)); // 계정·원장은 cascade 삭제
});

describe("sources (live DB)", () => {
  it("암호화해 저장하고, DB 원문에는 평문이 없으며, 복호화하면 원래 값이다", async () => {
    const clientId = await makeClient("테스트 고객 A");
    const id = await createSource({
      clientId,
      label: "바이낸스",
      config: { kind: "binance", apiKey: "PUBLIC_KEY_12345" },
      secret: { apiSecret: "SUPER_SECRET_67890" },
      createdBy: null,
    });

    const [raw] = await db.select().from(sources).where(eq(sources.id, id));
    expect(raw.configEnc).not.toContain("PUBLIC_KEY_12345");
    expect(raw.secretEnc).not.toContain("SUPER_SECRET_67890");
    expect(raw.secretEnc!.startsWith("v1.k1.")).toBe(true);

    const v = await getSource(clientId, id);
    expect(v?.config).toEqual({ kind: "binance", apiKey: "PUBLIC_KEY_12345" });
    expect(v?.hasSecret).toBe(true);
    expect(JSON.stringify(v)).not.toContain("SUPER_SECRET");

    const secret = await useSourceSecret(clientId, id, null, "test");
    expect(secret?.apiSecret).toBe("SUPER_SECRET_67890");

    const logs = await db.select().from(auditLog).where(eq(auditLog.clientId, clientId));
    expect(logs.map((l) => l.action).sort()).toEqual(["source.created", "source.secret_used"]);
  });

  it("다른 고객의 계정은 ID를 알아도 읽거나 지울 수 없다", async () => {
    const a = await makeClient("테스트 고객 B");
    const b = await makeClient("테스트 고객 C");
    const id = await createSource({ clientId: a, label: "지갑", config: { kind: "evm", address: "0xabc", chains: ["eth"] }, createdBy: null });

    expect(await getSource(b, id)).toBeNull();
    expect(await useSourceSecret(b, id, null, "test")).toBeNull();
    expect(await deleteSource(b, id, null)).toBe(false);
    expect(await listSources(b)).toHaveLength(0);
    expect(await listSources(a)).toHaveLength(1);

    expect(await deleteSource(a, id, null)).toBe(true);
    expect(await listSources(a)).toHaveLength(0);
  });

  it("거래소 계정은 Secret 없이 만들 수 없다", async () => {
    const clientId = await makeClient("테스트 고객 D");
    await expect(
      createSource({ clientId, label: "OKX", config: { kind: "okx", apiKey: "k" }, createdBy: null }),
    ).rejects.toThrow(/API Secret/);
  });

  it("고객을 지워도 접근 기록은 남는다", async () => {
    const clientId = await makeClient("테스트 고객 E");
    await createSource({ clientId, label: "지갑", config: { kind: "evm", address: "0xdef", chains: ["eth"] }, createdBy: null });
    await db.delete(clients).where(eq(clients.id, clientId));
    const logs = await db.select().from(auditLog).where(eq(auditLog.clientId, clientId));
    expect(logs.length).toBeGreaterThan(0);
  });
});
