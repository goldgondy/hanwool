// XRP Ledger 공개 서버 (JSON-RPC). xrplcluster.com은 브라우저 직접 호출(CORS)을 허용하고 키가 필요 없다.

export const XRPL_RPC = "https://xrplcluster.com/";
// 리플 시각(2000-01-01 기준 초) → 유닉스 초
export const RIPPLE_EPOCH = 946_684_800;

type Amount = string | { currency: string; issuer: string; value: string };

export interface XrplNode {
  LedgerEntryType: string;
  FinalFields?: Record<string, unknown>;
  PreviousFields?: Record<string, unknown>;
  NewFields?: Record<string, unknown>;
}

export interface XrplTx {
  hash: string;
  ledgerIndex: number;
  date: number; // 리플 시각(초)
  type: string; // TransactionType
  account: string; // 보낸 계정 (수수료를 낸 계정)
  destination?: string;
  fee: string; // drops
  result: string; // tesSUCCESS, tec…
  nodes: { kind: "ModifiedNode" | "CreatedNode" | "DeletedNode"; node: XrplNode }[];
  delivered?: Amount;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class XrplRpc {
  // onWait: 호출 한도에 걸려 기다릴 때 (초) — 진행 표시용
  constructor(
    private url = XRPL_RPC,
    public onWait?: (seconds: number) => void,
  ) {}

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, params: [params] }),
        signal: AbortSignal.timeout(30_000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`XRP 서버 조회 실패 (HTTP ${res.status})`);
      const body = (await res.json()) as { result: T & { status?: string; error?: string; error_message?: string } };
      const r = body.result;
      if (r.status === "error") {
        // xrplcluster 호출 한도(분당 1만 단위): 서버가 알려 준 시간만큼 기다렸다가 다시 시도한다
        const wait = /retry in ~(\d+)ms/.exec(r.error_message ?? "");
        if (wait && attempt < 3) {
          this.onWait?.(Math.ceil(Number(wait[1]) / 1000));
          await sleep(Math.min(Number(wait[1]) + 1000, 90_000));
          continue;
        }
        if ((r.error === "slowDown" || r.error === "tooBusy") && attempt < 4) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new XrplError(r.error ?? "error", r.error_message ?? r.error ?? "XRP 서버 오류");
      }
      return r;
    }
  }

  // minLedger 이후의 거래 (오래된 순). 검증된 거래만.
  async accountTx(account: string, minLedger: number, onProgress: (n: number) => void = () => {}): Promise<XrplTx[]> {
    const out: XrplTx[] = [];
    let marker: unknown;
    do {
      const r = await this.call<{ transactions: RawTx[]; marker?: unknown }>("account_tx", {
        account,
        ledger_index_min: minLedger,
        ledger_index_max: -1,
        forward: true,
        limit: 200,
        api_version: 1,
        ...(marker ? { marker } : {}),
      });
      for (const t of r.transactions) if (t.validated !== false) out.push(normalize(t));
      marker = r.marker;
      onProgress(out.length);
    } while (marker);
    return out;
  }
}

export class XrplError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RawTx {
  tx?: Record<string, unknown>;
  tx_json?: Record<string, unknown>;
  hash?: string;
  ledger_index?: number;
  meta: { TransactionResult: string; AffectedNodes: Record<string, XrplNode>[]; delivered_amount?: Amount };
  validated?: boolean;
}

function normalize(t: RawTx): XrplTx {
  const tx = (t.tx ?? t.tx_json ?? {}) as Record<string, unknown>;
  return {
    hash: String(tx.hash ?? t.hash ?? ""),
    ledgerIndex: Number(tx.ledger_index ?? t.ledger_index ?? 0),
    date: Number(tx.date ?? 0),
    type: String(tx.TransactionType ?? ""),
    account: String(tx.Account ?? ""),
    destination: tx.Destination ? String(tx.Destination) : undefined,
    fee: String(tx.Fee ?? "0"),
    result: t.meta?.TransactionResult ?? "",
    nodes: (t.meta?.AffectedNodes ?? []).map((n) => {
      const kind = Object.keys(n)[0] as XrplTx["nodes"][number]["kind"];
      return { kind, node: n[kind] };
    }),
    delivered: t.meta?.delivered_amount,
  };
}
