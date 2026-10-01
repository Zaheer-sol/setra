/**
 * Network and asset registry.
 *
 * Every chain Setra can observe is declared here once. Addresses are overridable through
 * environment variables, but the defaults are the canonical contracts verified against
 * official sources (see docs/monad.md). Tokens are always identified by
 * (chainId, contractAddress), never by symbol alone.
 */

export type Environment = "test" | "live";

/** The network family a merchant chooses. The environment decides which concrete chain it resolves to. */
export type NetworkFamily = "monad" | "base" | "local";

export type NetworkKey = "monad" | "monad-testnet" | "base" | "base-sepolia" | "local";

/**
 * How Setra decides that an observation is final enough to create an economic effect.
 * - `finality-tag`: use the chain's `finalized` block tag (Monad: MonadBFT finality, ~2 slots).
 * - `confirmations`: wait for N blocks on top of the observation (chains without a useful finalized tag).
 */
export type SettlementPolicy =
  | { mode: "finality-tag" }
  | { mode: "confirmations"; confirmations: number };

export interface AssetConfig {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  address: `0x${string}`;
  /** ISO currency the asset is pegged to. Setra only settles invoices 1:1 in the pegged currency. */
  pegCurrency: "USD" | "EUR";
}

export interface NetworkConfig {
  key: NetworkKey;
  family: NetworkFamily;
  environment: Environment;
  chainId: number;
  name: string;
  shortName: string;
  primary: boolean;
  enabled: boolean;
  rpcUrl: string;
  /** RPC URL safe to hand to a customer's wallet (wallet_addEthereumChain). Never contains provider API keys. */
  publicRpcUrl: string;
  wsUrl?: string;
  explorerUrl?: string;
  /** Maximum block span per eth_getLogs call accepted by the configured provider. */
  logsBlockRange: number;
  /** Target average block time, used only for UX estimates and backfill windows. */
  blockTimeMs: number;
  settlement: SettlementPolicy;
  /**
   * Extra blocks subtracted from the settled head before scanning. Public RPC endpoints are
   * load-balanced across nodes that can be a few blocks apart; a node that is behind would silently
   * return incomplete logs for the newest blocks. This margin keeps the settled scan behind every node.
   */
  settledLagBlocks: number;
  nativeSymbol: string;
  assets: AssetConfig[];
  paymentIntent?: { address: `0x${string}`; deployBlock: bigint };
  /** SetraBooksAttestation: where a business publishes the fingerprint of a closed month. */
  booksAttestation?: `0x${string}`;
  /** Earlier SetraBooksAttestation deployments, still genuine for publications made through them. */
  booksAttestationPrevious: `0x${string}`[];
}

type Env = Record<string, string | undefined>;

const addr = (value: string | undefined, fallback?: string): `0x${string}` | undefined => {
  const v = value?.trim() || fallback;
  if (!v) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`Invalid address in configuration: ${v}`);
  return v.toLowerCase() as `0x${string}`;
};

const addrList = (value: string | undefined): `0x${string}`[] => (value ?? "").split(",").map((v) => addr(v)).filter((v): v is `0x${string}` => !!v);

