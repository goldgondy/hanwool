// 실데이터: 거래가 적당한 솔라나 지갑의 전체 내역(스테이킹 보상 포함) → 원장 → 실제 잔고 대사
// 스테이킹 지갑 하나(2026-10-01: 스테이킹 계정 10개·보상 38건·SOL 일치), 토큰 지갑 하나를 고른다.
import { it } from "vitest";
import { collectSolana, solanaBalances } from "./solana-sync";
import { reconcile } from "./reconcile";
import { OFFICIAL_RPC, SolanaRpc, STAKE_PROGRAM, WSOL_MINT, type SolSignature } from "@/lib/solana/rpc";

const rpc = new SolanaRpc(OFFICIAL_RPC, 400);

async function suitable(address: string) {
  const sigs = await rpc.call<SolSignature[]>("getSignaturesForAddress", [address, { limit: 400 }]);
  const ok = sigs.length < 400 && sigs.length >= 10;
  if (!ok) console.log(`skip ${address}: sigs ${sigs.length}`);
  return ok;
}

async function check(address: string) {
  const started = Date.now();
  const { entries, state } = await collectSolana(rpc, "live", address, { sigs: {}, stake: [], tokens: [], rewardNext: {} });
  const symbols = new Map(entries.map((e) => [e.assetKey, e.asset]));
  const rows = reconcile(entries, await solanaBalances(rpc, address, symbols));
  const rewards = entries.filter((e) => e.tag === "reward").length;
  console.log(`\n${address}: entries ${entries.length}, rewards ${rewards}, stake ${state.stake.length}, tokenAccts ${state.tokens.length}, ${Math.round((Date.now() - started) / 1000)}s`);
  for (const r of rows) console.log(`${r.diff.isZero() ? "OK  " : "DIFF"} ${r.asset.padEnd(8)} ledger=${r.ledger.toFixed()} actual=${r.actual.toFixed()} diff=${r.diff.toFixed()}`);
}

// 최근 거래에서 조건에 맞는 지갑 주소를 찾는다
async function pick(program: string, extract: (tx: NonNullable<Awaited<ReturnType<SolanaRpc["transaction"]>>>) => string | undefined) {
  const tried = new Set<string>();
  for (const s of await rpc.call<SolSignature[]>("getSignaturesForAddress", [program, { limit: 300 }])) {
    if (s.err) continue;
    const tx = await rpc.transaction(s.signature);
    const address = tx && extract(tx);
    if (!address || tried.has(address)) continue;
    tried.add(address);
    if (await suitable(address)) return address;
  }
}

it("solana live reconcile: token wallet", { timeout: 1_800_000 }, async () => {
  // WSOL을 쓰는 거래(스왑 등)의 수수료 지불자
  const address = await pick(WSOL_MINT, (tx) => tx.transaction.message.accountKeys[0].pubkey);
  if (address) await check(address);
  else console.log("적당한 주소를 찾지 못함");
});

it.skip("solana live reconcile: staking wallet", { timeout: 1_800_000 }, async () => {
  const address = await pick(STAKE_PROGRAM, (tx) => {
    const ix = tx.transaction.message.instructions.find((i) => typeof i.parsed === "object" && i.parsed?.type === "delegate");
    return ix && typeof ix.parsed === "object" ? String(ix.parsed.info?.stakeAuthority) : undefined;
  });
  if (address) await check(address);
  else console.log("적당한 주소를 찾지 못함");
});
