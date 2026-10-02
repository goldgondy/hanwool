import { describe, expect, it } from "vitest";
import type { CsvSource, LedgerEntry, Source, XapiSource } from "@/lib/db";
import { applyCsvCoverage, csvSourcesShadowedByApi } from "./dedup";

const D = (s: string) => Date.parse(`${s}T00:00:00Z`);
const api: XapiSource = { id: "api", kind: "xapi", exchange: "bybit", label: "바이비트 API", apiKey: "k", encSecret: { iv: "", ct: "" }, createdAt: 0 };
const csv = (linked?: string): CsvSource => ({ id: "csv", kind: "csv", label: "바이비트 CSV", exchange: "bybit", imports: [], linkedSourceId: linked, createdAt: 0 });
const e = (sourceId: string, day: string, id = `${sourceId}-${day}`): LedgerEntry => ({
  id,
  sourceId,
  location: "x",
  time: D(day),
  asset: "BTC",
  assetKey: "BTC",
  amount: "1",
  kind: "trade",
  groupId: id,
  origin: "exchange",
});

// CSV: 2025-01-01 ~ 2025-06-30, API: 2024-12-01 ~ 2025-09-01
const entries = [
  e("csv", "2025-01-01"),
  e("csv", "2025-03-15"),
  e("csv", "2025-06-30"),
  e("api", "2024-12-01"), // CSV 이전 → 유지
  e("api", "2025-01-01"), // CSV 기간(경계 포함) → 제거
  e("api", "2025-03-15"), // CSV 기간 → 제거
  e("api", "2025-06-30"), // 경계 → 제거
  e("api", "2025-09-01"), // CSV 이후 → 유지
  e("wallet", "2025-03-15"), // 다른 계정 → 영향 없음
];

describe("applyCsvCoverage", () => {
  it("연결된 경우 CSV 기간 안의 API 항목만 뺀다", () => {
    const sources: Source[] = [api, csv("api")];
    const r = applyCsvCoverage(entries, sources);
    expect(r.dropped).toBe(3);
    expect(r.entries.filter((x) => x.sourceId === "api").map((x) => new Date(x.time).toISOString().slice(0, 10))).toEqual([
      "2024-12-01",
      "2025-09-01",
    ]);
    expect(r.entries.filter((x) => x.sourceId === "csv")).toHaveLength(3);
    expect(r.entries.some((x) => x.sourceId === "wallet")).toBe(true);
  });

  it("연결하지 않으면 다른 계정으로 보고 아무것도 빼지 않는다", () => {
    const r = applyCsvCoverage(entries, [api, csv()]);
    expect(r.dropped).toBe(0);
    expect(r.entries).toHaveLength(entries.length);
  });

  it("CSV 항목이 없으면 기간이 없으므로 아무것도 빼지 않는다", () => {
    const r = applyCsvCoverage(entries.filter((x) => x.sourceId !== "csv"), [api, csv("api")]);
    expect(r.dropped).toBe(0);
  });
});

describe("applyCsvCoverage: 거래소 안 일부 계정만 담긴 CSV", () => {
  it("CSV와 위치가 같은 API 항목만 빼고, 다른 계정(자금 계정 입출금)은 남긴다", () => {
    const at = (x: LedgerEntry, location: string) => ({ ...x, location });
    const list = [
      at(e("csv", "2025-01-01"), "OKX 거래 계정"),
      at(e("csv", "2025-06-30"), "OKX 거래 계정"),
      at(e("api", "2025-03-15", "api-trade"), "OKX 거래 계정"), // 겹침 → 제거
      at(e("api", "2025-03-15", "api-deposit"), "OKX 펀딩 계정"), // 파일에 없는 계정 → 유지
    ];
    const r = applyCsvCoverage(list, [api, csv("api")]);
    expect(r.entries.filter((x) => x.sourceId === "api").map((x) => x.id)).toEqual(["api-deposit"]);
  });
});

describe("csvSourcesShadowedByApi", () => {
  it("연결된 API 계정이 있는 CSV 계정만 잔고 합산에서 뺀다", () => {
    expect(csvSourcesShadowedByApi([api, csv("api")])).toEqual(new Set(["csv"]));
    expect(csvSourcesShadowedByApi([api, csv()])).toEqual(new Set());
    // 연결 대상 API 계정이 지워졌으면 CSV 잔고를 다시 쓴다
    expect(csvSourcesShadowedByApi([csv("api")])).toEqual(new Set());
  });
});
