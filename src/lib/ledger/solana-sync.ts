import Decimal from "@/lib/decimal";
import { db, getSetting, type LedgerEntry, type SolanaSource } from "@/lib/db";
import { buildSolanaEntries, discoverStakeAccounts, discoverTokenAccounts, SOL_NATIVE_KEY, solTokenKey } from "@/lib/ledger/solana-build";
import {
  OFFICIAL_RPC,
  RELAY_PATH,
  SLOTS_PER_EPOCH,
  SolanaRpc,
  STAKE_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
  type SolTx,
} from "@/lib/solana/rpc";
import type { RawBalance } from "@/lib/sources/types";

// 증분 동기화 상태 (syncState `${id}:sol`)
interface SolState {
  sigs: Record<string, string>; // 계정 → 마지막으로 본 최신 서명
  stake: string[];
  tokens: string[];
  rewardNext: Record<string, number>; // 스테이킹 계정 → 다음에 조회할 보상 에포크
}

// Helius 키가 있으면 브라우저에서 직접, 없으면 서버 중계로 공식 RPC를 쓴다 (lib/solana/rpc.ts)
export async function solanaRpc(): Promise<SolanaRpc> {
  if (typeof window === "undefined") return new SolanaRpc(OFFICIAL_RPC); // 테스트(Node)
  const key = await getSetting("heliusKey");
  return key ? new SolanaRpc(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, 120) : new SolanaRpc(RELAY_PATH);
}

// 토큰 이름은 블록체인 거래에 없어 Jupiter 토큰 목록에서 받는다 (100개씩, CORS 허용)
export async function fetchSymbols(mints: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    try {
      const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${chunk.join(",")}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      for (const t of (await res.json()) as { id: string; symbol?: string }[]) if (t.symbol) out.set(t.id, t.symbol.toUpperCase());
    } catch {
      // 이름을 못 받으면 mint 앞자리로 표시한다
    }
  }
  return out;
}

export interface SolanaSyncResult {
  added: number;
  warnings: string[];
}

export async function syncSolanaHistory(source: SolanaSource, onProgress: (msg: string) => void = () => {}, rpcOverride?: SolanaRpc): Promise<SolanaSyncResult> {
  const rpc = rpcOverride ?? (await solanaRpc());
  const me = source.address;
  const stateKey = `${source.id}:sol`;
  const saved = await db.syncState.get(stateKey);
  const state: SolState = saved ? JSON.parse(saved.cursor) : { sigs: {}, stake: [], tokens: [], rewardNext: {} };
  const result = await collectSolana(rpc, source.id, me, state, onProgress);

  const existing = await db.ledger.bulkGet(result.entries.map((e) => e.id));
  await db.transaction("rw", db.ledger, db.syncState, async () => {
    await db.ledger.bulkPut(result.entries);
    await db.syncState.put({ key: stateKey, cursor: JSON.stringify(result.state), syncedAt: Date.now() });
  });
  return { added: existing.filter((x) => !x).length, warnings: result.warnings };
}

// 저장소와 무관한 수집 단계 (실데이터 테스트에서도 쓴다)
export async function collectSolana(rpc: SolanaRpc, sourceId: string, me: string, state: SolState, onProgress: (msg: string) => void = () => {}) {
  const warnings: string[] = [];
  const txs = new Map<string, SolTx>();
  const firstSlot = new Map<string, number>(); // 스테이킹 계정별 가장 오래된 거래 슬롯
  const newestSig: Record<string, string> = { ...state.sigs };

  const fetchFor = async (account: string, includeFailed: boolean) => {
    const sigs = await rpc.signatures(account, state.sigs[account], (n) => onProgress(`솔라나 거래 목록 조회 중 (${n}건)`));
    if (sigs.length) {
      newestSig[account] = sigs[0].signature;
      firstSlot.set(account, sigs[sigs.length - 1].slot);
    }
    const todo = sigs.filter((s) => (includeFailed || !s.err) && !txs.has(s.signature));
    for (const [i, s] of todo.entries()) {
      onProgress(`솔라나 거래 조회 중 (${i + 1}/${todo.length})`);
      const tx = await rpc.transaction(s.signature);
      if (tx) txs.set(s.signature, tx);
    }
  };

  // 1) 지갑 주소의 거래 (실패한 거래도 수수료가 나가므로 포함)
  await fetchFor(me, true);

  // 2) 내 토큰 계정·스테이킹 계정: 남이 보낸 토큰 입금은 지갑 주소가 아닌 토큰 계정에만 기록된다
  onProgress("토큰·스테이킹 계정 확인 중");
  const current = await currentAccounts(rpc, me);
  const ownerTxs = [...txs.values()];
  const tokens = new Set([...state.tokens, ...current.tokens, ...discoverTokenAccounts(ownerTxs, me)]);
  const stake = new Set([...state.stake, ...current.stake, ...discoverStakeAccounts(ownerTxs, me)]);
  for (const acc of [...tokens, ...stake]) await fetchFor(acc, false);

  const mints = new Set<string>();
  for (const tx of txs.values()) for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) mints.add(b.mint);
  const symbols = await fetchSymbols([...mints].filter((m) => m !== WSOL_MINT));
  const entries = buildSolanaEntries({ sourceId, address: me, txs: [...txs.values()], stakeAccounts: stake, tokenAccounts: tokens, symbols });

  // 3) 스테이킹 보상 (에포크마다 스테이킹 계정에 거래 없이 쌓인다)
  const rewardNext = { ...state.rewardNext };
  if (stake.size) {
    const { epoch } = await rpc.call<{ epoch: number }>("getEpochInfo", []);
    for (const acc of stake) rewardNext[acc] ??= Math.floor((firstSlot.get(acc) ?? epoch * SLOTS_PER_EPOCH) / SLOTS_PER_EPOCH);
    entries.push(...(await stakingRewards(rpc, sourceId, rewardNext, epoch - 1, onProgress)));
    for (const acc of stake) rewardNext[acc] = Math.max(rewardNext[acc], epoch);
  }

  return {
    entries,
    warnings,
    state: { sigs: newestSig, stake: [...stake], tokens: [...tokens], rewardNext } satisfies SolState,
  };
}

