import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex, type Log } from "viem";
import { ERC20_ABI, PAYMENT_INTENT_ABI } from "@setra/contracts-client";
import type { NetworkConfig } from "@setra/config";
import { decodeActivity, fetchActivity } from "./activity";
import type { ChainAdapter, LogQuery } from "./adapter";

const wallet = "0x00000000000000000000000000000000000000aa" as Hex;
const usdc = "0x754704bc059f8c67012fed69bc8a327a5aafb603" as Hex;

function transferLog(opts: { block: bigint; logIndex: number; value: bigint; to?: Hex; hash?: Hex }): Log {
  const topics = encodeEventTopics({ abi: ERC20_ABI, eventName: "Transfer", args: { from: "0x0000000000000000000000000000000000000091", to: opts.to ?? wallet } });
  return {
    address: usdc,
    topics: topics as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [opts.value]),
    blockNumber: opts.block,
    blockHash: `0x${opts.block.toString(16).padStart(64, "0")}`,
    transactionHash: opts.hash ?? `0x${(opts.block * 1000n + BigInt(opts.logIndex)).toString(16).padStart(64, "0")}`,
    transactionIndex: 0,
    logIndex: opts.logIndex,
    removed: false
  } as Log;
}

function fakeAdapter(logs: Log[], logsBlockRange = 100): ChainAdapter & { queries: LogQuery[] } {
  const queries: LogQuery[] = [];
  return {
    queries,
    network: { chainId: 143, key: "monad", logsBlockRange } as NetworkConfig,
    getLatestBlockNumber: async () => 1000n,
    getSettledHead: async () => ({ number: 998n, hash: "0x01", parentHash: "0x00", timestamp: 1n }),
    getBlock: async (n) => ({ number: n, hash: "0x01", parentHash: "0x00", timestamp: 1_760_000_000n + n }),
    getTransactionReceipt: async () => null,
    getLogs: async (q) => {
      queries.push(q);
      return logs.filter((l) => l.blockNumber! >= q.fromBlock && l.blockNumber! <= q.toBlock && (!q.address || [q.address].flat().includes(l.address)));
    }
  };
}

describe("fetchActivity", () => {
  it("chunks ranges by the provider's getLogs limit", async () => {
    const adapter = fakeAdapter([], 100);
    await fetchActivity(adapter, { fromBlock: 1n, toBlock: 250n, wallets: [wallet], tokens: [usdc] });
    expect(adapter.queries.map((q) => [q.fromBlock, q.toBlock])).toEqual([[1n, 100n], [101n, 200n], [201n, 250n]]);
  });

  it("deduplicates duplicate logs and orders canonically", async () => {
    const a = transferLog({ block: 10n, logIndex: 3, value: 5n });
    const b = transferLog({ block: 5n, logIndex: 1, value: 7n });
    const adapter = fakeAdapter([a, b, { ...a }]);
    const out = await fetchActivity(adapter, { fromBlock: 1n, toBlock: 20n, wallets: [wallet], tokens: [usdc] });
    expect(out.map((x) => x.blockNumber)).toEqual([5n, 10n]);
    expect(out[0]!.blockTimestamp).toBe(1_760_000_005n);
  });

  it("ignores zero-value transfers (address poisoning)", async () => {
    const adapter = fakeAdapter([transferLog({ block: 3n, logIndex: 0, value: 0n })]);
    expect(await fetchActivity(adapter, { fromBlock: 1n, toBlock: 5n, wallets: [wallet], tokens: [usdc] })).toEqual([]);
  });

  it("filters intent events by merchant in topic position 2 (after the indexed intent id)", async () => {
    const adapter = fakeAdapter([], 100);
    await fetchActivity(adapter, { fromBlock: 1n, toBlock: 10n, wallets: [wallet], tokens: [usdc], intentContract: "0x00000000000000000000000000000000000000cc" });
    const intentQuery = adapter.queries.find((q) => q.address === "0x00000000000000000000000000000000000000cc")!;
    expect(intentQuery.topics?.[1]).toBeNull();
    expect(intentQuery.topics?.[2]).toEqual([`0x${wallet.slice(2).padStart(64, "0")}`]);
  });

  it("returns nothing when no wallets are monitored", async () => {
    const adapter = fakeAdapter([transferLog({ block: 3n, logIndex: 0, value: 1n })]);
    expect(await fetchActivity(adapter, { fromBlock: 1n, toBlock: 5n, wallets: [], tokens: [usdc] })).toEqual([]);
    expect(adapter.queries).toHaveLength(0);
  });
});

describe("decodeActivity", () => {
  it("decodes an ERC-20 transfer with exact bigint amounts", () => {
    const act = decodeActivity(143, transferLog({ block: 1n, logIndex: 0, value: 2_000_000_000n }), 1n);
    expect(act).toMatchObject({ kind: "transfer", amount: 2_000_000_000n, to: wallet, token: usdc });
  });

  it("decodes PaymentIntentPaid", () => {
    const intentId = `0x${"ab".repeat(32)}` as Hex;
    const topics = encodeEventTopics({ abi: PAYMENT_INTENT_ABI, eventName: "PaymentIntentPaid", args: { intentId, merchant: wallet, payer: "0x0000000000000000000000000000000000000091" } });
    const log = {
      ...transferLog({ block: 2n, logIndex: 1, value: 1n }),
      address: "0x00000000000000000000000000000000000000cc",
      topics,
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [usdc, 2_000_000_000n, `0x${"01".repeat(32)}`])
    } as Log;
    expect(decodeActivity(143, log, 1n)).toMatchObject({ kind: "intent_paid", intentId, merchant: wallet, amount: 2_000_000_000n, token: usdc });
  });

  it("skips ERC-721 style transfers and garbage", () => {
    const nft = transferLog({ block: 1n, logIndex: 0, value: 1n });
    (nft.topics as Hex[]).push(`0x${"00".repeat(32)}`);
    expect(decodeActivity(143, nft, 1n)).toBeNull();
    expect(decodeActivity(143, { ...transferLog({ block: 1n, logIndex: 0, value: 1n }), data: "0x" } as Log, 1n)).toBeNull();
  });
});
