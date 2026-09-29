// 스키마 보안 설정 확인: 모든 public 테이블 RLS 여부, audit_log 수정·삭제 차단
// 실행: node --env-file=.env.local scripts/db-verify.mjs
import postgres from "postgres";

const sql = postgres(process.env.SUPABASE_DATABASE_URL, { prepare: false, max: 1 });
try {
  const tables = await sql`
    select c.relname as name, c.relrowsecurity as rls,
      (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)::int as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname`;
  for (const t of tables) console.log(`${t.rls ? "RLS ON " : "RLS OFF"}  정책 ${t.policies}  ${t.name}`);
  const off = tables.filter((t) => !t.rls && !t.name.startsWith("__drizzle"));
  console.log(off.length ? `\n⚠ RLS 꺼진 테이블: ${off.map((t) => t.name).join(", ")}` : "\n모든 서비스 테이블 RLS 켜짐");

  const [{ id }] = await sql`insert into audit_log (action, detail) values ('test.append_only_check', '{"note":"보안 설정 확인용"}') returning id`;
  for (const [label, q] of [
    ["UPDATE", sql`update audit_log set action = 'tampered' where id = ${id}`],
    ["DELETE", sql`delete from audit_log where id = ${id}`],
  ]) {
    try {
      await q;
      console.log(`⚠ audit_log ${label} 허용됨`);
    } catch (e) {
      console.log(`audit_log ${label} 차단됨: ${e.message}`);
    }
  }
} finally {
  await sql.end();
}
