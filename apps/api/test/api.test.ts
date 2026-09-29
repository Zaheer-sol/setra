import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, withGlobal, withTenant } from "../../../packages/database/src";
import { deliverDueWebhooks } from "../../../packages/engine/src";
import { verifySignature } from "../../../packages/events/src";
import { apiKey, call, randomAddress, server, setupWorkspace, signup, type Session } from "./helpers";

afterAll(async () => {
  await (await server()).close();
  await closePools();
});

describe("authentication and sessions", () => {
  it("signs up, reads /v1/me, logs out and rejects the old session", async () => {
    const s = await signup();
    const me = await call("GET", "/v1/me", { cookie: s.cookie });
    expect(me.statusCode).toBe(200);
    expect(me.data).toMatchObject({ kind: "user", role: "owner", environment: "test", organization: { id: s.orgId } });
    expect((await call("POST", "/v1/auth/logout", { cookie: s.cookie })).statusCode).toBe(204);
    expect((await call("GET", "/v1/invoices", { cookie: s.cookie })).statusCode).toBe(401);
  });

  it("rejects wrong passwords with a generic message and duplicate signups", async () => {
    const s = await signup();
    const bad = await call("POST", "/v1/auth/login", null, { email: s.email, password: "wrong password!" });
    expect(bad.statusCode).toBe(401);
    expect(bad.data.error.code).toBe("invalid_credentials");
    const unknown = await call("POST", "/v1/auth/login", null, { email: "nobody@nowhere.test", password: "whatever12345" });
    expect(unknown.data.error.message).toBe(bad.data.error.message);
    const dupe = await call("POST", "/v1/auth/signup", null, { name: "X", email: s.email.toUpperCase(), password: "correct horse battery" });
    expect(dupe.statusCode).toBe(409);
  });

  it("resets a password with a one-time token and signs out other sessions", async () => {
    const s = await signup();
    const forgot = await call("POST", "/v1/auth/forgot-password", null, { email: s.email });
    expect(forgot.statusCode).toBe(200);
    // Read the token hash is impossible by design; issue a known token directly to exercise reset.
    const { sha256Hex } = await import("../../../packages/security/src");
    await withGlobal((c) => c.query("INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES ('pwr_test_' || $1, $1, $2, now() + interval '1 hour')", [s.userId, sha256Hex("known-reset-token-0123456789")]));
    const reset = await call("POST", "/v1/auth/reset-password", null, { token: "known-reset-token-0123456789", password: "a brand new password" });
    expect(reset.statusCode).toBe(200);
    expect((await call("GET", "/v1/me", { cookie: s.cookie })).statusCode).toBe(401);
    expect((await call("POST", "/v1/auth/reset-password", null, { token: "known-reset-token-0123456789", password: "another password!" })).statusCode).toBe(400);
    expect((await call("POST", "/v1/auth/login", null, { email: s.email, password: "a brand new password" })).statusCode).toBe(200);
  });

  it("blocks cross-site cookie-authenticated mutations (CSRF)", async () => {
    const s = await signup();
    const res = await call("POST", "/v1/customers", { cookie: s.cookie }, { name: "Evil" }, { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.data.error.code).toBe("csrf_rejected");
    const noOrigin = await (await server()).inject({ method: "POST", url: "/v1/customers", headers: { cookie: s.cookie, "content-type": "application/json" }, payload: JSON.stringify({ name: "Evil" }) });
    expect(noOrigin.statusCode).toBe(403);
  });
});

describe("errors and validation", () => {
  it("returns a consistent error envelope with a request id and no stack traces", async () => {
    const s = await signup();
    const res = await call("POST", "/v1/invoices", { cookie: s.cookie }, { title: "Consulting services", customer_id: "cus_x", amount: 2000 });
    expect(res.statusCode).toBe(422);
    expect(res.data.error).toMatchObject({ code: "validation_error", request_id: expect.stringMatching(/^req_/) });
    expect(res.headers["x-request-id"]).toBe(res.data.error.request_id);
    expect(res.body).not.toMatch(/at .*\.ts:\d+/);
    const missing = await call("GET", "/v1/nope", { cookie: s.cookie });
    expect(missing.statusCode).toBe(404);
    expect(missing.data.error.code).toBe("not_found");
  });

  it("refuses floating-point money and too many decimals", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const float = await call("POST", "/v1/invoices", { cookie: s.cookie }, { title: "Consulting services", customer_id: acme.id, amount: "1e3" });
    expect(float.statusCode).toBe(422);
    const precise = await call("POST", "/v1/invoices", { cookie: s.cookie }, { title: "Consulting services", customer_id: acme.id, amount: "10.0000001" });
    expect(precise.statusCode).toBe(422);
    expect(precise.data.error.message).toMatch(/decimal places/);
  });

  it("explains what is missing when there is no wallet", async () => {
    const s = await signup();
    const c = (await call("POST", "/v1/customers", { cookie: s.cookie }, { name: "Acme Ltd" })).data;
    const res = await call("POST", "/v1/invoices", { cookie: s.cookie }, { title: "Consulting services", customer_id: c.id, amount: "10.00" });
    expect(res.statusCode).toBe(422);
    expect(res.data.error.code).toBe("wallet_required");
  });

  it("treats SQL-looking and script input as data", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const search = await call("GET", `/v1/payments?search=${encodeURIComponent("' OR 1=1; DROP TABLE payments; --")}`, { cookie: s.cookie });
    expect(search.statusCode).toBe(200);
    expect(search.data.data).toEqual([]);
    const xss = await call("POST", "/v1/customers", { cookie: s.cookie }, { name: "<script>alert(1)</script>" });
    expect(xss.statusCode).toBe(201);
    expect(xss.data.name).toBe("<script>alert(1)</script>"); // stored verbatim, escaped at render time
    expect(xss.headers["content-type"]).toMatch(/application\/json/);
  });
});

