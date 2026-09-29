import { deriveAddress, type ParsedWallet } from "./descriptor";
import { mapLimit, type AddressStats, type Esplora } from "./esplora";

export interface UsedAddress {
  address: string;
  path: string; // "0/5" 등, 단일 주소는 ""
  stats: AddressStats;
}

export const DEFAULT_GAP_LIMIT = 20;

// 받는 주소(0/*)와 거스름돈 주소(1/*)를 차례로 계산하며, 연속으로 gapLimit개가 쓰이지 않으면 멈춘다.
export async function scanWallet(
  wallet: ParsedWallet,
  esplora: Esplora,
  gapLimit = DEFAULT_GAP_LIMIT,
  onProgress: (msg: string) => void = () => {},
): Promise<UsedAddress[]> {
  if (wallet.kind === "address") {
    const stats = await esplora.addressStats(wallet.address);
    return [{ address: wallet.address, path: "", stats }];
  }

  const used: UsedAddress[] = [];
  for (const chain of [0, 1] as const) {
    let index = 0;
    let lastUsed = -1;
    while (index - lastUsed <= gapLimit) {
      // gap 한 묶음씩 병렬로 조회한다.
      const batch = Array.from({ length: gapLimit }, (_, k) => index + k);
      const results = await mapLimit(batch, 2, async (i) => {
        const address = deriveAddress(wallet, chain, i);
        return { i, address, stats: await esplora.addressStats(address) };
      });
      for (const r of results) {
        if (r.stats.chain_stats.tx_count + r.stats.mempool_stats.tx_count > 0) {
          used.push({ address: r.address, path: `${chain}/${r.i}`, stats: r.stats });
          lastUsed = r.i;
        }
      }
      index += gapLimit;
      onProgress(`${chain === 0 ? "받는" : "거스름돈"} 주소 ${index}개 확인, 사용된 주소 ${used.length}개`);
    }
  }
  return used;
}

// 확정 잔고 (satoshi)
export function confirmedBalanceSats(used: UsedAddress[]) {
  return used.reduce(
    (s, u) => s + BigInt(u.stats.chain_stats.funded_txo_sum) - BigInt(u.stats.chain_stats.spent_txo_sum),
    BigInt(0),
  );
}
