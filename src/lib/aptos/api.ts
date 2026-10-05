// Aptos 공개 API (키 없음, CORS 허용). 노드 REST는 "내가 보낸" 거래만 보여 주므로, 입금까지 담긴 인덱서(GraphQL)의
// fungible_asset_activities(자산별 입출금·가스비 기록)를 쓴다. 거래 해시는 노드 REST에서 버전 번호로 찾는다.

export const APTOS_GRAPHQL = "https://api.mainnet.aptoslabs.com/v1/graphql";
export const APTOS_REST = "https://api.mainnet.aptoslabs.com/v1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 0x + 64자리 소문자 (짧게 쓴 주소는 앞을 0으로 채운다)
export function normalizeAptos(addr: string): string | null {
  const m = addr.trim().match(/^0x([0-9a-fA-F]{1,64})$/);
  return m ? `0x${m[1].toLowerCase().padStart(64, "0")}` : null;
}

// 호출 한도(IP당 5분에 4만 단위)에 걸렸을 때 알림 (진행 표시용)
export const aptosWait: { onWait?: (seconds: number) => void } = {};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch {
      if (attempt < 3) continue;
      throw new Error("Aptos 조회 실패 (공개 서버가 응답하지 않습니다)");
    }
    if (res.status === 429 && attempt < 6) {
      // 5분 창이 지나면 풀리므로 1분씩 기다린다
      aptosWait.onWait?.(60);
      await sleep(60_000);
      continue;
    }
    if ((res.status === 408 || res.status >= 500) && attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Aptos 조회 실패 (HTTP ${res.status})`);
    return res.json() as Promise<T>;
  }
}

export async function aptosQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const body = await request<{ data?: T; errors?: { message: string }[] }>(APTOS_GRAPHQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (body.errors?.length) throw new Error(`Aptos 조회 실패 (${body.errors[0].message})`);
  return body.data as T;
}

export interface AptosActivity {
  transaction_version: number;
  event_index: number;
  owner_address: string;
  amount: number | string | null;
  type: string; // 0x1::fungible_asset::Deposit / Withdraw, 0x1::coin::DepositEvent / WithdrawEvent, 가스비
  asset_type: string;
  is_gas_fee: boolean;
  is_transaction_success: boolean;
  transaction_timestamp: string; // UTC, 시간대 표기 없음
  entry_function_id_str: string | null;
  metadata: { symbol: string | null; decimals: number | null } | null;
}

const ACTIVITIES = `query($owner: String!, $after: bigint!) {
  fungible_asset_activities(
    where: { owner_address: { _eq: $owner }, transaction_version: { _gt: $after } }
    order_by: [{ transaction_version: asc }, { event_index: asc }]
    limit: 100
  ) {
    transaction_version event_index owner_address amount type asset_type is_gas_fee is_transaction_success
    transaction_timestamp entry_function_id_str metadata { symbol decimals }
  }
}`;

// after(버전) 이후의 모든 기록. 한 페이지가 꽉 차면 마지막 버전의 기록이 잘렸을 수 있어 그 버전부터 다시 읽고 중복을 뺀다.
export async function aptosActivities(owner: string, after: number, onPage: (n: number) => void = () => {}): Promise<AptosActivity[]> {
  const out = new Map<string, AptosActivity>();
  let cursor = after;
  for (;;) {
    const r = await aptosQuery<{ fungible_asset_activities: AptosActivity[] }>(ACTIVITIES, { owner, after: cursor });
    const rows = r.fungible_asset_activities;
    for (const a of rows) out.set(`${a.transaction_version}:${a.event_index}:${a.is_gas_fee}`, a);
    onPage(out.size);
    if (rows.length < 100) break;
    const last = rows[rows.length - 1].transaction_version;
    cursor = last > cursor + 1 ? last - 1 : last;
    if (rows.every((a) => a.transaction_version === rows[0].transaction_version)) cursor = last; // 한 버전에 100건 넘는 경우
    await sleep(300);
  }
  return [...out.values()];
}

export async function aptosTxHash(version: number): Promise<string | undefined> {
  const tx = await request<{ hash?: string }>(`${APTOS_REST}/transactions/by_version/${version}`);
  return tx.hash;
}

export interface AptosBalance {
  asset_type: string;
  amount: number | string;
  metadata: { symbol: string | null; decimals: number | null } | null;
}

export async function aptosBalances(owner: string): Promise<AptosBalance[]> {
  const r = await aptosQuery<{ current_fungible_asset_balances: AptosBalance[] }>(
    `query($owner: String!) { current_fungible_asset_balances(where: { owner_address: { _eq: $owner } }, limit: 500) { asset_type amount metadata { symbol decimals } } }`,
    { owner },
  );
  return r.current_fungible_asset_balances;
}
