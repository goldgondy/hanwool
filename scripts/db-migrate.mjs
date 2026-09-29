// Neon DB 스키마 생성/갱신. 여러 번 실행해도 안전하다.
// 실행: node --env-file=.env.local scripts/db-migrate.mjs
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

// 1시간 단위 시세 캐시 (공개 시세만 저장, 사용자 정보 없음)
// src: 'upbit_krw' (원화 가격) / 'binance_usdt' (USDT 가격)
// hour: 캔들 시작 시각(UTC). 거래가 없던 시간은 직전 종가로 채워 저장한다.
await sql`
  create table if not exists prices_hourly (
    src    text        not null,
    symbol text        not null,
    hour   timestamptz not null,
    price  numeric     not null,
    primary key (src, symbol, hour)
  )`;

// 1분 단위 시세 캐시 (prices_hourly와 같은 구조, minute = 캔들 시작 시각 UTC)
await sql`
  create table if not exists prices_minute (
    src    text        not null,
    symbol text        not null,
    minute timestamptz not null,
    price  numeric     not null,
    primary key (src, symbol, minute)
  )`;

// ECB 원/달러 기준 환율 (영업일이 아닌 날은 직전 영업일 값으로 채움)
await sql`
  create table if not exists fx_usdkrw_daily (
    day  date    primary key,
    rate numeric not null
  )`;

const tables = await sql`
  select table_name from information_schema.tables
  where table_schema = 'public' order by table_name`;
console.log("tables:", tables.map((t) => t.table_name).join(", "));
