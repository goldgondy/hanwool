import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { db } from "@/db";
import * as schema from "@/db/schema";

// 앱 등록 정보(Client ID·Secret)가 설정된 소셜 로그인만 켠다.
function provider(prefix: string) {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

const socialProviders = Object.fromEntries(
  Object.entries({ kakao: provider("KAKAO"), naver: provider("NAVER"), google: provider("GOOGLE") }).filter(([, v]) => v),
);

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  socialProviders,
  user: {
    additionalFields: {
      // client: 고객, accountant: 세무사, staff: 직원. 사용자가 스스로 바꿀 수 없다 (input: false).
      role: { type: "string", required: true, defaultValue: "client", input: false },
    },
  },
  plugins: [
    magicLink({
      // TODO: 이메일 발송 서비스 연결. 그 전까지는 개발 서버 콘솔에 링크를 출력한다.
      sendMagicLink: async ({ email, url }) => {
        if (process.env.NODE_ENV === "production") throw new Error("이메일 발송이 아직 설정되지 않았습니다");
        console.log(`[magic link] ${email} → ${url}`);
      },
    }),
    nextCookies(), // 반드시 마지막
  ],
});

export type Session = typeof auth.$Infer.Session;
