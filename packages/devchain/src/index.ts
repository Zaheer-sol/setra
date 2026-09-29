import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI } from "@setra/contracts-client";

/**
 * Local Anvil devnet for development and automated end-to-end tests. It is never presented as
 * Monad: it runs the same ingestion code against a real EVM node so transfers, the intent
 * contract, restarts and reorgs can be exercised without testnet funds.
 *
 * The keys below are Anvil's publicly documented development accounts. They hold no real value
 * and must never be used on a public network.
 */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
] as const satisfies readonly Hex[];

const contractsOut = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/out");

function artifact(file: string, name: string): { abi: unknown[]; bytecode: Hex } {
  const path = join(contractsOut, file, `${name}.json`);
  if (!existsSync(path)) throw new Error(`Missing ${path}. Run \`forge build\` in contracts/ first.`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export interface DevChain {
  rpcUrl: string;
  chainId: number;
  usdc: Address;
  intentContract: Address;
  accounts: ReturnType<typeof privateKeyToAccount>[];
  publicClient: ReturnType<typeof createPublicClient>;
  testClient: ReturnType<typeof createTestClient>;
  wallet(index: number): ReturnType<typeof createWalletClient>;
  mine(blocks?: number): Promise<void>;
  transferUsdc(fromIndex: number, to: Address, amount: bigint): Promise<Hex>;
  stop(): void;
}

export async function startDevChain(options: { port?: number; chainId?: number } = {}): Promise<DevChain> {
  const port = options.port ?? 8545;
  const chainId = options.chainId ?? 31337;
  const rpcUrl = `http://127.0.0.1:${port}`;
  let proc: ChildProcess | null = null;
  const chain = defineChain({ id: chainId, name: "Local devnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const running = await publicClient.getChainId().then(() => true).catch(() => false);
  if (!running) {
    proc = spawn("anvil", ["--port", String(port), "--chain-id", String(chainId), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      if (await publicClient.getChainId().then(() => true).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const testClient = createTestClient({ chain, mode: "anvil", transport: http(rpcUrl) });
  const accounts = ANVIL_KEYS.map((k) => privateKeyToAccount(k));
  const wallet = (index: number) => createWalletClient({ chain, account: accounts[index]!, transport: http(rpcUrl) });

  const deployer = wallet(0);
  const usdcArtifact = artifact("Tokens.sol", "MockUSDC");
  const intentArtifact = artifact("SetraPaymentIntent.sol", "SetraPaymentIntent");
  const deploy = async (a: { abi: unknown[]; bytecode: Hex }) => {
    const hash = await deployer.deployContract({ abi: a.abi as never, bytecode: a.bytecode, account: accounts[0]!, chain });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress!.toLowerCase() as Address;
  };
  const usdc = await deploy(usdcArtifact);
  const intentContract = await deploy(intentArtifact);
  for (let i = 1; i < accounts.length; i++) {
    const hash = await deployer.writeContract({ address: usdc, abi: [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }], functionName: "mint", args: [accounts[i]!.address, 1_000_000_000_000n], account: accounts[0]!, chain });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  return {
    rpcUrl,
    chainId,
    usdc,
    intentContract,
    accounts,
    publicClient,
    testClient,
    wallet,
    mine: (blocks = 1) => testClient.mine({ blocks }),
    transferUsdc: async (fromIndex, to, amount) => {
      const hash = await wallet(fromIndex).writeContract({ address: usdc, abi: ERC20_ABI, functionName: "transfer", args: [to, amount], account: accounts[fromIndex]!, chain });
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    },
    stop: () => proc?.kill()
  };
}
