// TronGrid 공개 API 클라이언트. 브라우저에서 직접 호출한다 (CORS 허용, 2026-10-01 확인).
// 키 없이 초당 1~3회까지만 허용하고 넘으면 5초간 막으므로 요청 간격을 두고, 429면 기다렸다가 재시도한다.
// 무료 API 키(TRON-PRO-API-KEY)를 넣으면 제한이 넓어진다.

const BASE = "https://api.trongrid.io";
const MIN_INTERVAL_MS = 400;
const TIMEOUT_MS = 20_000;

export interface TronTx {
  txID: string;
  block_timestamp: number;
  ret?: { contractRet?: string; fee?: number }[];
  raw_data: { contract: { type: string; parameter: { value: Record<string, unknown> } }[] };
  internal_transactions?: { from_address?: string; to_address?: string; data?: { call_value?: { _?: number }; rejected?: boolean } }[];
}

export interface Trc20Transfer {
  transaction_id: string;
  block_timestamp: number;
  from: string;
  to: string;
  type: string;
  value: string;
  token_info: { symbol?: string; address: string; decimals?: number; name?: string };
}

export interface TronAccount {
  address: string;
  balance?: number; // sun
  frozenV2?: { amount?: number; type?: string }[];
  unfrozenV2?: { unfreeze_amount?: number }[];
  trc20?: Record<string, string>[];
  assetV2?: { key: string; value: number }[]; // TRC10 (토큰 ID → 원시 수량)
}

export class TronGrid {
  private next = 0;
  constructor(private apiKey?: string) {}

  private async pace() {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + MIN_INTERVAL_MS;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }

  async get<T>(pathOrUrl: string): Promise<T> {
    return this.request<T>(pathOrUrl);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, JSON.stringify(body));
  }

  private async request<T>(pathOrUrl: string, body?: string): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}${pathOrUrl}`;
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      let res: Response;
      try {
        res = await fetch(url, {
          method: body ? "POST" : "GET",
          body,
          headers: {
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(this.apiKey ? { "TRON-PRO-API-KEY": this.apiKey } : {}),
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        if (attempt < 3) continue;
        throw new Error("TronGrid 서버에 연결할 수 없습니다");
      }
      if (res.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 6000)); // 차단 5초 + 여유
        continue;
      }
      if (!res.ok) throw new Error(`TronGrid 조회 실패 (HTTP ${res.status})`);
      return res.json();
    }
  }

  async account(address: string): Promise<TronAccount | null> {
    const r = await this.get<{ data: TronAccount[] }>(`/v1/accounts/${address}`);
    return r.data?.[0] ?? null; // 한 번도 쓰이지 않은 주소는 빈 목록
  }

  // meta.links.next(fingerprint)를 따라 모든 페이지를 읽는다
  async pages<T>(path: string, onPage: (n: number) => void = () => {}): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = path;
    while (url) {
      const r: { data?: T[]; meta?: { links?: { next?: string } } } = await this.get(url);
      out.push(...(r.data ?? []));
      onPage(out.length);
      url = r.meta?.links?.next;
    }
    return out;
  }
}
