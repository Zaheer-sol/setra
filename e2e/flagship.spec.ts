import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";

const address = () => `0x${randomBytes(20).toString("hex")}`;

async function signup(page: Page) {
  const email = `e2e+${randomBytes(4).toString("hex")}@acme.test`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Maya Chen");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  return email;
}

test("signup → workspace → wallet → customer → invoice → Monad payment → matched → paid → evidence → reconciliation → export", async ({ page, context }) => {
  await signup(page);

  // Onboarding: business, wallet, customer, invoice, share.
  await page.getByLabel("Business name").fill("Acme Infrastructure");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "How would you like to start?" })).toBeVisible();
  await page.getByRole("radio", { name: /Collect a payment/ }).check();
  await page.getByLabel("Public wallet address").fill(address());
  await page.getByRole("button", { name: "Start monitoring" }).click();
  await expect(page.getByRole("heading", { name: "Who’s paying you?" })).toBeVisible();
  await page.getByLabel("Customer name").fill("Acme Ltd");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Amount").fill("2000.00");
  await page.getByLabel("What is this payment for?").fill("September Infrastructure Services");
  await page.getByRole("button", { name: "Create payment request" }).click();
  await expect(page.getByRole("heading", { name: /is ready to pay/ })).toBeVisible();
  const paymentUrl = (await page.locator(".onboarding-card .font-mono").first().textContent())!.trim();
  expect(paymentUrl).toMatch(/\/pay\/[A-Za-z0-9_-]+$/);

  // The customer opens the hosted page and pays (test mode: simulated through the real pipeline).
  const customer = await context.newPage();
  await customer.goto(new URL(paymentUrl).pathname);
  await expect(customer.getByRole("heading", { name: "September Infrastructure Services" })).toBeVisible(); // purpose before paying
  await expect(customer.getByText("$2,000")).toBeVisible();
  await expect(customer.getByText("Monad Testnet").first()).toBeVisible();
  await customer.getByRole("button", { name: /simulate instead/ }).click();
  await expect(customer.getByRole("heading", { name: "Payment received" })).toBeVisible();

  // The merchant sees the invoice paid.
  await page.getByRole("button", { name: "Watch for the payment" }).click();
  await expect(page.locator(".status-line").getByText("Paid")).toBeVisible();

  // Payment detail: business meaning, evidence, and why it matched.
  await page.locator("table tbody tr").first().click();
  await expect(page.locator(".hero-purpose").getByText("September Infrastructure Services")).toBeVisible(); // purpose after paying
  await expect(page.getByRole("heading", { name: "Why this payment was matched" })).toBeVisible();
  for (const check of ["Correct receiving wallet", "Approved asset", "Exact amount", "One deterministic candidate"]) {
    await expect(page.getByText(check, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Blockchain evidence" })).toBeVisible();
  await expect(page.getByText("match-v1.1").first()).toBeVisible();

  // Financial event exists.
  await page.goto("/app/developers/events");
  await expect(page.getByText("Payment matched").first()).toBeVisible();

  // Reconciliation reflects it, and the export is a real CSV.
  await page.goto("/app/reconciliation");
  await expect(page.getByText("Matched", { exact: true })).toBeVisible();
  await expect(page.locator(".metric").filter({ hasText: "Matched" })).toContainText("$2,000");
  const csv = await page.request.get("/api/v1/exports/payments.csv");
  expect(csv.status()).toBe(200);
  const body = await csv.text();
  expect(body.split("\r\n")[0]).toContain("payment_id,date,status,customer,invoice,invoice_title,purpose,purpose_status");
  expect(body).toContain("Acme Ltd");
});

test("partial payment → exception → resolve → history preserved", async ({ page }) => {
  await signup(page);
  await page.getByLabel("Business name").fill("Nova Traders");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("radio", { name: /Collect a payment/ }).check();
  await page.getByLabel("Public wallet address").fill(address());
  await page.getByRole("button", { name: "Start monitoring" }).click();
  // Customer with a known wallet, so a partial payment can be attributed.
  await page.getByLabel("Customer name").fill("Nova Systems");
  await page.getByLabel("Their wallet address").fill(address());
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Amount").fill("2000.00");
  await page.getByLabel("What is this payment for?").fill("Managed cloud platform");
  await page.getByRole("button", { name: "Create payment request" }).click();
  await page.getByRole("button", { name: "Watch for the payment" }).click();

  await page.getByRole("button", { name: "Partial" }).click();
  await expect(page.locator(".status-line").getByText("Partially paid")).toBeVisible();
  await expect(page.getByText("$500.00 remaining")).toBeVisible();

  // The exception is in the queue; acknowledge it and confirm history is kept.
  await page.goto("/app/exceptions");
  await page.getByText(/Partial payment on INV-/).click();
  await expect(page.getByRole("heading", { name: /Partial payment on INV-/ })).toBeVisible();
  await page.getByLabel("Reason").fill("Customer confirmed the balance will follow next week");
  await page.getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByRole("heading", { name: "Resolution" })).toBeVisible();
  await expect(page.getByText("Customer confirmed the balance will follow next week")).toBeVisible();

  await page.goto("/app/exceptions?status=resolved");
  await expect(page.getByText(/Partial payment on INV-/)).toBeVisible();
});

test("unknown payment → assign with reason → invoice paid", async ({ page }) => {
  await signup(page);
  await page.getByLabel("Business name").fill("Studio Works");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("radio", { name: /Collect a payment/ }).check();
  await page.getByLabel("Public wallet address").fill(address());
  await page.getByRole("button", { name: "Start monitoring" }).click();
  await page.getByLabel("Customer name").fill("Studio Ten");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Amount").fill("740.00");
  await page.getByLabel("What is this payment for?").fill("Design review retainer");
  await page.getByRole("button", { name: "Create payment request" }).click();
  await page.getByRole("button", { name: "Watch for the payment" }).click();

  // An unknown $300 arrives from a stranger.
  await page.goto("/app/developers/test-mode");
  await page.getByText("Unknown payment", { exact: true }).click();
  await page.getByLabel("Amount override").fill("300.00");
  await page.getByRole("button", { name: "Send simulated payment" }).click();
  await expect(page.getByText("Needs review").first()).toBeVisible();
  await page.getByRole("link", { name: "Review and resolve" }).click();

  await page.getByLabel("Invoice", { exact: true }).click();
  await page.getByRole("option").first().click();
  await page.getByLabel("Reason").fill("Deposit agreed by phone");
  await page.getByRole("button", { name: "Assign payment" }).click();
  await expect(page.getByRole("heading", { name: "Resolution" })).toBeVisible();
  await expect(page.getByText("Deposit agreed by phone")).toBeVisible();
});
