// 사용자 역할 변경 (client | accountant | staff). 변경 내역은 audit_log에 남긴다.
// 실행: node --env-file=.env.local scripts/set-role.mjs <이메일> <역할>
import postgres from "postgres";

const [email, role] = process.argv.slice(2);
const ROLES = ["client", "accountant", "staff"];
if (!email || !ROLES.includes(role)) {
  console.log(`사용법: node --env-file=.env.local scripts/set-role.mjs <이메일> <${ROLES.join("|")}>`);
  process.exit(1);
}

const sql = postgres(process.env.SUPABASE_DATABASE_URL, { prepare: false, max: 1 });
try {
  await sql.begin(async (tx) => {
    const [before] = await tx`select id, role from "user" where email = ${email}`;
    if (!before) throw new Error(`사용자를 찾지 못했습니다: ${email}`);
    if (before.role === role) {
      console.log(`이미 ${role} 역할입니다`);
      return;
    }
    await tx`update "user" set role = ${role}, updated_at = now() where id = ${before.id}`;
    await tx`
      insert into audit_log (action, detail)
      values ('user.role_changed', ${tx.json({ userId: before.id, email, from: before.role, to: role, via: "scripts/set-role.mjs" })})`;
    console.log(`${email}: ${before.role} → ${role}`);
  });
} finally {
  await sql.end();
}
