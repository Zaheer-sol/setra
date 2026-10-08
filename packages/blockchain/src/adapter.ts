import { createPublicClient, defineChain, http, webSocket, type Hex, type Log, type PublicClient } from "viem";
import type { NetworkConfig } from "@setra/config";

export interface BlockRef {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
}

export interface LogQuery {
  fromBlock: bigint;
  toBlock: bigint;
  address?: Hex | Hex[];
  topics?: (Hex | Hex[] | null)[];
}

/**
 * The only surface the rest of Setra uses to talk to a chain.
 * Implementations must be safe to call repeatedly: every method is a read.
 */
export interface ChainAdapter {
  readonly network: NetworkConfig;
  getLatestBlockNumber(): Promise<bigint>;
  /**
   * Highest block Setra may treat as settled (no further reorg risk under the network's policy).
   * Monad: the `finalized` tag (MonadBFT finality). Others: latest − confirmations.
   */
  getSettledHead(): Promise<BlockRef>;
  /** `useCache: false` forces a fresh read (reorg checks). */
  getBlock(blockNumber: bigint, useCache?: boolean): Promise<BlockRef>;
  getLogs(query: LogQuery): Promise<Log[]>;
  getTransactionReceipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint; blockHash: Hex } | null>;
  /** Who sent a transaction and the native-token fee it paid (gas × effective price, plus any L1 data fee). */
  getTransactionFee?(hash: Hex): Promise<{ from: string; fee: bigint } | null>;
  /** An ERC-20 balance at the settled head, the number to reconcile the books against. */
  getTokenBalance?(token: Hex, owner: Hex): Promise<{ balance: bigint; blockNumber: bigint }>;
  /** Optional low-latency wake-up signal. Polling remains the source of truth. */
  watchHeads?(onHead: (blockNumber: bigint) => void, onError: (error: Error) => void): () => void;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function isRangeError(error: unknown): boolean {
  const text = String((error as Error)?.message ?? error).toLowerCase();
  return ["block range", "range is too large", "too many", "limit exceeded", "exceed", "query returned more than", "10000 results", "response size"].some((s) => text.includes(s));
}

export class EvmAdapter implements ChainAdapter {
  readonly client: PublicClient;
  private readonly wsClient?: PublicClient;
  private readonly blockCache = new Map<string, BlockRef>();

  constructor(readonly network: NetworkConfig) {
    const chain = defineChain({
      id: network.chainId,
      name: network.name,
      nativeCurrency: { name: network.nativeSymbol, symbol: network.nativeSymbol, decimals: 18 },
      rpcUrls: { default: { http: [network.rpcUrl], webSocket: network.wsUrl ? [network.wsUrl] : undefined } }
    });
    this.client = createPublicClient({
      chain,
      transport: http(network.rpcUrl, { retryCount: 3, retryDelay: 400, timeout: 15_000, batch: false })
    });
    if (network.wsUrl) this.wsClient = createPublicClient({ chain, transport: webSocket(network.wsUrl, { retryCount: 5 }) });
  }

  async getLatestBlockNumber(): Promise<bigint> {
    return this.call("eth_blockNumber", () => this.client.getBlockNumber({ cacheTime: 0 }));
  }

  async getSettledHead(): Promise<BlockRef> {
    if (this.network.settlement.mode === "finality-tag") {
      const block = await this.call("eth_getBlockByNumber(finalized)", () => this.client.getBlock({ blockTag: "finalized" }));
      return this.toRef(block);
    }
    const latest = await this.getLatestBlockNumber();
    const n = latest - BigInt(this.network.settlement.confirmations);
    return this.getBlock(n > 0n ? n : 0n, false);
  }

  async getBlock(blockNumber: bigint, cache = true): Promise<BlockRef> {
    const key = blockNumber.toString();
    const cached = cache ? this.blockCache.get(key) : undefined;
    if (cached) return cached;
    const block = await this.call("eth_getBlockByNumber", () => this.client.getBlock({ blockNumber }));
    const ref = this.toRef(block);
    if (cache) {
      this.blockCache.set(key, ref);
      if (this.blockCache.size > 5_000) this.blockCache.delete(this.blockCache.keys().next().value!);
    }
    return ref;
  }

  /** Forget cached blocks at or above a height (used when a reorg is suspected). */
  forgetFrom(blockNumber: bigint): void {
    for (const key of [...this.blockCache.keys()]) if (BigInt(key) >= blockNumber) this.blockCache.delete(key);
  }

