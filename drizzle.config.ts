import { defineConfig } from "drizzle-kit";

// 마이그레이션은 Session pooler(5432)로 실행한다. 앱은 Transaction pooler(6543)를 쓴다.
// 실행: node --env-file=.env.local node_modules/drizzle-kit/bin.cjs generate | migrate
const url = (process.env.SUPABASE_DATABASE_URL ?? "").replace(":6543/", ":5432/");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
  strict: true,
});
