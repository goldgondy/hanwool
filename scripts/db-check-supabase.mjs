// SUPABASE_DATABASE_URL 형식과 접속을 확인한다. 연결 문자열(비밀번호)은 출력하지 않는다.
// 실행: node --env-file=.env.local scripts/db-check-supabase.mjs
import postgres from "postgres";

const url = process.env.SUPABASE_DATABASE_URL ?? "";
const problems = [];
if (!url) problems.push("SUPABASE_DATABASE_URL이 비어 있습니다");
if (/^["']|["']$/.test(url)) problems.push("따옴표를 지워 주세요");
if (/\s/.test(url)) problems.push("띄어쓰기나 줄바꿈이 들어 있습니다");
if (url.includes("[YOUR-PASSWORD]") || url.includes("YOUR-PASSWORD")) problems.push("[YOUR-PASSWORD]를 실제 비밀번호로 바꿔 주세요");

let parsed;
try {
  parsed = new URL(url);
} catch {
  problems.push("주소 형식이 올바르지 않습니다");
}
if (parsed && !parsed.password) problems.push("비밀번호가 빠져 있습니다");
if (problems.length) {
  console.log("형식 문제:\n- " + problems.join("\n- "));
  process.exit(1);
}

console.log(`호스트: ${parsed.hostname}`);
console.log(`포트: ${parsed.port} (${parsed.port === "6543" ? "Transaction pooler" : parsed.port === "5432" ? "직접 연결 또는 Session pooler" : "?"})`);
console.log(`리전: ${parsed.hostname.includes("ap-northeast-2") ? "서울 (ap-northeast-2)" : "서울이 아님 → 확인 필요"}`);

const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15 });
try {
  const [row] = await sql`select version() as version, now() as now, current_setting('TimeZone') as tz`;
  console.log(`접속 성공: ${row.version.split(",")[0]}`);
  console.log(`서버 시각: ${new Date(row.now).toISOString()} (TimeZone ${row.tz})`);
} catch (e) {
  console.log(`접속 실패: ${e.message}`);
  if (/password authentication failed/i.test(e.message)) console.log("→ 비밀번호가 틀렸습니다. Supabase에서 DB 비밀번호를 확인하거나 재설정하세요.");
  process.exitCode = 1;
} finally {
  await sql.end();
}
