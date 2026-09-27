// DATABASE_URL 형식과 접속을 확인한다. 연결 문자열(비밀번호)은 출력하지 않는다.
// 실행: node --env-file=.env.local scripts/db-check.mjs
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL ?? "";
const problems = [];
if (!url) problems.push("DATABASE_URL이 비어 있습니다");
if (/^["']|["']$/.test(url)) problems.push("따옴표를 지워 주세요");
if (/\s/.test(url)) problems.push("띄어쓰기나 줄바꿈이 들어 있습니다");
if (url && !/^postgres(ql)?:\/\//.test(url)) problems.push("postgresql:// 로 시작해야 합니다");

let parsed;
try {
  parsed = new URL(url);
} catch {
  problems.push("주소 형식이 올바르지 않습니다");
}
if (parsed && !parsed.password) problems.push("비밀번호가 빠져 있습니다 (Show password 후 다시 복사)");

if (problems.length) {
  console.log("형식 문제:\n- " + problems.join("\n- "));
  process.exit(1);
}

console.log(`호스트: ${parsed.hostname}`);
console.log(`DB 이름: ${parsed.pathname.slice(1)}`);

const sql = neon(url);
const [row] = await sql`select version() as version, current_database() as db, now() as now`;
console.log(`접속 성공: ${row.version.split(",")[0]}`);
console.log(`서버 시각: ${new Date(row.now).toISOString()}`);
