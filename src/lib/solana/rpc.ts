// 솔라나 JSON-RPC 클라이언트. 응답 형식 확인: 2026-10-01
// - 공식 RPC(api.mainnet-beta.solana.com)는 브라우저 요청(Origin 헤더)을 403으로 막으므로 /api/relay/solana 중계를 거친다.
// - CORS를 허용하는 공개 노드(publicnode 등)는 최근 하루 정도만 보관해 과거 내역을 받을 수 없다.
// - 사용자가 Helius 무료 키를 넣으면 브라우저에서 직접 조회한다 (전체 기록 보관, CORS 허용).
// 공식 RPC는 IP당 10초에 100건(메서드별 40건)까지라 요청 간격을 두고, 429면 기다렸다가 재시도한다.

export const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const OFFICIAL_RPC = "https://api.mainnet-beta.solana.com";
export const RELAY_PATH = "/api/relay/solana";
export const SLOTS_PER_EPOCH = 432_000; // 메인넷은 워밍업 없이 고정

const TIMEOUT_MS = 30_000;

export interface SolIx {
  program?: string;
  programId: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | string;
}

export interface SolTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string; // 2021년 중반 이전 거래에는 없다
  uiTokenAmount: { amount: string; decimals: number };
}

export interface SolTx {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: SolTokenBalance[];
    postTokenBalances?: SolTokenBalance[];
    innerInstructions?: { index: number; instructions: SolIx[] }[];
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: { pubkey: string; signer: boolean }[]; instructions: SolIx[] };
  };
}

export interface SolSignature {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export class SolanaRpc {
  private next = 0;
  constructor(
    private url: string,
    private intervalMs = 300,
  ) {}

  private async pace() {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.intervalMs;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      let res: Response;
      try {
        res = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        if (attempt < 3) continue;
        throw new Error("솔라나 노드에 연결할 수 없습니다");
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error("솔라나 노드가 요청을 거부했습니다. Helius 키를 확인하세요.");
      if (!res.ok) throw new Error(`솔라나 조회 실패 (HTTP ${res.status})`);
      const body: { result?: T; error?: { code: number; message: string } } = await res.json();
      if (body.error) {
        // -32429 등 노드 과부하 응답도 재시도
        if (attempt < 6 && /rate|limit|busy|timeout/i.test(body.error.message)) {
          await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
          continue;
        }
        throw new Error(`솔라나 조회 실패: ${body.error.message}`);
      }
      return body.result as T;
    }
  }

  // 최신 → 과거 순으로 모든 서명. until(이전 동기화 때 가장 최신 서명)을 만나면 멈춘다.
  async signatures(address: string, until?: string, onPage: (n: number) => void = () => {}): Promise<SolSignature[]> {
    const out: SolSignature[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.call<SolSignature[]>("getSignaturesForAddress", [address, { limit: 1000, before, until }]);
      out.push(...page);
      onPage(out.length);
      if (page.length < 1000) return out;
      before = page[page.length - 1].signature;
    }
  }

  transaction(signature: string): Promise<SolTx | null> {
    // 2026년 기준 거래 버전 1까지 쓰인다 (그보다 낮게 주면 새 형식 거래를 거부한다)
    return this.call("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "finalized" }]);
  }
}