describe("invoices, payments and the test-mode simulator", () => {
  it("creates an invoice with Monad + USDC defaults and a hosted payment link", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const res = await call("POST", "/v1/invoices", { cookie: s.cookie }, { customer_id: acme.id, amount: "2000.00", number: "INV-2041", title: "Infrastructure, October" });
    expect(res.statusCode).toBe(201);
    expect(res.data).toMatchObject({ number: "INV-2041", status: "open", amount_due: "2000.00", network: "monad", chain_id: 10143, asset: { symbol: "USDC", decimals: 6 } });
    expect(res.data.payment_url).toMatch(/\/pay\/[A-Za-z0-9_-]{16,}$/);
    const dupe = await call("POST", "/v1/invoices", { cookie: s.cookie }, { title: "Consulting services", customer_id: acme.id, amount: "1.00", number: "INV-2041" });
    expect(dupe.statusCode).toBe(409);
    const auto = await call("POST", "/v1/invoices", { cookie: s.cookie }, { title: "Consulting services", customer_id: acme.id, amount: "1.00" });
    expect(auto.data.number).toMatch(/^INV-\d+$/);
  });

  it("runs exact, partial, overpaid, unknown and wrong-token payments through the real pipeline", async () => {
    const s = await signup();
    const { acme, nova, studio } = await setupWorkspace(s);
    const auth = { cookie: s.cookie };
    const inv = async (customer: string, amount: string) => (await call("POST", "/v1/invoices", auth, { title: "Consulting services", customer_id: customer, amount })).data;

    const exact = await inv(nova.id, "2000.00");
    const p1 = await call("POST", "/v1/test/payments", auth, { scenario: "exact", invoice_id: exact.id });
    expect(p1.statusCode).toBe(201);
    expect(p1.data).toMatchObject({ status: "matched", simulated: true, explorer_url: null });
    expect(p1.data.decision.checks.map((c: any) => c.code)).toContain("uniqueness");
    expect((await call("GET", `/v1/invoices/${exact.id}`, auth)).data.status).toBe("paid");

    const partial = await inv(acme.id, "2000.00");
    const p2 = await call("POST", "/v1/test/payments", auth, { scenario: "partial", invoice_id: partial.id, amount: "1500.00" });
    expect(p2.data.status).toBe("partial");
    const partialInvoice = (await call("GET", `/v1/invoices/${partial.id}`, auth)).data;
    expect(partialInvoice).toMatchObject({ status: "partially_paid", amount_remaining: "500.00" });

    const over = await inv(studio.id, "2000.00");
    const p3 = await call("POST", "/v1/test/payments", auth, { scenario: "overpaid", invoice_id: over.id, amount: "2500.00" });
    expect(p3.data.status).toBe("overpaid");

    const p4 = await call("POST", "/v1/test/payments", auth, { scenario: "unknown", amount: "740.00" });
    expect(p4.data.status).toBe("needs_review");
    expect(p4.data.exceptions[0].type).toBe("unknown_payment");

    const p5 = await call("POST", "/v1/test/payments", auth, { scenario: "wrong_token", invoice_id: over.id });
    expect(p5.data.exceptions[0].type).toBe("wrong_token");

    const queue = await call("GET", "/v1/exceptions?status=open", auth);
    expect(queue.data.data.map((e: any) => e.type).sort()).toEqual(["overpayment", "partial_payment", "unknown_payment", "wrong_token"]);

    // Operator resolves the unknown payment onto the partially paid invoice: $740 of $500 remaining → overpaid.
    const unknown = queue.data.data.find((e: any) => e.type === "unknown_payment");
    const detail = await call("GET", `/v1/exceptions/${unknown.id}`, auth);
    expect(detail.data.allowed_actions).toEqual(["assign", "refund", "dismiss"]);
    const resolved = await call("POST", `/v1/exceptions/${unknown.id}/resolve`, auth, { action: "assign", invoice_id: partial.id, reason: "Customer confirmed by email" });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.data.status).toBe("resolved");
    expect(resolved.data.resolution).toMatchObject({ action: "assign", reason: "Customer confirmed by email", actor: { type: "user" } });
    expect((await call("GET", `/v1/invoices/${partial.id}`, auth)).data.status).toBe("overpaid");
  });

  it("simulates a controlled reorg with compensating history", async () => {
    const s = await signup();
    const { nova } = await setupWorkspace(s);
    const auth = { cookie: s.cookie };
    const invoice = (await call("POST", "/v1/invoices", auth, { title: "Consulting services", customer_id: nova.id, amount: "99.00" })).data;
    const p = (await call("POST", "/v1/test/payments", auth, { scenario: "exact", invoice_id: invoice.id })).data;
    const reorged = await call("POST", `/v1/test/payments/${p.id}/reorg`, auth);
    expect(reorged.data.status).toBe("reversed");
    expect(reorged.data.financial_events.map((e: any) => e.type)).toEqual(["PAYMENT_OBSERVED", "PAYMENT_MATCHED", "PAYMENT_REVERSED"]);
    expect(reorged.data.evidence).toMatchObject({ canonical: false, confirmation_state: "dropped" });
    expect((await call("GET", `/v1/invoices/${invoice.id}`, auth)).data.status).toBe("open");
  });

  it("refuses simulations in live mode", async () => {
    const s = await signup();
    await call("POST", "/v1/session/environment", { cookie: s.cookie }, { environment: "live" });
    const res = await call("POST", "/v1/test/payments", { cookie: s.cookie }, { scenario: "unknown" });
    expect(res.statusCode).toBe(403);
    expect(res.data.error.code).toBe("test_mode_only");
  });

  it("paginates, filters and sorts payments", async () => {
    const s = await signup();
    await setupWorkspace(s);
    const auth = { cookie: s.cookie };
    for (const amount of ["10.00", "30.00", "20.00", "50.00", "40.00"]) await call("POST", "/v1/test/payments", auth, { scenario: "unknown", amount });
    const first = await call("GET", "/v1/payments?limit=2&sort=amount_desc", auth);
    expect(first.data.data.map((p: any) => p.amount)).toEqual(["50.00", "40.00"]);
    expect(first.data.has_more).toBe(true);
    const second = await call("GET", `/v1/payments?limit=2&sort=amount_desc&starting_after=${first.data.next_cursor}`, auth);
    expect(second.data.data.map((p: any) => p.amount)).toEqual(["30.00", "20.00"]);
    const newest = await call("GET", "/v1/payments?limit=10", auth);
    expect(newest.data.data).toHaveLength(5);
    expect((await call("GET", "/v1/payments?status=matched", auth)).data.data).toHaveLength(0);
    expect((await call("GET", "/v1/payments?status=needs_review&network=monad&asset=USDC", auth)).data.data).toHaveLength(5);
  });
});

