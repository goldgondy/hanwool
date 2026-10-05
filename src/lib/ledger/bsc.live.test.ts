// 실데이터: BSC (NodeReal) — 최근 USDT를 받은 주소 중 거래가 적은 주소의 전체 내역 → 원장 → 노드 잔고와 대사.
// 키: 환경변수 NODEREAL_KEY, 없으면 BNB 체인 공식 문서의 데모 키(테스트 전용).
import { it } from "vitest";
import Decimal from "@/lib/decimal";
import { buildEvmEntries } from "./evm-build";
import { fetchChainHistory } from "./evm-sync";
import { evmRpc, fromBaseUnits, setNodeRealKey } from "@/lib/sources/evm";

setNodeRealKey(process.env.NODEREAL_KEY || "64a9df0874fb4a93b9d0a3849de012d3");
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

it("bsc live reconcile", { timeout: 600_000 }, async () => {
  const head = parseInt((await evmRpc<string>("bsc", "eth_blockNumber", []))!, 16);
  const logs = (await evmRpc<{ topics: string[] }[]>("bsc", "eth_getLogs", [{ address: USDT, topics: [TRANSFER], fromBlock: `0x${(head - 20).toString(16)}`, toBlock: "latest" }])) ?? [];
  const candidates = [...new Set(logs.map((l) => `0x${l.topics[2].slice(26)}`))].slice(0, 60);
  for (const address of candidates) {
    const nonce = parseInt((await evmRpc<string>("bsc", "eth_getTransactionCount", [address, "latest"])) ?? "0x0", 16);
    if (nonce < 2 || nonce > 25) continue;
    const h = await fetchChainHistory(address, "bsc", 0);
    if (h.tokens.length > 150) continue;
    const { entries, skipped } = buildEvmEntries({ sourceId: "live", chain: "bsc", address, ...h });
    const sums = new Map<string, { asset: string; v: Decimal }>();
    for (const e of entries) sums.set(e.assetKey, { asset: e.asset, v: (sums.get(e.assetKey)?.v ?? new Decimal(0)).plus(e.amount) });
    console.info(`\n${address}: nonce ${nonce}, txs ${h.txs.length}, internal ${h.internal.length}, tokens ${h.tokens.length}, skipped(spoof) ${skipped.length}`);
    const balanceOf = "0x70a08231" + address.slice(2).padStart(64, "0");
    for (const [key, { asset, v }] of sums) {
      const contract = key.split(":")[1];
      let actual: Decimal;
      if (contract === "native") actual = fromBaseUnits((await evmRpc<string>("bsc", "eth_getBalance", [address, "latest"])) ?? "0x0", 18);
      else {
        const raw = await evmRpc<string>("bsc", "eth_call", [{ to: contract, data: balanceOf }, "latest"]);
        const dec = await evmRpc<string>("bsc", "eth_call", [{ to: contract, data: "0x313ce567" }, "latest"]);
        if (!raw || raw === "0x" || !dec || dec === "0x") continue;
        actual = fromBaseUnits(raw, parseInt(dec, 16));
      }
      console.info(`${actual.minus(v).isZero() ? "OK  " : "DIFF"} ${asset.slice(0, 10).padEnd(10)} ledger=${v.toFixed()} actual=${actual.toFixed()} diff=${actual.minus(v).toFixed()}`);
    }
    return;
  }
  console.info("적당한 주소를 찾지 못함");
});
