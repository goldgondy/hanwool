import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// 서비스 DB (Supabase 서울). Transaction pooler를 쓰므로 prepared statement를 끈다.
const url = process.env.SUPABASE_DATABASE_URL;
if (!url) throw new Error("SUPABASE_DATABASE_URL이 설정되지 않았습니다");

// 개발 중 핫 리로드로 연결이 쌓이지 않도록 전역에 하나만 둔다.
const globalForDb = globalThis as unknown as { pg?: ReturnType<typeof postgres> };
const client = globalForDb.pg ?? postgres(url, { prepare: false, max: 10 });
if (process.env.NODE_ENV !== "production") globalForDb.pg = client;

export const db = drizzle(client, { schema });
