"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await authClient.signOut();
        router.push("/login");
      }}
      className="rounded-lg border border-stone-300 px-4 py-2 text-sm dark:border-stone-700"
    >
      로그아웃
    </button>
  );
}
