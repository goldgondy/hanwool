// 브라우저 확장 지갑(메타마스크, 라비, 트러스트, OKX 월렛, 코인베이스 월렛 등) 연결. 표준: EIP-6963, EIP-1193
// - 설치된 지갑을 모두 찾아 사용자가 고르게 한다 (여러 지갑이 window.ethereum을 두고 다투는 문제를 피함).
// - 주소 조회 권한만 요청한다. 서명·거래 승인은 요청하지 않는다.
// - 지갑 앱 안의 브라우저(메타마스크 모바일 앱 등)에서도 같은 방식으로 동작한다.

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string; // data URI
  rdns: string;
}

export interface WalletDetail {
  info: WalletInfo;
  provider: Eip1193Provider;
}

export function discoverWallets(waitMs = 400): Promise<WalletDetail[]> {
  return new Promise((resolve) => {
    const found = new Map<string, WalletDetail>();
    const onAnnounce = (e: Event) => {
      const detail = (e as CustomEvent<WalletDetail>).detail;
      if (detail?.info?.uuid && detail.provider) found.set(detail.info.uuid, detail);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      // 표준을 지원하지 않는 오래된 지갑
      const legacy = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
      if (found.size === 0 && legacy) {
        found.set("legacy", { info: { uuid: "legacy", name: "브라우저 지갑", icon: "", rdns: "legacy" }, provider: legacy });
      }
      resolve([...found.values()]);
    }, waitMs);
  });
}

// 지갑의 계정 주소를 가져온다. 메타마스크 등은 권한 요청 창에서 계정을 여러 개 고를 수 있다.
export async function requestAddresses(provider: Eip1193Provider): Promise<string[]> {
  const rejected = (e: unknown) => (e as { code?: number })?.code === 4001;
  try {
    await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
  } catch (e) {
    if (rejected(e)) throw new Error("지갑에서 연결을 취소했습니다");
    // 권한 요청을 지원하지 않는 지갑은 아래 eth_requestAccounts로 진행한다
  }
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: "eth_requestAccounts" });
  } catch (e) {
    if (rejected(e)) throw new Error("지갑에서 연결을 취소했습니다");
    throw new Error(`지갑에서 주소를 가져오지 못했습니다: ${e instanceof Error ? e.message : e}`);
  }
  const list = Array.isArray(accounts) ? accounts.filter((a): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) : [];
  return [...new Set(list.map((a) => a.toLowerCase()))];
}