const int = (value: string | undefined, fallback: number) => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Expected a positive integer, received ${value}`);
  return n;
};

const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === "" ? fallback : ["1", "true", "yes", "on"].includes(value.toLowerCase());

function intent(env: Env, prefix: string): NetworkConfig["paymentIntent"] {
  const address = addr(env[`${prefix}_PAYMENT_INTENT_ADDRESS`]);
  if (!address) return undefined;
  const deploy = env[`${prefix}_PAYMENT_INTENT_DEPLOY_BLOCK`];
  return { address, deployBlock: deploy ? BigInt(deploy) : 0n };
}

function asset(id: string, symbol: string, name: string, decimals: number, address: `0x${string}` | undefined, pegCurrency: AssetConfig["pegCurrency"] = "USD"): AssetConfig[] {
  return address ? [{ id, symbol, name, decimals, address, pegCurrency }] : [];
}

export function loadNetworks(env: Env = process.env): NetworkConfig[] {
  const networks: NetworkConfig[] = [
    {
      key: "monad",
      family: "monad",
      environment: "live",
      chainId: 143,
      name: "Monad",
      shortName: "Monad",
      primary: true,
      enabled: bool(env.MONAD_ENABLED, true),
      rpcUrl: env.MONAD_RPC_URL || "https://rpc.monad.xyz",
      publicRpcUrl: env.MONAD_PUBLIC_RPC_URL || "https://rpc.monad.xyz",
      wsUrl: env.MONAD_WS_URL || undefined,
      explorerUrl: env.MONAD_EXPLORER_URL || "https://monadscan.com",
      logsBlockRange: int(env.MONAD_LOGS_BLOCK_RANGE, 100),
      blockTimeMs: 300,
      settlement: { mode: "finality-tag" },
      settledLagBlocks: int(env.MONAD_SETTLED_LAG_BLOCKS, 5),
      nativeSymbol: "MON",
      assets: [
        ...asset("asset_monad_usdc", "USDC", "USD Coin", 6, addr(env.MONAD_USDC_ADDRESS, "0x754704Bc059F8C67012fEd69BC8A327a5aafb603")),
        ...asset("asset_monad_usdt0", "USDT0", "USDT0", 6, addr(env.MONAD_USDT0_ADDRESS, "0xe7cd86e13AC4309349F30B3435a9d337750fC82D"))
      ],
      paymentIntent: intent(env, "MONAD"),
      booksAttestation: addr(env.MONAD_BOOKS_ATTESTATION_ADDRESS),
      booksAttestationPrevious: addrList(env.MONAD_BOOKS_ATTESTATION_PREVIOUS)
    },
    {
      key: "monad-testnet",
      family: "monad",
      environment: "test",
      chainId: 10143,
      name: "Monad Testnet",
      shortName: "Monad",
      primary: true,
      enabled: bool(env.MONAD_TESTNET_ENABLED, true),
      rpcUrl: env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
      publicRpcUrl: env.MONAD_TESTNET_PUBLIC_RPC_URL || "https://testnet-rpc.monad.xyz",
      wsUrl: env.MONAD_TESTNET_WS_URL || undefined,
      explorerUrl: env.MONAD_TESTNET_EXPLORER_URL || "https://testnet.monadscan.com",
      logsBlockRange: int(env.MONAD_TESTNET_LOGS_BLOCK_RANGE, 100),
      blockTimeMs: 300,
      settlement: { mode: "finality-tag" },
      settledLagBlocks: int(env.MONAD_TESTNET_SETTLED_LAG_BLOCKS, 5),
      nativeSymbol: "MON",
      assets: [...asset("asset_monad_testnet_usdc", "USDC", "USD Coin (testnet)", 6, addr(env.MONAD_TESTNET_USDC_ADDRESS, "0x534b2f3A21130d7a60830c2Df862319e593943A3"))],
      paymentIntent: intent(env, "MONAD_TESTNET"),
      booksAttestation: addr(env.MONAD_TESTNET_BOOKS_ATTESTATION_ADDRESS),
      booksAttestationPrevious: addrList(env.MONAD_TESTNET_BOOKS_ATTESTATION_PREVIOUS)
    },
    {
      key: "base",
      family: "base",
      environment: "live",
      chainId: 8453,
      name: "Base",
      shortName: "Base",
      primary: false,
      enabled: bool(env.BASE_ENABLED, false),
      rpcUrl: env.BASE_RPC_URL || "https://mainnet.base.org",
      publicRpcUrl: "https://mainnet.base.org",
      wsUrl: env.BASE_WS_URL || undefined,
      explorerUrl: "https://basescan.org",
      logsBlockRange: int(env.BASE_LOGS_BLOCK_RANGE, 500),
      blockTimeMs: 2000,
      settlement: { mode: "confirmations", confirmations: int(env.BASE_CONFIRMATIONS, 12) },
      settledLagBlocks: 0,
      nativeSymbol: "ETH",
      assets: [
        ...asset("asset_base_usdc", "USDC", "USD Coin", 6, addr(env.BASE_USDC_ADDRESS, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")),
        // Circle's euro stablecoin (developers.circle.com/stablecoins/eurc-contract-addresses).
        ...asset("asset_base_eurc", "EURC", "Euro Coin", 6, addr(env.BASE_EURC_ADDRESS, "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42"), "EUR")
      ],
      paymentIntent: intent(env, "BASE"),
      booksAttestation: addr(env.BASE_BOOKS_ATTESTATION_ADDRESS),
      booksAttestationPrevious: addrList(env.BASE_BOOKS_ATTESTATION_PREVIOUS)
    },
    {
      key: "base-sepolia",
      family: "base",
      environment: "test",
      chainId: 84532,
      name: "Base Sepolia",
      shortName: "Base",
      primary: false,
      enabled: bool(env.BASE_SEPOLIA_ENABLED, false),
      rpcUrl: env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      publicRpcUrl: "https://sepolia.base.org",
      wsUrl: env.BASE_SEPOLIA_WS_URL || undefined,
      explorerUrl: "https://sepolia.basescan.org",
      logsBlockRange: int(env.BASE_SEPOLIA_LOGS_BLOCK_RANGE, 500),
      blockTimeMs: 2000,
      settlement: { mode: "confirmations", confirmations: int(env.BASE_SEPOLIA_CONFIRMATIONS, 6) },
      settledLagBlocks: 0,
      nativeSymbol: "ETH",
      assets: [
        ...asset("asset_base_sepolia_usdc", "USDC", "USD Coin (testnet)", 6, addr(env.BASE_SEPOLIA_USDC_ADDRESS, "0x036CbD53842c5426634e7929541eC2318f3dCF7e")),
        ...asset("asset_base_sepolia_eurc", "EURC", "Euro Coin (testnet)", 6, addr(env.BASE_SEPOLIA_EURC_ADDRESS, "0x808456652fdb597867f38412077A9182bf77359F"), "EUR")
      ],
      paymentIntent: intent(env, "BASE_SEPOLIA"),
      booksAttestation: addr(env.BASE_SEPOLIA_BOOKS_ATTESTATION_ADDRESS),
      booksAttestationPrevious: addrList(env.BASE_SEPOLIA_BOOKS_ATTESTATION_PREVIOUS)
    },
    {
      // A local Anvil devnet used for automated end-to-end tests of the real ingestion pipeline.
      // It is never presented as Monad.
      key: "local",
      family: "local",
      environment: "test",
      chainId: int(env.LOCAL_CHAIN_ID, 31337),
      name: "Local devnet",
      shortName: "Local",
      primary: false,
      enabled: bool(env.LOCAL_CHAIN_ENABLED, false),
      rpcUrl: env.LOCAL_CHAIN_RPC_URL || "http://127.0.0.1:8545",
      publicRpcUrl: env.LOCAL_CHAIN_RPC_URL || "http://127.0.0.1:8545",
      logsBlockRange: 1000,
      blockTimeMs: 1000,
      settlement: { mode: "confirmations", confirmations: int(env.LOCAL_CHAIN_CONFIRMATIONS, 1) },
      settledLagBlocks: 0,
      nativeSymbol: "ETH",
      assets: [...asset("asset_local_usdc", "USDC", "USD Coin (local)", 6, addr(env.LOCAL_USDC_ADDRESS))],
      paymentIntent: intent(env, "LOCAL"),
      booksAttestation: addr(env.LOCAL_BOOKS_ATTESTATION_ADDRESS),
      booksAttestationPrevious: addrList(env.LOCAL_BOOKS_ATTESTATION_PREVIOUS)
    }
  ];
  return networks;
}

export class NetworkRegistry {
  readonly all: NetworkConfig[];
  constructor(env: Env = process.env) {
    this.all = loadNetworks(env);
  }
  enabled(): NetworkConfig[] {
    return this.all.filter((n) => n.enabled);
  }
  byChainId(chainId: number): NetworkConfig | undefined {
    return this.all.find((n) => n.chainId === chainId);
  }
  byKey(key: string): NetworkConfig | undefined {
    return this.all.find((n) => n.key === key);
  }
  /** Resolve the network family a merchant picks ("monad") to the concrete chain for an environment. */
  resolve(family: string, environment: Environment): NetworkConfig | undefined {
    return this.all.find((n) => n.family === family && n.environment === environment && n.enabled);
  }
  asset(assetId: string): { network: NetworkConfig; asset: AssetConfig } | undefined {
    for (const network of this.all) {
      const found = network.assets.find((a) => a.id === assetId);
      if (found) return { network, asset: found };
    }
    return undefined;
  }
  assetByAddress(chainId: number, address: string): AssetConfig | undefined {
    return this.byChainId(chainId)?.assets.find((a) => a.address === address.toLowerCase());
  }
  explorerTxUrl(chainId: number, hash: string): string | undefined {
    const network = this.byChainId(chainId);
    return network?.explorerUrl ? `${network.explorerUrl}/tx/${hash}` : undefined;
  }
  explorerAddressUrl(chainId: number, address: string): string | undefined {
    const network = this.byChainId(chainId);
    return network?.explorerUrl ? `${network.explorerUrl}/address/${address}` : undefined;
  }
}

let shared: NetworkRegistry | undefined;
export function networks(): NetworkRegistry {
  shared ??= new NetworkRegistry();
  return shared;
}
/** Tests only: rebuild the registry after changing process.env. */
export function resetNetworks(): void {
  shared = undefined;
}
