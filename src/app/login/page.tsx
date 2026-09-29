import { LoginForm, type Provider } from "./login-form";

// 앱 등록 정보가 설정된 소셜 로그인만 버튼으로 보여 준다 (lib/auth.ts와 같은 기준).
export const dynamic = "force-dynamic";

export default function LoginPage() {
  const providers: Provider[] = (["kakao", "naver", "google"] as const).filter(
    (p) => process.env[`${p.toUpperCase()}_CLIENT_ID`] && process.env[`${p.toUpperCase()}_CLIENT_SECRET`],
  );
  return <LoginForm providers={providers} />;
}
