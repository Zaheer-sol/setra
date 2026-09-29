import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_ABI } from "../../packages/contracts-client/src";
import { ANVIL_KEYS } from "../../packages/devchain/src";
import { verifySignature } from "../../packages/events/src";

/**
 * The full product flow with real transactions, not simulations: every payment and refund below is a
 * signed ERC-20 transfer on a real EVM node, detected and settled by Setra's real worker, and shown in
 * the real web app. (A local devnet is used so it runs anywhere without funded wallets; the ingestion
 * code is the same code that runs against Monad.)
 */

const stack = JSON.parse(readFileSync(join(import.meta.dirname, ".stack.json"), "utf8")) as { rpcUrl: string; usdc: Address };
const local = defineChain({ id: 31337, name: "Local devnet", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [stack.rpcUrl] } } });
const publicClient = createPublicClient({ chain: local, transport: http(stack.rpcUrl) });
const testClient = createTestClient({ chain: local, mode: "anvil", transport: http(stack.rpcUrl) });
// Anvil's public development accounts (never used anywhere else).
const customer = privateKeyToAccount(ANVIL_KEYS[1]!);
const merchant = privateKeyToAccount(ANVIL_KEYS[4]!);
const wallet = (account: typeof customer) => createWalletClient({ chain: local, account, transport: http(stack.rpcUrl) });

async function sendUsdc(from: typeof customer, to: Address, units: bigint): Promise<{ hash: Hex; block: bigint }> {
  const hash = await wallet(from).writeContract({ address: stack.usdc, abi: ERC20_ABI, functionName: "transfer", args: [to, units] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  return { hash, block: receipt.blockNumber };
}

/** Keep producing blocks while waiting, so the finalized (confirmed) range advances like a live chain. */
function keepMining() {
  const timer = setInterval(() => testClient.mine({ blocks: 1 }).catch(() => undefined), 700);
  return () => clearInterval(timer);
}

const hooks: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
let receiver: Server;
let hookUrl: string;

test.beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hooks.push({ headers: req.headers, body });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/setra`;
});
test.afterAll(() => receiver?.close());

async function apiCall(request: APIRequestContext, method: "GET" | "POST", path: string, data?: unknown) {
  const res = await request.fetch(`/api${path}`, { method, data, headers: { origin: "http://localhost:3102" } });
  const body = await res.json().catch(() => null);
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${JSON.stringify(body)}`);
  return body;
}

