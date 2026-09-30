// 실데이터 확인: 사용 체인 자동 탐색 결과와 소요 시간, 잔고 조회 소요 시간
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { detectActiveChains, fetchEvmBalances } from "./evm";

const TEST = "0x75541197f23762e65ffa7cb48cf881ef15fbc366";

it("detect active chains", { timeout: 90_000 }, async () => {
  let t = Date.now();
  const r = await detectActiveChains(TEST);
  console.log(JSON.stringify(r), `${Date.now() - t}ms`);
  expect(r.find((x) => x.chain === "eth")?.status).toBe("active");
  expect(r.find((x) => x.chain === "arb")?.status).toBe("active");
  expect(r.find((x) => x.chain === "base")?.status).toBe("inactive");

  t = Date.now();
  const fresh = await detectActiveChains("0x" + randomBytes(20).toString("hex"));
  console.log("random address:", JSON.stringify(fresh), `${Date.now() - t}ms`);
  expect(fresh.every((x) => x.status === "inactive")).toBe(true);

  t = Date.now();
  const bal = await fetchEvmBalances({ id: "x", kind: "evm", label: "x", address: TEST, chains: ["eth", "arb", "base", "opt", "polygon"], createdAt: 0 });
  console.log(`balances ${bal.length} items ${Date.now() - t}ms`);
});
