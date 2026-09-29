import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadNetworks } from "../packages/config/src";

/**
 * Record a real SetraPaymentIntent deployment from Foundry's broadcast output into
 * contracts/deployments/<network>.json (address, chain, block, transaction, ABI).
 *
 *   npm run contracts:record -- --network monad-testnet
 */
const key = process.argv[process.argv.indexOf("--network") + 1];
const network = loadNetworks({}).find((n) => n.key === key);
if (!network) {
  console.error(`Usage: npm run contracts:record -- --network <${loadNetworks({}).map((n) => n.key).join("|")}>`);
  process.exit(1);
}
const broadcast = resolve("contracts/broadcast/DeployPaymentIntent.s.sol", String(network.chainId), "run-latest.json");
if (!existsSync(broadcast)) {
  console.error(`No broadcast found at ${broadcast}. Deploy first (see contracts/deployments/README.md).`);
  process.exit(1);
}
const run = JSON.parse(readFileSync(broadcast, "utf8"));
const tx = run.transactions.find((t: { contractName?: string; transactionType: string }) => t.contractName === "SetraPaymentIntent" && t.transactionType === "CREATE");
const receipt = run.receipts.find((r: { transactionHash: string }) => r.transactionHash === tx.hash);
const artifact = JSON.parse(readFileSync(resolve("contracts/out/SetraPaymentIntent.sol/SetraPaymentIntent.json"), "utf8"));
const record = {
  contract: "SetraPaymentIntent",
  network: network.key,
  chainId: network.chainId,
  address: tx.contractAddress,
  deploymentTransaction: tx.hash,
  deploymentBlock: Number(BigInt(receipt.blockNumber)),
  deployer: tx.transaction.from,
  compiler: artifact.metadata?.compiler?.version ?? null,
  recordedAt: new Date().toISOString(),
  abi: artifact.abi
};
const out = resolve("contracts/deployments", `${network.key}.json`);
writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
const prefix = network.key.toUpperCase().replace(/-/g, "_");
console.log(`Recorded ${out}\n\nSet in your environment:\n  ${prefix}_PAYMENT_INTENT_ADDRESS=${record.address}\n  ${prefix}_PAYMENT_INTENT_DEPLOY_BLOCK=${record.deploymentBlock}`);