  async getLogs(query: LogQuery): Promise<Log[]> {
    return this.getLogsSplitting(query, 0);
  }

  private async getLogsSplitting(query: LogQuery, depth: number): Promise<Log[]> {
    try {
      return await this.client.request({
        method: "eth_getLogs",
        params: [
          {
            fromBlock: `0x${query.fromBlock.toString(16)}`,
            toBlock: `0x${query.toBlock.toString(16)}`,
            address: query.address,
            topics: query.topics
          }
        ]
      } as never) as unknown as Log[];
    } catch (error) {
      // Providers enforce different range/result caps. Halve the range and try again rather than failing the cycle.
      if (isRangeError(error) && query.toBlock > query.fromBlock && depth < 12) {
        const mid = query.fromBlock + (query.toBlock - query.fromBlock) / 2n;
        const left = await this.getLogsSplitting({ ...query, toBlock: mid }, depth + 1);
        const right = await this.getLogsSplitting({ ...query, fromBlock: mid + 1n }, depth + 1);
        return [...left, ...right];
      }
      throw new RpcError(`eth_getLogs failed on ${this.network.key}: ${(error as Error).message?.split("\n")[0]}`, true, error);
    }
  }

  async getTokenBalance(token: Hex, owner: Hex): Promise<{ balance: bigint; blockNumber: bigint }> {
    const head = await this.getSettledHead();
    const balance = (await this.client.readContract({
      address: token,
      abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
      functionName: "balanceOf",
      args: [owner],
      blockNumber: head.number
    })) as bigint;
    return { balance, blockNumber: head.number };
  }

  async getTransactionReceipt(hash: Hex) {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash });
      return { status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
    } catch (error) {
      if (String((error as Error).message).includes("could not be found")) return null;
      throw new RpcError(`eth_getTransactionReceipt failed: ${(error as Error).message?.split("\n")[0]}`, true, error);
    }
  }

  async getTransactionFee(hash: Hex): Promise<{ from: string; fee: bigint } | null> {
    try {
      const [tx, receipt] = await Promise.all([this.client.getTransaction({ hash }), this.client.getTransactionReceipt({ hash })]);
      const l1Fee = (receipt as unknown as { l1Fee?: bigint | string | null }).l1Fee;
      const extra = l1Fee === undefined || l1Fee === null ? 0n : BigInt(l1Fee);
      return { from: tx.from.toLowerCase(), fee: receipt.gasUsed * receipt.effectiveGasPrice + extra };
    } catch (error) {
      if (String((error as Error).message).includes("could not be found")) return null;
      throw new RpcError(`fee lookup failed on ${this.network.key}: ${(error as Error).message?.split("\n")[0]}`, true, error);
    }
  }

  watchHeads(onHead: (blockNumber: bigint) => void, onError: (error: Error) => void): () => void {
    if (this.wsClient) return this.wsClient.watchBlockNumber({ emitOnBegin: false, onBlockNumber: onHead, onError });
    return this.client.watchBlockNumber({ emitOnBegin: false, poll: true, pollingInterval: 1000, onBlockNumber: onHead, onError });
  }

  private toRef(block: { number: bigint | null; hash: Hex | null; parentHash: Hex; timestamp: bigint }): BlockRef {
    if (block.number === null || block.hash === null) throw new RpcError("Provider returned a pending block", true);
    return { number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp };
  }

  private async call<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new RpcError(`${label} failed on ${this.network.key}: ${(error as Error).message?.split("\n")[0]}`, true, error);
    }
  }
}

/** Monad is the primary network. The adapter is the same EVM adapter with Monad's finality policy from the registry. */
export class MonadAdapter extends EvmAdapter {
  constructor(network: NetworkConfig) {
    if (network.family !== "monad") throw new Error(`MonadAdapter requires a Monad network, received ${network.key}`);
    super(network);
  }
}

export class BaseAdapter extends EvmAdapter {
  constructor(network: NetworkConfig) {
    if (network.family !== "base") throw new Error(`BaseAdapter requires a Base network, received ${network.key}`);
    super(network);
  }
}

export function createAdapter(network: NetworkConfig): ChainAdapter {
  if (network.family === "monad") return new MonadAdapter(network);
  if (network.family === "base") return new BaseAdapter(network);
  return new EvmAdapter(network);
}
