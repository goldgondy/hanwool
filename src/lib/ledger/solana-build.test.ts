import { describe, expect, it } from "vitest";
import type { SolTokenBalance, SolTx } from "@/lib/solana/rpc";
import { buildSolanaEntries, discoverStakeAccounts } from "./solana-build";

// 공식 RPC jsonParsed 응답 형식을 따른 가짜 데이터
const ME = "MeWa11et1111111111111111111111111111111111";
const OTHER = "0therWa11et111111111111111111111111111111";
const MY_ATA = "MyUsdcAta11111111111111111111111111111111";
const OTHER_ATA = "0therUsdcAta1111111111111111111111111111";
const POOL = "Poo1111111111111111111111111111111111111111";
const STAKE = "MyStake111111111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RENT = 2_039_280;

const tb = (accountIndex: number, owner: string, amount: string, mint = USDC, decimals = 6): SolTokenBalance => ({
  accountIndex,
  mint,
  owner,
  uiTokenAmount: { amount, decimals },
});

function tx(sig: string, keys: string[], pre: number[], post: number[], opts: Partial<NonNullable<SolTx["meta"]>> = {}): SolTx {
  return {
    slot: 1,
    blockTime: 1_800_000_000,
    meta: { err: null, fee: 5000, preBalances: pre, postBalances: post, ...opts },
    transaction: { signatures: [sig], message: { accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0 })), instructions: [] } },
  };
}

const build = (txs: SolTx[], stake: string[] = []) =>
  buildSolanaEntries({ sourceId: "s", address: ME, txs, stakeAccounts: new Set(stake), tokenAccounts: new Set(), symbols: new Map([[USDC, "USDC"]]) });
const brief = (es: ReturnType<typeof build>) => es.map((e) => [e.kind, e.asset, e.amount, e.counterparty]);

describe("buildSolanaEntries", () => {
  it("SOL 송금: 수수료와 보낸 금액을 따로 기록한다", () => {
    const r = build([tx("a", [ME, OTHER], [10e9, 0], [10e9 - 1e9 - 5000, 1e9])]);
    expect(brief(r)).toEqual([
      ["fee", "SOL", "-0.000005", undefined],
      ["transfer", "SOL", "-1", OTHER],
    ]);
  });

  it("토큰 입금: 보낸 사람이 내 토큰 계정을 만들어 준 보증금(rent)도 내 SOL로 잡는다", () => {
    const r = build([
      tx("b", [OTHER, OTHER_ATA, MY_ATA, ME], [5e9, RENT, 0, 1e9], [5e9 - RENT - 5000, RENT, RENT, 1e9], {
        preTokenBalances: [tb(1, OTHER, "100000000")],
        postTokenBalances: [tb(1, OTHER, "50000000"), tb(2, ME, "50000000")],
      }),
    ]);
    expect(brief(r)).toEqual([
      ["transfer", "SOL", "0.00203928", OTHER],
      ["transfer", "USDC", "50", OTHER],
    ]);
    expect(r[1].assetKey).toBe(`sol:${USDC}`);
  });

  it("내가 만든 토큰 계정의 보증금은 외부 이동이 아니다 (SOL 변화 없음, 수수료만)", () => {
    const r = build([
      tx("c", [ME, MY_ATA], [1e9, 0], [1e9 - RENT - 5000, RENT], {
        postTokenBalances: [tb(1, ME, "0")],
      }),
    ]);
    expect(brief(r)).toEqual([["fee", "SOL", "-0.000005", undefined]]);
  });

  it("스왑 SOL → USDC: 임시 WSOL 계정은 생겼다 사라져 결과만 남는다", () => {
    const r = build([
      tx("d", [ME, MY_ATA, POOL], [3e9, RENT, 100e9], [3e9 - 1e9 - 5000, RENT, 101e9], {
        preTokenBalances: [tb(1, ME, "0"), tb(3, POOL, "999000000")],
        postTokenBalances: [tb(1, ME, "150000000"), tb(3, POOL, "849000000")],
      }),
    ]);
    expect(brief(r)).toEqual([
      ["fee", "SOL", "-0.000005", undefined],
      ["trade", "SOL", "-1", POOL],
      ["trade", "USDC", "150", POOL],
    ]);
  });

  it("스테이킹 위임: 내 스테이킹 계정으로 옮긴 SOL은 내 자산이라 수수료만 남는다", () => {
    const r = build([tx("e", [ME, STAKE], [10e9, 0], [10e9 - 5e9 - 5000, 5e9])], [STAKE]);
    expect(brief(r)).toEqual([["fee", "SOL", "-0.000005", undefined]]);
  });

  it("실패한 거래도 수수료는 나간다", () => {
    const t = tx("f", [ME, OTHER], [1e9, 0], [1e9 - 5000, 0]);
    t.meta!.err = { InstructionError: [0, "Custom"] };
    expect(brief(build([t]))).toEqual([["fee", "SOL", "-0.000005", undefined]]);
  });
});

describe("discoverStakeAccounts", () => {
  const ix = (type: string, info: Record<string, unknown>) => ({ program: "stake", programId: "Stake11111111111111111111111111111111111111", parsed: { type, info } });
  const withIx = (...ixs: ReturnType<typeof ix>[]) => {
    const t = tx("g", [ME], [0], [0]);
    t.transaction.message.instructions = ixs;
    return t;
  };

  it("내가 출금 권한자인 생성·분할 계정만 찾고, 풀의 스테이킹 계정은 제외한다", () => {
    const found = discoverStakeAccounts(
      [
        withIx(ix("initialize", { stakeAccount: STAKE, authorized: { staker: ME, withdrawer: ME } })),
        withIx(ix("split", { stakeAccount: "PoolStake", newSplitAccount: "NewMine", stakeAuthority: "PoolAuthority" }), ix("authorize", { stakeAccount: "NewMine", newAuthority: ME, authorityType: "Withdrawer" })),
        withIx(ix("split", { stakeAccount: STAKE, newSplitAccount: "Split2", stakeAuthority: ME })),
      ],
      ME,
    );
    expect([...found].sort()).toEqual(["MyStake111111111111111111111111111111111111", "NewMine", "Split2"].sort());
  });
});
