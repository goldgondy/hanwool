import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverWallets, requestAddresses, type Eip1193Provider, type WalletDetail } from "./eip6963";

// 브라우저 window 대신 EventTarget으로 확장 지갑의 EIP-6963 동작을 흉내 낸다.
type FakeWindow = EventTarget & { ethereum?: Eip1193Provider };
let win: FakeWindow;

function installWallet(name: string, provider: Eip1193Provider) {
  win.addEventListener("eip6963:requestProvider", () => {
    const detail: WalletDetail = { info: { uuid: `uuid-${name}`, name, icon: "data:image/svg+xml,", rdns: `io.${name}` }, provider };
    win.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  });
}

const provider = (handlers: Record<string, () => unknown>): Eip1193Provider => ({
  async request({ method }) {
    const h = handlers[method];
    if (!h) throw Object.assign(new Error(`unsupported ${method}`), { code: -32601 });
    return h();
  },
});

beforeEach(() => {
  win = new EventTarget() as FakeWindow;
  (globalThis as unknown as { window: FakeWindow }).window = win;
});
afterEach(() => {
  delete (globalThis as unknown as { window?: FakeWindow }).window;
});

describe("discoverWallets", () => {
  it("설치된 여러 지갑을 모두 찾는다", async () => {
    installWallet("MetaMask", provider({}));
    installWallet("Rabby", provider({}));
    const found = await discoverWallets(50);
    expect(found.map((w) => w.info.name).sort()).toEqual(["MetaMask", "Rabby"]);
  });

  it("표준을 지원하지 않는 오래된 지갑은 window.ethereum으로 찾는다", async () => {
    win.ethereum = provider({});
    const found = await discoverWallets(50);
    expect(found.map((w) => w.info.name)).toEqual(["브라우저 지갑"]);
  });

  it("지갑이 없으면 빈 목록", async () => {
    expect(await discoverWallets(50)).toEqual([]);
  });
});

describe("requestAddresses", () => {
  const A = "0x75541197F23762E65FFA7CB48CF881EF15FBC366";

  it("주소를 소문자로 정리하고 중복·잘못된 값을 거른다", async () => {
    const p = provider({ wallet_requestPermissions: () => [{}], eth_requestAccounts: () => [A, A.toLowerCase(), "not-an-address"] });
    expect(await requestAddresses(p)).toEqual([A.toLowerCase()]);
  });

  it("권한 요청을 지원하지 않는 지갑도 주소를 가져온다", async () => {
    const p = provider({ eth_requestAccounts: () => [A] });
    expect(await requestAddresses(p)).toEqual([A.toLowerCase()]);
  });

  it("사용자가 연결을 취소하면 알아볼 수 있는 오류를 낸다", async () => {
    const p = provider({
      wallet_requestPermissions: () => {
        throw Object.assign(new Error("User rejected"), { code: 4001 });
      },
    });
    await expect(requestAddresses(p)).rejects.toThrow("지갑에서 연결을 취소했습니다");
  });
});
