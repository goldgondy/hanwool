import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

// Better Auth 전체 엔드포인트 (로그인, 소셜 콜백 /api/auth/callback/kakao 등)
export const { GET, POST } = toNextJsHandler(auth);