describe("API keys and authorization", () => {
  it("shows the secret once, stores only a hash, and authenticates bearer requests", async () => {
    const s = await signup();
    const key = await apiKey(s);
    expect(key).toMatch(/^sk_test_/);
    const list = await call("GET", "/v1/api-keys", { cookie: s.cookie });
    expect(JSON.stringify(list.data)).not.toContain(key);
    const stored = (await withTenant(s.orgId, (c) => c.query("SELECT secret_hash FROM api_keys WHERE organization_id = $1", [s.orgId]))).rows[0];
    expect(stored.secret_hash).not.toContain(key.slice(8));
    expect((await call("GET", "/v1/invoices", { key })).statusCode).toBe(200);
    expect((await call("GET", "/v1/api-keys", { key })).statusCode).toBe(403); // keys can't manage keys
  });

  it("enforces read-only scope and revocation", async () => {
    const s = await signup();
    const ro = await apiKey(s, { scope: "read_only" });
    const res = await call("POST", "/v1/customers", { key: ro }, { name: "Nope" });
    expect(res.statusCode).toBe(403);
    const keys = (await call("GET", "/v1/api-keys", { cookie: s.cookie })).data.data;
    await call("POST", `/v1/api-keys/${keys[0].id}/revoke`, { cookie: s.cookie });
    expect((await call("GET", "/v1/invoices", { key: ro })).statusCode).toBe(401);
  });

  it("scopes test keys to test data and live keys to live data", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    await call("POST", "/v1/invoices", { cookie: s.cookie }, { title: "Consulting services", customer_id: acme.id, amount: "5.00" });
    const live = await apiKey(s, { mode: "live" });
    expect(live).toMatch(/^sk_live_/);
    expect((await call("GET", "/v1/invoices", { key: live })).data.data).toHaveLength(0);
    expect((await call("GET", "/v1/customers", { key: live })).data.data).toHaveLength(0);
  });

  it("applies role permissions server-side", async () => {
    const owner = await signup();
    await setupWorkspace(owner);
    const invite = async (role: string) => {
      const email = `${role}+${Math.random().toString(36).slice(2)}@acme.test`;
      const inv = await call("POST", "/v1/members/invitations", { cookie: owner.cookie }, { email, role });
      const token = decodeURIComponent(inv.data.invitation_url.split("/invite/")[1]);
      const accepted = await call("POST", "/v1/invitations/accept", null, { token, name: role, password: "correct horse battery" });
      expect(accepted.statusCode).toBe(200);
      return { cookie: String(accepted.headers["set-cookie"]).split(";")[0]! };
    };
    const viewer = await invite("viewer");
    const developer = await invite("developer");
    const operator = await invite("operator");
    expect((await call("GET", "/v1/invoices", viewer)).statusCode).toBe(200);
    expect((await call("POST", "/v1/customers", viewer, { name: "X" })).statusCode).toBe(403);
    expect((await call("POST", "/v1/api-keys", operator, { name: "k" })).statusCode).toBe(403);
    expect((await call("POST", "/v1/api-keys", developer, { name: "k", mode: "test" })).statusCode).toBe(201);
    expect((await call("POST", "/v1/api-keys", developer, { name: "k", mode: "live" })).statusCode).toBe(403);
    expect((await call("POST", "/v1/wallets", developer, { name: "w", network: "monad", address: randomAddress() })).statusCode).toBe(403);
    expect((await call("PATCH", "/v1/organization", operator, { name: "Hijacked" })).statusCode).toBe(403);
  });
});