test("real transfers: pay with purpose → detected → paid → signed webhook; duplicate → refunded by a real transfer back", async ({ page, context, browser }) => {
  const stopMining = keepMining();
  try {
    // Merchant workspace (API through the web app's same-origin proxy, so the session is the browser's).
    const email = `onchain+${Date.now()}@acme.test`;
    await apiCall(page.request, "POST", "/v1/auth/signup", { name: "Maya Chen", email, password: "correct horse battery", business_name: "Acme Infrastructure" });
    await apiCall(page.request, "POST", "/v1/wallets", { name: "Main wallet", network: "local", address: merchant.address, assets: ["USDC"] });
    const acme = await apiCall(page.request, "POST", "/v1/customers", { name: "Acme Ltd", email: "ap@acme.test", wallet_addresses: [{ address: customer.address, network: "local" }] });
    const endpoint = await apiCall(page.request, "POST", "/v1/webhook-endpoints", { url: hookUrl, event_types: ["payment.matched", "payment.unknown", "payment.refunded"] });
    // Let the worker activate the wallet before paying.
    await expect.poll(async () => (await apiCall(page.request, "GET", "/v1/wallets")).data[0].monitor_from_block, { timeout: 30_000 }).not.toBeNull();

    const invoice = await apiCall(page.request, "POST", "/v1/invoices", {
      customer_id: acme.id,
      title: "September Infrastructure Services",
      purpose: "Cloud architecture, deployment and monitoring",
      network: "local",
      line_items: [
        { description: "Cloud architecture", unit_amount: "1.20" },
        { description: "Deployment", unit_amount: "0.50" },
        { description: "Monitoring", unit_amount: "0.30" }
      ]
    });

    // The customer sees what they are paying for, then pays with a real transfer.
    const payer: Page = await (await browser.newContext()).newPage();
    await payer.goto(new URL(invoice.payment_url).pathname);
    await expect(payer.getByRole("heading", { name: "September Infrastructure Services" })).toBeVisible();
    await expect(payer.getByText("Cloud architecture", { exact: true })).toBeVisible();
    await expect(payer.getByText("Local devnet").first()).toBeVisible();
    const paid = await sendUsdc(customer, invoice.receiving_address as Address, 2_000_000n);
    await expect(payer.getByRole("heading", { name: "Payment received" })).toBeVisible({ timeout: 60_000 });
    await expect(payer.getByText("for September Infrastructure Services")).toBeVisible();

    // The merchant sees it paid, with purpose and the real transaction as evidence.
    await page.goto(`/app/invoices/${invoice.id}`);
    await expect(page.locator(".status-line").getByText("Paid")).toBeVisible();
    await page.locator("table tbody tr").first().click();
    await expect(page.locator(".hero-purpose").getByText("September Infrastructure Services")).toBeVisible();
    await expect(page.getByText("Known customer wallet", { exact: true })).toBeVisible();
    await expect(page.getByText(paid.block.toLocaleString("en-US"), { exact: true })).toBeVisible();
    await expect(page.getByText("Local devnet RPC")).toBeVisible();
    const payment = (await apiCall(page.request, "GET", `/v1/payments?search=${paid.hash}`)).data[0];
    expect(payment).toMatchObject({ status: "matched", transaction_hash: paid.hash, simulated: false, business_object: { title: "September Infrastructure Services" } });

    // Signed webhook with the business meaning, delivered by the real worker.
    await expect.poll(() => hooks.filter((h) => JSON.parse(h.body).type === "payment.matched").length, { timeout: 30_000 }).toBe(1);
    const hook = hooks.find((h) => JSON.parse(h.body).type === "payment.matched")!;
    expect(verifySignature(endpoint.secret, hook.body, String(hook.headers["x-setra-timestamp"]), String(hook.headers["x-setra-signature"]))).toBe(true);
    expect(JSON.parse(hook.body).data).toMatchObject({ invoice: { title: "September Infrastructure Services", purpose: "Cloud architecture, deployment and monitoring" }, purpose_status: "known" });

    // The customer pays again by mistake: a real second transfer, flagged, not applied.
    const dup = await sendUsdc(customer, invoice.receiving_address as Address, 2_000_000n);
    await expect.poll(async () => (await apiCall(page.request, "GET", `/v1/payments?search=${dup.hash}`)).data[0]?.status, { timeout: 60_000 }).toBe("needs_review");
    const dupPayment = (await apiCall(page.request, "GET", `/v1/payments?search=${dup.hash}`)).data[0];
    const exceptionId = (await apiCall(page.request, "GET", `/v1/payments/${dupPayment.id}`)).exceptions[0].id;
    await page.goto(`/app/exceptions/${exceptionId}`);
    await expect(page.getByText("Possible duplicate").first()).toBeVisible();
    await expect(page.locator(".dup-side").first().getByText("September Infrastructure Services")).toBeVisible();

    // The merchant sends it back from the receiving wallet: a real outgoing transfer, seen by Setra.
    const refund = await sendUsdc(merchant, customer.address, 2_000_000n);
    await expect.poll(async () => (await apiCall(page.request, "GET", `/v1/payments/${dupPayment.id}/refund-candidates`)).data.map((c: any) => c.transaction_hash), { timeout: 60_000 }).toContain(refund.hash);
    await page.reload();
    await page.getByLabel(/Refunded/).check();
    await page.getByRole("radio", { name: /to the payer/ }).check();
    await page.getByLabel("Reason").fill("Customer paid twice; returned the duplicate");
    await page.getByRole("button", { name: "Record refund" }).click();
    await page.goto(`/app/payments/${dupPayment.id}`);
    await expect(page.locator(".status-line [data-slot=badge]").getByText("Refunded")).toBeVisible();
    await expect(page.locator(".status-line").getByText("Refunded to the sender")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Refunds" })).toBeVisible();
    const after = await apiCall(page.request, "GET", `/v1/payments/${dupPayment.id}`);
    expect(after.refunds[0]).toMatchObject({ transaction_hash: refund.hash, amount: "2.00", to: customer.address.toLowerCase() });
    await expect.poll(() => hooks.some((h) => JSON.parse(h.body).type === "payment.refunded"), { timeout: 30_000 }).toBe(true);
    void context;
  } finally {
    stopMining();
  }
});