async function currentAccounts(rpc: SolanaRpc, me: string) {
  const tokens: string[] = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const r = await rpc.call<{ value: { pubkey: string }[] }>("getTokenAccountsByOwner", [me, { programId }, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    tokens.push(...r.value.map((a) => a.pubkey));
  }
  const stake = (await stakeAccountsOf(rpc, me)).map((a) => a.pubkey);
  return { tokens, stake };
}

// 출금 권한자가 나인 스테이킹 계정 (계정 데이터의 44번째 바이트부터 출금 권한자)
function stakeAccountsOf(rpc: SolanaRpc, me: string) {
  return rpc.call<{ pubkey: string; account: { lamports: number } }[]>("getProgramAccounts", [
    STAKE_PROGRAM,
    { encoding: "base64", dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 44, bytes: me } }] },
  ]);
}

async function stakingRewards(rpc: SolanaRpc, sourceId: string, next: Record<string, number>, lastEpoch: number, onProgress: (msg: string) => void): Promise<LedgerEntry[]> {
  const out: LedgerEntry[] = [];
  const accounts = Object.keys(next);
  const from = Math.min(...accounts.map((a) => next[a]));
  for (let epoch = from; epoch <= lastEpoch; epoch++) {
    onProgress(`스테이킹 보상 조회 중 (에포크 ${epoch}/${lastEpoch})`);
    const accs = accounts.filter((a) => next[a] <= epoch);
    if (!accs.length) continue;
    const r = await rpc.call<({ amount: number; effectiveSlot: number } | null)[]>("getInflationReward", [accs, { epoch }]);
    const got = accs.map((a, i) => [a, r[i]] as const).filter(([, x]) => x && x.amount > 0);
    if (!got.length) continue;
    const blockTime = await rpc.call<number | null>("getBlockTime", [got[0][1]!.effectiveSlot]);
    for (const [acc, x] of got) {
      out.push({
        id: `${sourceId}:sol:reward:${epoch}:${acc}`,
        sourceId,
        location: "Solana",
        time: (blockTime ?? 0) * 1000,
        asset: "SOL",
        assetKey: SOL_NATIVE_KEY,
        amount: new Decimal(x!.amount).div(1_000_000_000).toString(),
        kind: "income",
        groupId: `sol:reward:${epoch}:${acc}`,
        counterparty: acc,
        tag: "reward",
        rawType: "Staking reward",
      });
    }
  }
  return out;
}

// 실제 잔고: 원장과 같은 기준으로 지갑 + 토큰 계정 보증금 + 스테이킹 계정을 SOL로 합친다
export async function fetchSolanaBalances(source: SolanaSource): Promise<RawBalance[]> {
  const symbols = new Map<string, string>();
  for (const e of await db.ledger.where("sourceId").equals(source.id).toArray()) symbols.set(e.assetKey, e.asset);
  return solanaBalances(await solanaRpc(), source.address, symbols);
}

export async function solanaBalances(rpc: SolanaRpc, me: string, symbols: Map<string, string>): Promise<RawBalance[]> {
  let sol = new Decimal((await rpc.call<{ value: number }>("getBalance", [me])).value);
  const byMint = new Map<string, Decimal>();
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const r = await rpc.call<{ value: { account: { lamports: number; data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } }[] }>(
      "getTokenAccountsByOwner",
      [me, { programId }, { encoding: "jsonParsed" }],
    );
    for (const { account } of r.value) {
      const { mint, tokenAmount } = account.data.parsed.info;
      const raw = new Decimal(tokenAmount.amount);
      sol = sol.plus(account.lamports).minus(mint === WSOL_MINT ? raw : 0);
      byMint.set(mint, (byMint.get(mint) ?? new Decimal(0)).plus(raw.div(new Decimal(10).pow(tokenAmount.decimals))));
    }
  }
  for (const s of await stakeAccountsOf(rpc, me)) sol = sol.plus(s.account.lamports);

  const out: RawBalance[] = [];
  if (!sol.isZero()) out.push({ location: "Solana", asset: "SOL", rawAsset: "SOL", assetKey: SOL_NATIVE_KEY, amount: sol.div(1_000_000_000) });
  const missing = [...byMint.keys()].filter((m) => m !== WSOL_MINT && !symbols.has(solTokenKey(m)));
  const fetched = missing.length ? await fetchSymbols(missing) : new Map<string, string>();
  for (const [mint, amount] of byMint) {
    if (amount.isZero()) continue;
    const key = solTokenKey(mint);
    const asset = mint === WSOL_MINT ? "WSOL" : (symbols.get(key) ?? fetched.get(mint) ?? mint.slice(0, 6));
    out.push({ location: "Solana", asset, rawAsset: mint, assetKey: key, amount });
  }
  return out;
}