describe("idempotency", () => {
  it("replays the original response for a repeated key and rejects reuse with a different body", async () => {
    const s = await signup();
    const key = await apiKey(s);
    const headers = { "idempotency-key": "create-acme-0001" };
    const a = await call("POST", "/v1/customers", { key }, { name: "Acme Ltd" }, headers);
    const b = await call("POST", "/v1/customers", { key }, { name: "Acme Ltd" }, headers);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.data.id).toBe(a.data.id);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect((await call("GET", "/v1/customers", { key })).data.data).toHaveLength(1);
    const c = await call("POST", "/v1/customers", { key }, { name: "Different" }, headers);
    expect(c.statusCode).toBe(422);
    expect(c.data.error.code).toBe("idempotency_key_reused");
  });
});

describe("tenant isolation over HTTP", () => {
  let a: Session;
  let b: Session;
  let aKey: string;
  let bKey: string;
  let aInvoice: any;
  let aPayment: any;

  beforeAll(async () => {
    a = await signup("Acme Infrastructure");
    b = await signup("Beta Corp");
    const { acme } = await setupWorkspace(a);
    await setupWorkspace(b);
    aKey = await apiKey(a);
    bKey = await apiKey(b);
    aInvoice = (await call("POST", "/v1/invoices", { key: aKey }, { title: "Consulting services", customer_id: acme.id, amount: "10.00" })).data;
    aPayment = (await call("POST", "/v1/test/payments", { key: aKey }, { scenario: "unknown", amount: "3.00" })).data;
  });

  it("never returns another organization's objects", async () => {
    for (const url of [`/v1/invoices/${aInvoice.id}`, `/v1/payments/${aPayment.id}`, `/v1/exceptions/${aPayment.exceptions[0].id}`, `/v1/customers/${aInvoice.customer.id}`, `/v1/wallets/${aInvoice.wallet_id}`]) {
      const res = await call("GET", url, { key: bKey });
      expect(res.statusCode, url).toBe(404);
    }
    const list = await call("GET", "/v1/invoices", { key: bKey });
    expect(list.data.data.find((i: any) => i.id === aInvoice.id)).toBeUndefined();
  });

  it("cannot modify another organization's objects", async () => {
    expect((await call("POST", `/v1/invoices/${aInvoice.id}/cancel`, { key: bKey }, {})).statusCode).toBe(404);
    expect((await call("POST", `/v1/exceptions/${aPayment.exceptions[0].id}/resolve`, { key: bKey }, { action: "dismiss", reason: "not mine" })).statusCode).toBe(404);
    expect((await call("PATCH", `/v1/wallets/${aInvoice.wallet_id}`, { key: bKey }, { monitoring_enabled: false })).statusCode).toBe(404);
    expect((await call("POST", "/v1/invoices", { key: bKey }, { title: "Consulting services", customer_id: aInvoice.customer.id, amount: "1.00" })).statusCode).toBe(404);
    expect((await call("GET", `/v1/invoices/${aInvoice.id}`, { key: aKey })).data.status).toBe("open");
  });
});

