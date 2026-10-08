import { networks } from "@setra/config";
import { createAdapter, type ChainAdapter } from "@setra/blockchain";

/**
 * A wallet's real token balance on chain, for reconciling the books against Monad itself rather than
 * against what Setra recorded. Read at the settled head, cached for a minute, and null when the chain
 * can't be reached in time: the check then says it couldn't look, instead of guessing.
 */

export type BalanceReader = (chainId: number, token: `0x${string}`, owner: `0x${string}`) => Promise<{ balance: bigint; blockNumber: bigint } | null>;

const adapters = new Map<number, ChainAdapter>();
const cache = new Map<string, { at: number; value: { balance: bigint; blockNumber: bigint } }>();
const TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;

const rpcReader: BalanceReader = async (chainId, token, owner) => {
  // Tests never reach a real network; they install their own reader.
  if (process.env.VITEST) return null;
  const network = networks().byChainId(chainId);
  if (!network) return null;
  let adapter = adapters.get(chainId);
  if (!adapter) {
    adapter = createAdapter(network);
    adapters.set(chainId, adapter);
  }
  if (!adapter.getTokenBalance) return null;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS));
  return Promise.race([adapter.getTokenBalance(token, owner), timeout]);
};

let reader: BalanceReader = rpcReader;

export async function onchainBalance(chainId: number, token: `0x${string}`, owner: `0x${string}`): Promise<{ balance: bigint; blockNumber: bigint } | null> {
  const key = `${chainId}:${token.toLowerCase()}:${owner.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const value = await reader(chainId, token, owner);
    if (value) cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

/** Replace the chain reader (tests). Clears the cache. */
export function setBalanceReader(next: BalanceReader | null): void {
  reader = next ?? rpcReader;
  cache.clear();
}
