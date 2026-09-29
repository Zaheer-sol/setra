import { expect, test, type APIRequestContext } from "@playwright/test";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI } from "../../packages/contracts-client/src";

/**
 * Opt-in: the product flow with a real, newly signed payment on Monad testnet, driven through the
 * running Setra stack (npm run dev). Skipped unless you provide a funded testnet payer yourself:
 *
 *   E2E_TESTNET_PAYER_KEY=0x…        # a throwaway testnet key with a little testnet USDC and MON
 *   E2E_TESTNET_MERCHANT=0x…         # the merchant's receiving address (public)
 *   npx playwright test -c playwright.live.config.ts
 *
 * The key is read from your environment only; it is never logged or stored. It pays 0.01 USDC.
 */

const KEY = process.env.E2E_TESTNET_PAYER_KEY as Hex | undefined;
const MERCHANT = process.env.E2E_TESTNET_MERCHANT as Address | undefined;
const RPC = process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const USDC = (process.env.MONAD_TESTNET_USDC_ADDRESS ?? "0x534b2f3A21130d7a60830c2Df862319e593943A3") as Address;
const monadTestnet = { id: 10143, name: "Monad Testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;

test.skip(!KEY || !MERCHANT, "Set E2E_TESTNET_PAYER_KEY and E2E_TESTNET_MERCHANT to run the live Monad testnet flow.");

async function apiCall(request: APIRequestContext, method: "GET" | "POST", path: string, data?: unknown) {
  const res = await request.fetch(`/api${path}`, { method, data, headers: { origin: "http://localhost:3000" } });
  const body = await res.json().catch(() => null);
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${JSON.stringify(body)}`);
  return body;
}

test("live Monad testnet: a real payment with purpose is detected, matched and paid", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const payer = privateKeyToAccount(KEY!);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(RPC) });
  const walletClient = createWalletClient({ chain: monadTestnet, account: payer, transport: http(RPC) });

  await apiCall(page.request, "POST", "/v1/auth/signup", { name: "Live Tester", email: `live+${Date.now()}@acme.test`, password: "correct horse battery", business_name: "Live Testnet Co" });
  await apiCall(page.request, "POST", "/v1/wallets", { name: "Testnet wallet", network: "monad", address: MERCHANT, assets: ["USDC"] });
  const acme = await apiCall(page.request, "POST", "/v1/customers", { name: "Acme Ltd", wallet_addresses: [{ address: payer.address, network: "monad" }] });
  await expect.poll(async () => (await apiCall(page.request, "GET", "/v1/wallets")).data[0].monitor_from_block, { timeout: 60_000 }).not.toBeNull();
  const invoice = await apiCall(page.request, "POST", "/v1/invoices", { customer_id: acme.id, title: "Live testnet check", purpose: "Automated end-to-end payment", amount: "0.01", network: "monad" });

  const customer = await (await browser.newContext()).newPage();
  await customer.goto(new URL(invoice.payment_url).pathname);
  await expect(customer.getByRole("heading", { name: "Live testnet check" })).toBeVisible();

  const hash = await walletClient.writeContract({ address: USDC, abi: ERC20_ABI, functionName: "transfer", args: [MERCHANT!, 10_000n] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");

  await expect(customer.getByRole("heading", { name: "Payment received" })).toBeVisible({ timeout: 120_000 });
  const payment = (await apiCall(page.request, "GET", `/v1/payments?search=${hash}`)).data[0];
  expect(payment).toMatchObject({ status: "matched", simulated: false, chain_id: 10143, business_object: { title: "Live testnet check" } });
  console.log(`live testnet payment ${hash} (block ${receipt.blockNumber}) matched to ${invoice.number}`);
});
