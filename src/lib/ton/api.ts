// toncenter v3 공개 API (키 없음, CORS 허용, 초당 1회 정도). 오래된 순 정렬은 서버에서 시간 초과가 나서 최신순으로 읽는다.

export const TONCENTER = "https://toncenter.com/api/v3";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let next = 0;

export async function toncenter<T>(path: string, params: Record<string, string>, onWait: (msg: string) => void = () => {}): Promise<T> {
  const url = `${TONCENTER}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    // 키 없는 호출 한도(초당 1회)를 지킨다
    const now = Date.now();
    const slot = Math.max(now, next);
    next = slot + 1100;
    if (slot > now) await sleep(slot - now);
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(40_000) });
    } catch {
      if (attempt < 3) continue;
      throw new Error("TON 조회 실패 (공개 서버가 응답하지 않습니다)");
    }
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    // 429(한도) 또는 서버 시간 초과는 잠시 뒤 다시 시도한다
    if ((res.status === 429 || /timeout|deadline/i.test(body.error ?? "")) && attempt < 4) {
      onWait(`TON 서버가 바빠 ${2 ** attempt}초 뒤 다시 시도`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok || body.error) throw new Error(`TON 조회 실패 (${body.error ?? `HTTP ${res.status}`})`);
    return body;
  }
}

// 최신순으로 minLt보다 큰 기록을 모두 읽는다 (end_lt로 이전 페이지)
export async function toncenterAll<T extends { lt?: string; transaction_lt?: string }>(
  path: string,
  listKey: string,
  params: Record<string, string>,
  minLt: bigint,
  onPage: (n: number) => void = () => {},
): Promise<{ rows: T[]; metadata: Record<string, TonMeta> }> {
  const rows: T[] = [];
  const metadata: Record<string, TonMeta> = {};
  let endLt: bigint | null = null;
  for (;;) {
    const body: Record<string, unknown> = await toncenter(path, { ...params, limit: "100", sort: "desc", ...(endLt !== null ? { end_lt: endLt.toString() } : {}) });
    const page = (body[listKey] ?? []) as T[];
    Object.assign(metadata, (body.metadata ?? {}) as Record<string, TonMeta>);
    const lt = (r: T) => BigInt(r.lt ?? r.transaction_lt ?? "0");
    const fresh = page.filter((r) => lt(r) > minLt);
    rows.push(...fresh);
    onPage(rows.length);
    if (page.length < 100 || fresh.length < page.length) break;
    endLt = page.reduce((m, r) => (lt(r) < m ? lt(r) : m), lt(page[0])) - BigInt(1);
  }
  return { rows, metadata };
}

export interface TonMeta {
  is_indexed?: boolean;
  token_info?: { type?: string; symbol?: string; name?: string; extra?: { decimals?: string | number } }[];
}

export interface TonTx {
  hash: string; // base64
  lt: string;
  now: number;
  trace_id: string;
  total_fees: string;
  account_state_before: { balance: string | null } | null;
  account_state_after: { balance: string | null } | null;
  in_msg: { source: string | null; destination: string | null; value: string | null } | null;
  out_msgs: { destination: string | null; value: string | null }[];
  description?: { aborted?: boolean };
}

export interface TonJettonTransfer {
  source: string | null; // 보낸 사람(지갑 주인)
  destination: string | null; // 받는 사람(지갑 주인)
  amount: string;
  jetton_master: string;
  transaction_hash: string;
  transaction_lt: string;
  transaction_now: number;
  transaction_aborted: boolean;
  trace_id?: string;
}
