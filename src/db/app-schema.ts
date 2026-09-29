import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

// 서비스 테이블. 설계: docs/architecture.md §4
// - 모든 테이블에 RLS를 켜고 정책을 두지 않는다. Supabase Data API(공개 키)로는 접근할 수 없고,
//   서버는 DB 소유자 계정으로 접속해 RLS를 우회한다. 고객 격리는 서버 코드에서 client_id로 강제한다.
// - 금액·수량은 numeric (자릿수 제한 없음, 문자열로 읽힘)

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

// 납세자 (고객). 로그인 계정(user)과 분리해, 사무실이 먼저 고객을 만들고 나중에 초대할 수 있게 한다.
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }), // 고객 본인 로그인 계정
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    accountantId: text("accountant_id").references(() => user.id), // 담당 세무사
    staffId: text("staff_id").references(() => user.id), // 담당 직원
    createdAt: createdAt(),
  },
  (t) => [index("clients_user_idx").on(t.userId), index("clients_accountant_idx").on(t.accountantId)],
).enableRLS();

// 수임 계약·동의
export const engagements = pgTable(
  "engagements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    taxYear: integer("tax_year").notNull(),
    status: text("status").notNull().default("invited"), // invited | active | ended
    consentVersion: text("consent_version"), // 동의한 약관·처리방침 버전
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("engagements_client_idx").on(t.clientId)],
).enableRLS();

// 연결 계정. 주소·xpub(config)와 API Secret(secret)은 서버 키로 암호화해 저장한다 (lib/server/crypto).
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // binance | okx | evm | btc
    label: text("label").notNull(),
    configEnc: text("config_enc").notNull(),
    secretEnc: text("secret_enc"),
    createdBy: text("created_by").references(() => user.id), // 고객 본인 또는 사무실 직원
    createdAt: createdAt(),
  },
  (t) => [index("sources_client_idx").on(t.clientId)],
).enableRLS();

// 동기화 커서 (EVM 체인별 마지막 블록, BTC 발견 주소 등)
export const syncState = pgTable(
  "sync_state",
  {
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    cursor: text("cursor").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.scope] })],
).enableRLS();

// 원장 (lib/db.ts LedgerEntry와 같은 구조)
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(), // 원본 데이터에서 결정적으로 생성 (source_id 포함)
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    location: text("location").notNull(),
    time: timestamp("time", { withTimezone: true }).notNull(),
    asset: text("asset").notNull(),
    assetKey: text("asset_key").notNull(),
    amount: numeric("amount").notNull(),
    kind: text("kind").notNull(),
    groupId: text("group_id").notNull(),
    txHash: text("tx_hash"),
    counterparty: text("counterparty"),
  },
  (t) => [
    index("ledger_client_group_idx").on(t.clientId, t.groupId),
    index("ledger_client_time_idx").on(t.clientId, t.time),
    index("ledger_source_asset_idx").on(t.sourceId, t.assetKey),
  ],
).enableRLS();

// 분류 결정 (docs/classification.md §7). 고객 단위로 group_id에 대해 하나.
export const decisions = pgTable(
  "decisions",
  {
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    category: text("category").notNull(),
    costKrw: numeric("cost_krw"),
    note: text("note"),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.key] })],
).enableRLS();

// 잔고 기록 (수동, 12/31 자동 기록 등)
export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("manual"), // manual | year_end | scheduled
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    priceSource: text("price_source"),
    totalKrw: numeric("total_krw"),
    holdings: jsonb("holdings").notNull(),
    errors: jsonb("errors").notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [index("snapshots_client_time_idx").on(t.clientId, t.takenAt)],
).enableRLS();

// 백그라운드 작업 큐 (동기화, 일괄 잔고 기록)
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(), // sync_source | snapshot_client | ...
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "cascade" }),
    payload: jsonb("payload"),
    status: text("status").notNull().default("queued"), // queued | running | done | failed
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("jobs_status_run_idx").on(t.status, t.runAfter)],
).enableRLS();

// 접근 기록: 누가 언제 어떤 고객 데이터를 보고 바꿨는지. 애플리케이션은 추가만 한다.
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorId: text("actor_id").references(() => user.id),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    detail: jsonb("detail"),
    ip: text("ip"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("audit_client_at_idx").on(t.clientId, t.at)],
).enableRLS();

// 공개 시세 캐시 (사용자 정보 없음). Neon에서 옮겨 온 구조와 같다.
export const pricesMinute = pgTable(
  "prices_minute",
  {
    src: text("src").notNull(),
    symbol: text("symbol").notNull(),
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    price: numeric("price").notNull(),
  },
  (t) => [primaryKey({ columns: [t.src, t.symbol, t.minute] })],
).enableRLS();

export const pricesHourly = pgTable(
  "prices_hourly",
  {
    src: text("src").notNull(),
    symbol: text("symbol").notNull(),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    price: numeric("price").notNull(),
  },
  (t) => [primaryKey({ columns: [t.src, t.symbol, t.hour] })],
).enableRLS();

export const fxUsdKrwDaily = pgTable("fx_usdkrw_daily", {
  day: text("day").primaryKey(), // YYYY-MM-DD
  rate: numeric("rate").notNull(),
}).enableRLS();
