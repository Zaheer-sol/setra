import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Actor } from "@setra/engine";
import { loadEnvFile } from "./load-env";

/**
 * Demo workspace for local development and product demos: "Acme Infrastructure".
 *
 * Every payment here is SIMULATED, created in test mode through the same pipeline as real chain
 * observations, and labelled "Simulated" everywhere in the product. The workspace itself is flagged
 * as a demo. Nothing here pretends to be a real Monad transaction.
 */

loadEnvFile();
if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data in production.");
  process.exit(1);
}

const { withGlobal, withTenant, closePools } = await import("./pool");
const engine = await import("@setra/engine");
const { newId } = await import("@setra/schemas");
const { randomToken, sha256Hex } = await import("@setra/security");
engine.setLogger(engine.silentLogger);

const OWNER_EMAIL = "owner@acme.test";
const OWNER_PASSWORD = "SetraDemo!2026"; // development only
const DAY = 86_400_000;
const now = Date.now();
const ago = (days: number, hours = 0) => new Date(now - days * DAY - hours * 3_600_000);
const ahead = (days: number) => new Date(now + days * DAY);
/** Deterministic, obviously-synthetic addresses so demo data is stable across reseeds. */
const addr = (label: string) => `0x${createHash("sha256").update(`setra-demo:${label}`).digest("hex").slice(0, 40)}` as `0x${string}`;

const existing = (await withGlobal((c) => c.query("SELECT id FROM users WHERE lower(email) = $1", [OWNER_EMAIL]))).rows[0];
if (existing) {
  console.log(`Demo data already exists (${OWNER_EMAIL}). Run \`npm run db:reset\` to start over.`);
  await closePools();
  process.exit(0);
}

const user = await engine.createUser({ email: OWNER_EMAIL, name: "Maya Chen", password: OWNER_PASSWORD });
const org = await engine.createOrganization({ name: "Acme Infrastructure", ownerUserId: user.id, ownerLabel: OWNER_EMAIL });
await withGlobal((c) => c.query("UPDATE organizations SET is_demo = true, support_email = 'billing@acme-infra.test', onboarding_completed_at = now() WHERE id = $1", [org.id]));
const actor: Actor = { type: "user", id: user.id, label: OWNER_EMAIL };
const orgId = org.id;

