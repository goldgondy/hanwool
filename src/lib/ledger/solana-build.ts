import Decimal from "@/lib/decimal";
import type { LedgerEntry } from "@/lib/db";
import { STAKE_PROGRAM, WSOL_MINT, type SolIx, type SolTokenBalance, type SolTx } from "@/lib/solana/rpc";

// 솔라나 내역 → 원장. 거래 전후 잔고 차이로 계산한다 (명령어를 해석하지 않아 스왑·DeFi도 그대로 맞는다).
// "내 SOL" = 지갑 + 내 토큰 계정에 묶인 보증금(rent) + 내 스테이킹 계정. 이렇게 묶어야
// 토큰 계정 생성·해지, 스테이킹 위임·해제가 외부 이동으로 잘못 잡히지 않는다. 실제 잔고도 같은 기준으로 센다.
// - 1 SOL = 1,000,000,000 lamports
// - 수수료는 수수료 지불자(첫 번째 서명자)가 낸다. 실패한 거래도 수수료는 나간다.
// - WSOL(래핑된 SOL)은 토큰으로 따로 기록하고, 그 토큰 계정의 lamports 중 래핑분은 SOL에서 뺀다.
// - 스테이킹 보상은 거래 없이 스테이킹 계정에 쌓이므로 lib/ledger/solana-sync.ts에서 따로 기록한다.

export const SOL_NATIVE_KEY = "sol:native";
export const solTokenKey = (mint: string) => `sol:${mint}`; // Base58은 대소문자를 구분하므로 그대로 둔다

const lamports = (n: Decimal.Value) => new Decimal(n).div(1_000_000_000);

export interface SolanaBuildInput {
  sourceId: string;
  address: string;
  txs: SolTx[];
  stakeAccounts: Set<string>; // 내가 출금 권한을 가진 스테이킹 계정
  tokenAccounts: Set<string>; // 내 토큰 계정 (오래된 거래는 토큰 잔고에 소유자가 없어 이 목록으로 판단)
  symbols: Map<string, string>; // mint → 심볼
}

