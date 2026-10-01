import { describe, expect, it } from "vitest";
import type { CsvSource, EvmSource, Source, XapiSource } from "@/lib/db";
import { buildAccounts } from "./accounts";

const evm: EvmSource = { id: "w", kind: "evm", label: "메타마스크", address: "0x1", chains: ["eth"], createdAt: 0 };
const api: XapiSource = { id: "a", kind: "xapi", exchange: "bybit", label: "바이비트", apiKey: "k", encSecret: { iv: "", ct: "" }, createdAt: 0 };
const csv = (id: string, linked?: string): CsvSource => ({ id, kind: "csv", label: `CSV ${id}`, exchange: "bybit", imports: [], linkedSourceId: linked, createdAt: 0 });

describe("buildAccounts", () => {
  it("지갑·API는 각각 계정, 연결된 CSV는 API 계정에 묶고, 연결 안 된 CSV는 대사 불가로 분리", () => {
    const sources: Source[] = [evm, api, csv("c1", "a"), csv("c2")];
    const { accounts, csvOnly } = buildAccounts(sources);
    expect(accounts.map((a) => [a.key, a.memberIds])).toEqual([
      ["w", ["w"]],
      ["a", ["a", "c1"]],
    ]);
    expect(accounts[1].label).toBe("바이비트 + CSV c1");
    expect(csvOnly.map((c) => c.id)).toEqual(["c2"]);
  });
});
