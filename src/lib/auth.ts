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

// 카카오: 동의항목에 설정하지 않은 항목을 요청하면 로그인이 거부된다(KOE205).
// 기본 요청(이메일·프로필 사진·닉네임) 대신 KAKAO_SCOPES로 정한 항목만 요청한다.
// 비즈 앱이 아니면 이메일을 못 받을 수 있어, 그때는 회원번호 기반 임시 주소로 가입시킨다
// (.invalid는 실제로 존재할 수 없는 도메인이다). 연락용 이메일은 고객 정보 단계에서 따로 받는다.
function kakaoProvider() {
  const base = provider("KAKAO");
  if (!base) return undefined;
  return {
    ...base,
    disableDefaultScope: true,
    scope: (process.env.KAKAO_SCOPES ?? "profile_nickname,account_email").split(",").map((s) => s.trim()).filter(Boolean),
    mapProfileToUser: (profile: { id: number | string; kakao_account?: { email?: string } }) =>
      profile.kakao_account?.email ? {} : { email: `kakao-${profile.id}@no-email.invalid`, emailVerified: false },
  };
}

const socialProviders = Object.fromEntries(
  Object.entries({ kakao: kakaoProvider(), naver: provider("NAVER"), google: provider("GOOGLE") }).filter(([, v]) => v),
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