export function buildSolanaEntries({ sourceId, address: me, txs, stakeAccounts, tokenAccounts, symbols }: SolanaBuildInput): LedgerEntry[] {
  const entries: LedgerEntry[] = [];

  for (const tx of txs) {
    const meta = tx.meta;
    if (!meta) continue;
    const sig = tx.transaction.signatures[0];
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
    const time = (tx.blockTime ?? 0) * 1000;
    const push = (suffix: string, asset: string, assetKey: string, amount: Decimal, kind: LedgerEntry["kind"], counterparty?: string) => {
      if (amount.isZero()) return;
      entries.push({
        id: `${sourceId}:sol:${sig}:${suffix}`,
        sourceId,
        location: "Solana",
        time,
        asset,
        assetKey,
        amount: amount.toString(),
        kind,
        groupId: `sol:${sig}`,
        txHash: sig,
        counterparty,
      });
    };

    // 토큰 계정별 소유자·잔고 (거래 전/후)
    const pre = new Map<number, SolTokenBalance>((meta.preTokenBalances ?? []).map((b) => [b.accountIndex, b]));
    const post = new Map<number, SolTokenBalance>((meta.postTokenBalances ?? []).map((b) => [b.accountIndex, b]));
    const ownerOf = (i: number) => post.get(i)?.owner ?? pre.get(i)?.owner;
    const isMine = (i: number) => {
      const k = keys[i];
      if (k === me || stakeAccounts.has(k) || tokenAccounts.has(k)) return true;
      return ownerOf(i) === me;
    };
    const rawToken = (b?: SolTokenBalance) => new Decimal(b?.uiTokenAmount.amount ?? 0);
    const tokenDelta = (i: number) => rawToken(post.get(i)).minus(rawToken(pre.get(i)));
    const mintOf = (i: number) => post.get(i)?.mint ?? pre.get(i)?.mint;

    // SOL: 내 계정들의 lamports 변화 합계 (WSOL 계정은 래핑분 제외)
    const lamportDelta = (i: number) => {
      let d = new Decimal(meta.postBalances[i] ?? 0).minus(meta.preBalances[i] ?? 0);
      if (mintOf(i) === WSOL_MINT) d = d.minus(tokenDelta(i));
      return d;
    };
    let sol = new Decimal(0);
    for (let i = 0; i < keys.length; i++) if (isMine(i)) sol = sol.plus(lamportDelta(i));
    if (keys[0] === me) {
      push("fee", "SOL", SOL_NATIVE_KEY, lamports(meta.fee).neg(), "fee");
      sol = sol.plus(meta.fee);
    }
    if (!sol.isZero()) {
      // 상대: 반대 방향으로 가장 크게 움직인 남의 계정
      let cp: string | undefined;
      let best = new Decimal(0);
      for (let i = 0; i < keys.length; i++) {
        if (isMine(i)) continue;
        const d = lamportDelta(i);
        if (d.isNeg() !== sol.isNeg() && d.abs().gt(best)) [cp, best] = [keys[i], d.abs()];
      }
      push("sol", "SOL", SOL_NATIVE_KEY, lamports(sol), "transfer", cp);
    }

    // 토큰: 내 토큰 계정의 mint별 변화 합계
    const byMint = new Map<string, { delta: Decimal; decimals: number }>();
    for (const i of new Set([...pre.keys(), ...post.keys()])) {
      if (!isMine(i)) continue;
      const mint = mintOf(i)!;
      const decimals = (post.get(i) ?? pre.get(i))!.uiTokenAmount.decimals;
      const cur = byMint.get(mint) ?? { delta: new Decimal(0), decimals };
      cur.delta = cur.delta.plus(tokenDelta(i));
      byMint.set(mint, cur);
    }
    for (const [mint, { delta, decimals }] of byMint) {
      if (delta.isZero()) continue;
      let cp: string | undefined;
      let best = new Decimal(0);
      for (const i of new Set([...pre.keys(), ...post.keys()])) {
        if (isMine(i) || mintOf(i) !== mint) continue;
        const d = tokenDelta(i);
        if (d.isNeg() !== delta.isNeg() && d.abs().gt(best)) [cp, best] = [ownerOf(i) ?? keys[i], d.abs()];
      }
      const symbol = mint === WSOL_MINT ? "WSOL" : (symbols.get(mint) ?? mint.slice(0, 6));
      push(`tok:${mint}`, symbol, solTokenKey(mint), delta.div(new Decimal(10).pow(decimals)), "transfer", cp);
    }
  }

  // 한 거래에서 서로 다른 자산이 오가면 스왑으로 표시 (EVM·트론과 같은 기준)
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries) if (e.kind !== "fee") groups.set(e.groupId, [...(groups.get(e.groupId) ?? []), e]);
  for (const legs of groups.values()) {
    const ins = new Set(legs.filter((e) => !e.amount.startsWith("-")).map((e) => e.assetKey));
    const outs = new Set(legs.filter((e) => e.amount.startsWith("-")).map((e) => e.assetKey));
    if (ins.size && outs.size && new Set([...ins, ...outs]).size > 1) legs.forEach((e) => (e.kind = "trade"));
  }
  return entries;
}

// 스테이킹 명령에서 내 스테이킹 계정을 찾는다 (생성·권한 이전·분할·병합).
// 권한자가 나인 명령만 본다. 리퀴드 스테이킹 풀 출금처럼 남의(풀) 스테이킹 계정이 함께 등장하는 경우가 있다.
export function discoverStakeAccounts(txs: SolTx[], me: string): Set<string> {
  const out = new Set<string>();
  for (const tx of txs) {
    if (!tx.meta || tx.meta.err) continue;
    const ixs: SolIx[] = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((x) => x.instructions)];
    for (const ix of ixs) {
      if (ix.programId !== STAKE_PROGRAM || typeof ix.parsed !== "object" || !ix.parsed?.info) continue;
      const type = String(ix.parsed.type);
      const info = ix.parsed.info as Record<string, unknown>;
      if (type.startsWith("initialize")) {
        const withdrawer = (info.authorized as { withdrawer?: string } | undefined)?.withdrawer ?? info.withdrawer;
        if (withdrawer === me) out.add(String(info.stakeAccount));
      } else if (type.startsWith("authorize")) {
        if (info.newAuthority === me && info.authorityType === "Withdrawer") out.add(String(info.stakeAccount));
      } else if ([info.stakeAuthority, info.withdrawAuthority, info.authority].includes(me)) {
        for (const field of ["stakeAccount", "newSplitAccount", "source"]) if (typeof info[field] === "string") out.add(info[field] as string);
        if (type === "merge" && typeof info.destination === "string") out.add(info.destination);
      }
    }
  }
  return out;
}

// 거래에서 내 토큰 계정 (토큰 잔고의 소유자가 나인 계정)
export function discoverTokenAccounts(txs: SolTx[], me: string): Set<string> {
  const out = new Set<string>();
  for (const tx of txs) {
    const keys = tx.transaction.message.accountKeys;
    for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
      if (b.owner === me) out.add(keys[b.accountIndex].pubkey);
    }
  }
  return out;
}
