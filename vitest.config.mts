import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test/empty.ts", import.meta.url)),
    },
  },
  test: {
    // 실제 DB·외부 API를 쓰는 테스트(*.live.test.ts)는 기본 실행에서 제외하고 npm run test:live로 따로 돌린다.
    exclude:
      process.env.npm_lifecycle_event === "test:live"
        ? ["**/node_modules/**"]
        : ["**/node_modules/**", "**/*.live.test.ts"],
  },
});