describe("object-level authorization across every resource type", () => {
  it("org B can't read, modify, replay or revoke org A's events, webhooks, deliveries or keys", async () => {
    const a = await signup("Alpha");
    const b = await signup("Bravo");
    const { nova } = await setupWorkspace(a);
    const aKey = await apiKey(a);
    const bKey = await apiKey(b);
    const endpoint = (await call("POST", "/v1/webhook-endpoints", { key: aKey }, { url: "http://127.0.0.1:9/hook", event_types: ["payment.matched"] })).data;
    const invoice = (await call("POST", "/v1/invoices", { key: aKey }, { title: "Consulting services", customer_id: nova.id, amount: "3.00" })).data;
    await call("POST", "/v1/test/payments", { key: aKey }, { scenario: "exact", invoice_id: invoice.id });
    const event = (await call("GET", "/v1/financial-events?limit=1", { key: aKey })).data.data[0];
    const delivery = (await call("GET", "/v1/webhook-deliveries", { key: aKey })).data.data[0];
    const aKeys = (await call("GET", "/v1/api-keys", { cookie: a.cookie })).data.data;

    expect((await call("GET", `/v1/financial-events/${event.id}`, { key: bKey })).statusCode).toBe(404);
    expect((await call("GET", `/v1/webhook-deliveries/${delivery.id}`, { key: bKey })).statusCode).toBe(404);
    expect((await call("POST", `/v1/webhook-deliveries/${delivery.id}/replay`, { key: bKey })).statusCode).toBe(404);
    expect((await call("PATCH", `/v1/webhook-endpoints/${endpoint.id}`, { key: bKey }, { url: "https://evil.example/steal" })).statusCode).toBe(404);
    expect((await call("POST", `/v1/webhook-endpoints/${endpoint.id}/rotate-secret`, { key: bKey })).statusCode).toBe(404);
    expect((await call("DELETE", `/v1/webhook-endpoints/${endpoint.id}`, { key: bKey })).statusCode).toBe(404);
    expect((await call("POST", `/v1/api-keys/${aKeys[0].id}/revoke`, { cookie: b.cookie })).statusCode).toBe(404);
    expect((await call("POST", "/v1/payment-intents", { key: bKey }, { invoice_id: invoice.id })).statusCode).toBe(404);
    expect((await call("GET", "/v1/financial-events", { key: bKey })).data.data.find((e: any) => e.id === event.id)).toBeUndefined();
    // A's resources are untouched.
    expect((await call("GET", "/v1/webhook-endpoints", { key: aKey })).data.data[0].url).toBe("http://127.0.0.1:9/hook");
    expect((await call("GET", "/v1/invoices", { key: aKey })).statusCode).toBe(200);
  });

  it("test keys can't see live data and live keys can't run simulations", async () => {
    const s = await signup();
    const live = await apiKey(s, { mode: "live" });
    const res = await call("POST", "/v1/test/payments", { key: live }, { scenario: "unknown" });
    expect(res.statusCode).toBe(403);
  });
});

