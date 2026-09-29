// Esplora API 클라이언트 (mempool.space, Blockstream, 개인 mempool/Electrs 노드 공통).
// 키가 필요 없고 CORS를 허용해 브라우저에서 직접 호출한다.

export const DEFAULT_ESPLORA = "https://mempool.space/api";
// 기본 서버에 연결되지 않을 때 쓰는 대체 공개 서버 (같은 Esplora API).
// 사용자가 개인 노드를 지정한 경우에는 주소가 제3자에게 가지 않도록 쓰지 않는다.
const PUBLIC_FALLBACKS = ["https://blockstream.info/api"];

export interface AddressStats {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  mempool_stats: { tx_count: number };
}

export interface EsploraTx {
  txid: string;
  fee: number; // sats
  status: { confirmed: boolean; block_height?: number; block_time?: number };
  vin: { is_coinbase: boolean; prevout: { scriptpubkey_address?: string; value: number } | null }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}

// 요청 사이 최소 간격 (공개 서버 기준 초당 약 5건)
const MIN_INTERVAL_MS = 200;

export class Esplora {
  private nextSlot = 0;
  private bases: string[];

  constructor(base: string = DEFAULT_ESPLORA) {
    const b = base.replace(/\/+$/, "");
    this.bases = b === DEFAULT_ESPLORA ? [b, ...PUBLIC_FALLBACKS] : [b];
  }

  private get base() {
    return this.bases[0];
  }

  private async pace() {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + MIN_INTERVAL_MS;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }

  // 공개 서버는 요청이 몰리면 429를 주거나 연결을 끊는다. 둘 다 간격을 늘려 재시도한다.
  private async get<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      const wait = () => new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      let res: Response;
      try {
        res = await fetch(`${this.base}${path}`);
      } catch (e) {
        // 연결 자체가 안 되면 대체 서버로 바꿔 즉시 다시 시도한다.
        if (this.bases.length > 1 && attempt >= 1) {
          this.bases.shift();
          attempt = -1;
          continue;
        }
        if (attempt < 5) {
          await wait();
          continue;
        }
        throw new Error(`비트코인 조회 서버에 연결할 수 없습니다 (${e instanceof Error ? e.message : e})`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await wait();
        continue;
      }
      if (!res.ok) throw new Error(`비트코인 조회 실패 (HTTP ${res.status})`);
      return res.json();
    }
  }

  addressStats(address: string) {
    return this.get<AddressStats>(`/address/${address}`);
  }

  // 확정된 트랜잭션을 모두 가져온다 (한 번에 25건씩, 최신순).
  async addressTxs(address: string): Promise<EsploraTx[]> {
    const out: EsploraTx[] = [];
    let lastSeen: string | null = null;
    for (;;) {
      const path: string = lastSeen ? `/address/${address}/txs/chain/${lastSeen}` : `/address/${address}/txs/chain`;
      const page = await this.get<EsploraTx[]>(path);
      out.push(...page);
      if (page.length < 25) return out;
      lastSeen = page[page.length - 1].txid;
    }
  }
}

// 공개 API 부담을 줄이려고 동시에 몇 개씩만 실행한다.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
