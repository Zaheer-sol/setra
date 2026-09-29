import { startDevChain } from "../packages/devchain/src";

/**
 * Starts Anvil (if not already running), deploys a mock USDC and SetraPaymentIntent, funds the dev
 * accounts, and prints the .env lines to use the local devnet in test mode.
 */
const chain = await startDevChain({ port: Number(process.env.LOCAL_CHAIN_PORT ?? 8545) });
console.log(`
Local devnet ready (chain ${chain.chainId}) at ${chain.rpcUrl}

Add to .env:
  LOCAL_CHAIN_ENABLED=true
  LOCAL_CHAIN_RPC_URL=${chain.rpcUrl}
  LOCAL_USDC_ADDRESS=${chain.usdc}
  LOCAL_PAYMENT_INTENT_ADDRESS=${chain.intentContract}

Funded customer accounts (10,000,000 mock USDC each):
${chain.accounts.slice(1).map((a) => `  ${a.address}`).join("\n")}

Leave this running. Ctrl+C stops the devnet.`);
process.on("SIGINT", () => {
  chain.stop();
  process.exit(0);
});
await new Promise(() => undefined);