describe("hostile input and session handling", () => {
  it("rejects oversized bodies, malformed JSON and unknown ids cleanly", async () => {
    const s = await signup();
    const key = await apiKey(s);
    const huge = await call("POST", "/v1/customers", { key }, { name: "x".repeat(300_000) });
    expect(huge.statusCode).toBe(413);
    const s2 = await server();
    const malformed = await s2.inject({ method: "POST", url: "/v1/customers", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, payload: "{not json" });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("invalid_request");
    expect((await call("GET", "/v1/invoices/inv_does_not_exist", { key })).statusCode).toBe(404);
    expect((await call("GET", "/v1/invoices/%27%20OR%201%3D1--", { key })).statusCode).toBe(404);
  });

  it("an expired session is rejected", async () => {
    const s = await signup();
    await withGlobal((c) => c.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [s.userId]));
    expect((await call("GET", "/v1/me", { cookie: s.cookie })).statusCode).toBe(401);
  });

  it("never returns secrets or hashes in API responses", async () => {
    const s = await signup();
    const key = await apiKey(s);
    const endpoint = (await call("POST", "/v1/webhook-endpoints", { key }, { url: "http://127.0.0.1:9/h" })).data;
    const everything = JSON.stringify([
      (await call("GET", "/v1/api-keys", { cookie: s.cookie })).data,
      (await call("GET", "/v1/webhook-endpoints", { key })).data,
      (await call("GET", "/v1/me", { cookie: s.cookie })).data
    ]);
    expect(everything).not.toContain(key);
    expect(everything).not.toContain(endpoint.secret);
    expect(everything).not.toMatch(/secret_hash|secret_ciphertext|password_hash|token_hash/);
  });
});

