import { headers } from "next/headers";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { SignOutButton } from "./sign-out";

// 로그인 확인용 화면: 현재 세션의 사용자 정보와 역할
export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = { client: "고객", accountant: "세무사", staff: "직원" };

export default async function MePage() {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    return (
      <div className="mx-auto max-w-sm space-y-3 py-8 text-center">
        <p>로그인되어 있지 않습니다.</p>
        <Link href="/login" className="underline">
          로그인
        </Link>
      </div>
    );
  }

  const { user } = session;
  return (
    <div className="mx-auto max-w-sm space-y-4 py-8">
      <h1 className="text-xl font-bold">로그인됨</h1>
      <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
        <dt className="text-stone-500">이름</dt>
        <dd>{user.name}</dd>
        <dt className="text-stone-500">이메일</dt>
        <dd>{user.email}</dd>
        <dt className="text-stone-500">역할</dt>
        <dd>{ROLE_LABEL[user.role] ?? user.role}</dd>
      </dl>
      <SignOutButton />
    </div>
  );
}
