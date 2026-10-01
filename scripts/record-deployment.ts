import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadNetworks } from "../packages/config/src";

/**
 * Record a real deployment of the Setra contracts from Foundry's broadcast output into
 * contracts/deployments/<network>.json (address, chain, block, transaction and ABI per contract).
 *
 *   npm run contracts:record -- --network monad-testnet
 *
 * Reads the DeploySetra (both contracts), DeployBooks and DeployPaymentIntent broadcasts and merges
 * them into the existing record: the newest deployment of each contract is current, and the one it
 * replaced is kept under "history".
 */
const key = process.argv[process.argv.indexOf("--network") + 1];
const network = loadNetworks({}).find((n) => n.key === key);
if (!network) {
  console.error(`Usage: npm run contracts:record -- --network <${loadNetworks({}).map((n) => n.key).join("|")}>`);
  process.exit(1);
}
// Every deploy script's latest broadcast for this chain; for each contract the newest deployment wins.
const broadcasts = ["DeploySetra.s.sol", "DeployBooks.s.sol", "DeployPaymentIntent.s.sol"]
  .map((script) => resolve("contracts/broadcast", script, String(network.chainId), "run-latest.json"))
  .filter(existsSync)
  .map((path) => JSON.parse(readFileSync(path, "utf8")))
  .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
if (!broadcasts.length) {
  console.error(`No broadcast found for chain ${network.chainId}. Deploy first (see contracts/deployments/README.md).`);
  process.exit(1);
}
const out = resolve("contracts/deployments", `${network.key}.json`);
const previous = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
const contracts: Record<string, any> = { ...(previous?.contracts ?? {}) };
const history: any[] = [...(previous?.history ?? [])];
for (const run of broadcasts) {
  for (const name of ["SetraPaymentIntent", "SetraBooksAttestation"]) {
    const tx = run.transactions.find((t: { contractName?: string; transactionType: string }) => t.contractName === name && t.transactionType === "CREATE");
    if (!tx) continue;
    if (contracts[name]?.address?.toLowerCase() === tx.contractAddress.toLowerCase()) continue;
    const receipt = run.receipts.find((r: { transactionHash: string }) => r.transactionHash === tx.hash);
    const artifact = JSON.parse(readFileSync(resolve(`contracts/out/${name}.sol/${name}.json`), "utf8"));
    if (contracts[name]) history.push({ contract: name, ...contracts[name], abi: undefined, replacedAt: new Date().toISOString() });
    contracts[name] = {
      address: tx.contractAddress,
      deploymentTransaction: tx.hash,
      deploymentBlock: Number(BigInt(receipt.blockNumber)),
      deployer: tx.transaction.from,
      compiler: artifact.metadata?.compiler?.version ?? null,
      abi: artifact.abi
    };
  }
}
const record = { network: network.key, chainId: network.chainId, recordedAt: new Date().toISOString(), contracts, ...(history.length ? { history } : {}) };
writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
const prefix = network.key.toUpperCase().replace(/-/g, "_");
const pi = contracts.SetraPaymentIntent as { address: string; deploymentBlock: number } | undefined;
const ba = contracts.SetraBooksAttestation as { address: string } | undefined;
console.log(`Recorded ${out}\n`);
if (pi) console.log(`  ${prefix}_PAYMENT_INTENT_ADDRESS=${pi.address}\n  ${prefix}_PAYMENT_INTENT_DEPLOY_BLOCK=${pi.deploymentBlock}`);
if (ba) console.log(`  ${prefix}_BOOKS_ATTESTATION_ADDRESS=${ba.address}`);