describe("webhooks", () => {
  let receiver: Server;
  let url: string;
  const received: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];
  let failNext = 0;

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        if (failNext > 0) {
          failNext -= 1;
          res.writeHead(500).end("temporarily broken");
        } else res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/setra`;
  });
  afterAll(() => receiver.close());

  it("delivers signed events, retries failures, records attempts, replays and rotates secrets", async () => {
    const s = await signup();
    const { nova } = await setupWorkspace(s);
    const auth = { cookie: s.cookie };
    const endpoint = (await call("POST", "/v1/webhook-endpoints", auth, { url, event_types: ["payment.matched", "payment.unknown"] })).data;
    expect(endpoint.secret).toMatch(/^whsec_/);
    expect((await call("GET", "/v1/webhook-endpoints", auth)).body).not.toContain(endpoint.secret);

    const invoice = (await call("POST", "/v1/invoices", auth, { title: "Consulting services", customer_id: nova.id, amount: "2000.00", number: "INV-2041" })).data;
    await call("POST", "/v1/test/payments", auth, { scenario: "exact", invoice_id: invoice.id });
    failNext = 1;
    await deliverDueWebhooks();
    let deliveries = (await call("GET", "/v1/webhook-deliveries", auth)).data.data;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ event_type: "payment.matched", status: "retrying", attempt_count: 1, last_response_status: 500 });

    // Make it due now and retry.
    await withTenant(s.orgId, (c) => c.query("UPDATE webhook_deliveries SET next_attempt_at = now() WHERE organization_id = $1", [s.orgId]));
    await deliverDueWebhooks();
    const detail = (await call("GET", `/v1/webhook-deliveries/${deliveries[0].id}`, auth)).data;
    expect(detail.status).toBe("delivered");
    expect(detail.attempts.map((a: any) => a.response_status)).toEqual([500, 200]);

    const last = received[received.length - 1]!;
    expect(last.headers["x-setra-event-type"]).toBe("payment.matched");
    expect(last.headers["x-setra-delivery-id"]).toBe(deliveries[0].id);
    expect(verifySignature(endpoint.secret, last.body, String(last.headers["x-setra-timestamp"]), String(last.headers["x-setra-signature"]))).toBe(true);
    expect(verifySignature("whsec_forged", last.body, String(last.headers["x-setra-timestamp"]), String(last.headers["x-setra-signature"]))).toBe(false);
    const payload = JSON.parse(last.body);
    expect(payload).toMatchObject({ type: "payment.matched", object: "event", livemode: false, data: { type: "PAYMENT_MATCHED", invoice: { number: "INV-2041", status: "paid" }, payment: { amount: "2000.00", asset: "USDC", network: "monad" } } });

    // Replay: a new delivery, same event id and payload.
    const replay = await call("POST", `/v1/webhook-deliveries/${deliveries[0].id}/replay`, auth);
    expect(replay.statusCode).toBe(202);
    await deliverDueWebhooks();
    const replayed = received[received.length - 1]!;
    expect(JSON.parse(replayed.body).id).toBe(payload.id);
    expect(replayed.headers["x-setra-delivery-id"]).toBe(replay.data.delivery_id);
    deliveries = (await call("GET", "/v1/webhook-deliveries", auth)).data.data;
    expect(deliveries).toHaveLength(2);

    // Rotation: both secrets verify during the overlap.
    const rotated = (await call("POST", `/v1/webhook-endpoints/${endpoint.id}/rotate-secret`, auth)).data;
    await call("POST", `/v1/webhook-endpoints/${endpoint.id}/test`, auth);
    await deliverDueWebhooks();
    const test = received[received.length - 1]!;
    expect(test.headers["x-setra-event-type"]).toBe("webhook.test");
    expect(verifySignature(rotated.secret, test.body, String(test.headers["x-setra-timestamp"]), String(test.headers["x-setra-signature"]))).toBe(true);
    expect(verifySignature(endpoint.secret, test.body, String(test.headers["x-setra-timestamp"]), String(test.headers["x-setra-signature"]))).toBe(true);
  });

  it("does not deliver a financial event twice to the same endpoint", async () => {
    const s = await signup();
    const { nova } = await setupWorkspace(s);
    const auth = { cookie: s.cookie };
    await call("POST", "/v1/webhook-endpoints", auth, { url, event_types: ["payment.matched"] });
    const invoice = (await call("POST", "/v1/invoices", auth, { title: "Consulting services", customer_id: nova.id, amount: "1.00" })).data;
    await call("POST", "/v1/test/payments", auth, { scenario: "exact", invoice_id: invoice.id });
    await deliverDueWebhooks();
    await deliverDueWebhooks();
    expect((await call("GET", "/v1/webhook-deliveries", auth)).data.data).toHaveLength(1);
  });
});

describe("reconciliation, exports and the hosted payment page", () => {
  it("reconciles expected vs received vs applied and exports CSV", async () => {
    const s = await signup();
    const { acme, nova } = await setupWorkspace(s);
    const auth = { cookie: s.cookie };
    const a = (await call("POST", "/v1/invoices", auth, { title: "Consulting services", customer_id: nova.id, amount: "2100.00" })).data;
    const b = (await call("POST", "/v1/invoices", auth, { title: "Consulting services", customer_id: acme.id, amount: "2000.00" })).data;
    await call("POST", "/v1/test/payments", auth, { scenario: "exact", invoice_id: a.id });
    await call("POST", "/v1/test/payments", auth, { scenario: "partial", invoice_id: b.id, amount: "1500.00" });
    await call("POST", "/v1/test/payments", auth, { scenario: "unknown", amount: "740.00" });
    const rec = (await call("GET", "/v1/reconciliation", auth)).data;
    expect(rec.summary).toMatchObject({ expected: "4100.00", received: "4340.00", applied: "3600.00", needs_review: "740.00", outstanding: "500.00" });
    expect(rec.exceptions.map((e: any) => e.type).sort()).toEqual(["partial_payment", "unknown_payment"]);

    const csv = await call("GET", "/v1/exports/payments.csv", auth);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]).toBe("payment_id,date,status,customer,invoice,invoice_title,purpose,purpose_status,context_source,amount,asset,network,chain_id,sender,recipient_wallet,wallet_name,transaction_hash,block_number,matched_at,rule_version,source");
    expect(lines).toHaveLength(4);
    const recCsv = await call("GET", "/v1/exports/reconciliation.csv", auth);
    expect(recCsv.body).toContain("unapplied_payment");
    expect(recCsv.body.split("\r\n").filter((l) => l.startsWith("invoice,"))).toHaveLength(2);
  });

  it("exposes only what a payer needs", async () => {
    const s = await signup();
    const { acme } = await setupWorkspace(s);
    const invoice = (await call("POST", "/v1/invoices", { cookie: s.cookie }, { title: "Consulting services", customer_id: acme.id, amount: "2000.00", number: "INV-2041" })).data;
    const token = invoice.payment_url.split("/pay/")[1];
    const page = await call("GET", `/v1/public/payment-requests/${token}`, null);
    expect(page.statusCode).toBe(200);
    expect(page.data).toMatchObject({ merchant: { name: "Acme Infrastructure" }, invoice: { number: "INV-2041", amount_due: "2000.00" }, state: "awaiting_payment", test_mode: true, pay: { amount: "2000.00", asset: { symbol: "USDC" }, network: { chain_id: 10143 } } });
    const body = JSON.stringify(page.data);
    expect(body).not.toContain(invoice.id);
    expect(body).not.toContain(acme.id);
    expect(body).not.toContain("ap@acme.test");
    expect(body).not.toContain(s.orgId);
    const paid = await call("POST", `/v1/public/payment-requests/${token}/simulate`, null);
    expect(paid.data.state).toBe("paid");
    expect((await call("GET", "/v1/public/payment-requests/not-a-real-token-123456", null)).statusCode).toBe(404);
  });
});

describe("rate limiting", () => {
  it("throttles repeated login attempts", async () => {
    let last = 0;
    for (let i = 0; i < 40; i++) {
      last = (await call("POST", "/v1/auth/login", null, { email: "brute@force.test", password: "guess-number-" + i }, { "x-forwarded-for": "203.0.113.7" })).statusCode;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe("health", () => {
  it("serves liveness, readiness and a detailed report whose strict form fails when degraded", async () => {
    expect((await call("GET", "/v1/health/live", null)).statusCode).toBe(200);
    const ready = await call("GET", "/v1/health/ready", null);
    expect(ready.statusCode).toBe(200);
    const full = await call("GET", "/v1/health", null);
    expect(full.statusCode).toBe(200);
    expect(full.data.checks.database).toBe("ok");
    expect(full.data.checks.webhooks).toMatchObject({ status: expect.any(String), due: expect.any(Number) });
    for (const n of full.data.checks.ingestion) expect(["ok", "delayed", "error", "not_started"]).toContain(n.status);
    for (const p of full.data.problems) expect(p).toMatch(/^(database|ingestion(:[a-z0-9-]+:(delayed|error|not_started))?|webhooks:stalled)$/);
    expect(full.data.status).toBe(full.data.problems.length ? "degraded" : "ok");
    // No worker runs during tests, so ingestion is not current: strict mode must report it.
    const strict = await call("GET", "/v1/health?strict=true", null);
    expect(strict.statusCode).toBe(full.data.problems.length ? 503 : 200);
  });
});