const summary = await withTenant(orgId, async (c) => {
  const wallet = await engine.createWallet(c, orgId, "test", { name: "Main Receiving Wallet", network: "monad", address: addr("merchant-main"), assets: ["USDC"] }, actor);
  await c.query("UPDATE wallets SET created_at = $1 WHERE id = $2", [ago(40), wallet.id]);

  const customers: Record<string, { id: string; wallet?: string }> = {};
  const people: Array<[string, string, boolean]> = [
    ["Acme Ltd", "accounts@acmeltd.test", true],
    ["Nova Systems", "finance@novasystems.test", true],
    ["Studio Ten", "hello@studioten.test", false],
    ["Orbit Commerce", "ap@orbitcommerce.test", true],
    ["Halcyon Labs", "billing@halcyonlabs.test", true],
    ["Kite Analytics", "ops@kiteanalytics.test", false],
    ["Northwind Freight", "payables@northwind.test", true]
  ];
  for (const [name, email, knownWallet] of people) {
    const wallet = knownWallet ? addr(`customer:${name}`) : undefined;
    const row = await engine.createCustomer(c, orgId, "test", { name, email, metadata: {}, wallet_addresses: wallet ? [{ address: wallet, network: "monad", label: "Treasury" }] : [] }, actor);
    await c.query("UPDATE customers SET created_at = $1 WHERE id = $2", [ago(35), row.id]);
    customers[name] = { id: row.id, wallet };
  }

  type Detail = { purpose?: string; line_items?: Array<{ description: string; quantity?: number; unit_amount: string }> };
  const invoice = async (number: string, customer: string, amount: string, title: string, issuedDaysAgo: number, dueInDays: number, expiresInDays?: number, detail: Detail = {}) => {
    const row = await engine.createInvoice(
      c,
      orgId,
      "test",
      {
        customer_id: customers[customer]!.id,
        number,
        amount,
        title,
        purpose: detail.purpose,
        line_items: detail.line_items?.map((li) => ({ quantity: 1, ...li })),
        currency: "USD",
        asset: "USDC",
        network: "monad",
        due_at: ahead(dueInDays).toISOString(),
        metadata: {}
      },
      actor
    );
    const issued = ago(issuedDaysAgo);
    const expires = expiresInDays === undefined ? null : new Date(issued.getTime() + expiresInDays * DAY);
    await c.query("UPDATE invoices SET issued_at = $1, created_at = $1, expires_at = $2 WHERE id = $3", [issued, expires, row.id]);
    return row;
  };
  const pay = async (scenario: "exact" | "partial" | "overpaid" | "unknown" | "wrong_token" | "duplicate", at: Date, invoiceId?: string, amount?: string, from?: string) => {
    const r = await engine.simulatePayment(c, orgId, "test", { scenario, invoice_id: invoiceId, amount, from_address: from as `0x${string}` | undefined, finalize: true }, actor, { at });
    return r.paymentId!;
  };

  // A month of ordinary, cleanly matched business.
  const history: Array<[string, string, string, string, number]> = [
    ["INV-2031", "Acme Ltd", "1800.00", "Managed Postgres, September", 30],
    ["INV-2032", "Northwind Freight", "3250.00", "Edge compute, September", 28],
    ["INV-2033", "Halcyon Labs", "640.00", "Observability add-on", 26],
    ["INV-2034", "Orbit Commerce", "2100.00", "Dedicated nodes, September", 24],
    ["INV-2035", "Nova Systems", "1275.50", "Object storage, September", 21],
    ["INV-2036", "Acme Ltd", "980.00", "Support plan", 18],
    ["INV-2037", "Northwind Freight", "4400.00", "Edge compute, overage", 14],
    ["INV-2038", "Kite Analytics", "515.25", "Data transfer", 11],
    ["INV-2039", "Halcyon Labs", "1590.00", "Managed Kafka", 8],
    ["INV-2040", "Orbit Commerce", "860.00", "Backups", 5]
  ];
  for (const [number, customer, amount, description, days] of history) {
    const inv = await invoice(number, customer, amount, description, days + 2, 14 - days);
    await pay("exact", ago(days, 3), inv.id);
  }

  // The flagship story.
  const inv2041 = await invoice("INV-2041", "Acme Ltd", "2000.00", "October Infrastructure Services", 3, 12, 30, {
    purpose: "Cloud architecture, deployment and monitoring",
    line_items: [
      { description: "Cloud architecture", unit_amount: "1200.00" },
      { description: "Deployment", unit_amount: "500.00" },
      { description: "Monitoring", unit_amount: "300.00" }
    ]
  });
  await pay("exact", ago(0, 2), inv2041.id);

  const inv2042 = await invoice("INV-2042", "Nova Systems", "2000.00", "October Infrastructure Services", 3, 12, 30, { purpose: "Managed cloud platform for Nova's production workloads" });
  await pay("partial", ago(0, 5), inv2042.id, "1500.00");

  const inv2043 = await invoice("INV-2043", "Studio Ten", "740.00", "Design review retainer", 2, 5, 21);
  await invoice("INV-2046", "Kite Analytics", "740.00", "Analytics seats, October", 2, 5, 21);
  await pay("unknown", ago(0, 1), undefined, "740.00", addr("unknown-sender-1"));

  const inv2044 = await invoice("INV-2044", "Orbit Commerce", "2000.00", "Dedicated nodes, October", 4, 10, 30);
  await pay("overpaid", ago(1, 4), inv2044.id, "2500.00");

  const inv2045 = await invoice("INV-2045", "Halcyon Labs", "1200.00", "Managed Kafka, October", 6, 8, 30);
  await pay("partial", ago(2, 6), inv2045.id, "600.00");
  await pay("exact", ago(1, 2), inv2045.id);

  await invoice("INV-2048", "Acme Ltd", "4800.00", "Annual support prepayment", 1, 10, 30, {
    purpose: "Twelve months of priority support",
    line_items: [{ description: "Priority support, monthly", quantity: 12, unit_amount: "400.00" }]
  });
  await invoice("INV-2047", "Northwind Freight", "3100.00", "Edge compute, October", 0, 14, 30);

  const inv2049 = await invoice("INV-2049", "Nova Systems", "950.00", "Migration services", 20, -5, 14);
  await c.query("UPDATE invoices SET status = 'expired' WHERE id = $1", [inv2049.id]);

  const inv2050 = await invoice("INV-2050", "Kite Analytics", "300.00", "Duplicate draft", 9, 5, 30);
  await engine.cancelInvoice(c, orgId, inv2050.id, "Issued twice by mistake", actor);

  // Money that doesn't belong to any invoice.
  await pay("unknown", ago(0, 3), undefined, "315.20", addr("unknown-sender-2"));
  await pay("wrong_token", ago(1, 1), inv2044.id, "120.00", customers["Orbit Commerce"]!.wallet);

  // A controlled reorg: settled, then invalidated. The invoice reopened; history is intact.
  const inv2051 = await invoice("INV-2051", "Studio Ten", "425.00", "Brand assets", 2, 7, 21);
  const reorged = await pay("exact", ago(0, 6), inv2051.id);
  await engine.simulateReorg(c, orgId, reorged, actor);

  // Developer surface: a test API key and a webhook endpoint pointing at the local receiver.
  const keySecret = `sk_test_${randomToken(32)}`;
  await c.query("INSERT INTO api_keys (id, organization_id, environment, name, prefix, secret_hash, scope, created_by) VALUES ($1,$2,'test','Demo backend',$3,$4,'read_write',$5)", [
    newId("apiKey"),
    orgId,
    `${keySecret.slice(0, 12)}…${keySecret.slice(-4)}`,
    sha256Hex(keySecret),
    user.id
  ]);
  const secret = engine.newWebhookSecret();
  await c.query(
    `INSERT INTO webhook_endpoints (id, organization_id, environment, url, description, event_types, secret_ciphertext, secret_hint, created_by)
     VALUES ($1,$2,'test','http://localhost:4040/webhooks','Local demo receiver (npm run webhook-receiver)',$3,$4,$5,$6)`,
    [newId("webhookEndpoint"), orgId, ["payment.matched", "payment.partially_paid", "payment.overpaid", "payment.unknown", "payment.reversed", "webhook.test"], secret.ciphertext, secret.hint, user.id]
  );
  void inv2043;
  return { keySecret, webhookSecret: secret.secret, wallet: wallet.address };
});

// The local webhook receiver reads this file so it can verify signatures. Never commit it.
writeFileSync(resolve(process.cwd(), ".setra-demo-webhook-secret"), summary.webhookSecret + "\n", { mode: 0o600 });
await closePools();

console.log(`
Seeded demo workspace "Acme Infrastructure" (test mode, simulated payments only).

  Sign in:          ${OWNER_EMAIL} / ${OWNER_PASSWORD}   (development only)
  Test API key:     ${summary.keySecret}
  Webhook secret:   saved to .setra-demo-webhook-secret (for npm run webhook-receiver)

For a real Monad testnet payment, add your own testnet wallet in the console and pay an invoice
from the hosted payment page with testnet USDC (faucet.circle.com).
`);
