import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, withSystem, withTenant } from "../../database/src";
import { verifySignature } from "../../events/src";
import { newId } from "../../schemas/src";
import { deliverDueWebhooks, ingestObservation, newWebhookSecret, replayDelivery } from "../src";
import { invoice, randomAddress, transfer, usd, workspace, type Workspace } from "../../../test/fixtures";

/**
 * Webhook reliability against a real HTTP receiver: every failure class, retry/backoff, permanent
 * failure, eventual success, replay, and the outbox guarantee that financial events never depend on
 * delivery succeeding.
 */

let server: Server;
let base: string;
const behaviour = new Map<string, number | "timeout">(); // path → status
const hits: Array<{ path: string; headers: IncomingMessage["headers"]; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ path: req.url!, headers: req.headers, body });
      const b = behaviour.get(req.url!) ?? 200;
      if (b === "timeout") return; // never respond
      res.writeHead(b).end(`status ${b}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await closePools();
});

async function endpoint(ws: Workspace, path: string) {
  const secret = newWebhookSecret();
  const id = newId("webhookEndpoint");
  await withTenant(ws.orgId, (c) =>
    c.query(`INSERT INTO webhook_endpoints (id, organization_id, environment, url, event_types, secret_ciphertext, secret_hint) VALUES ($1,$2,'test',$3,$4,$5,$6)`, [
      id,
      ws.orgId,
      `${base}${path}`,
      ["payment.matched", "payment.unknown"],
      secret.ciphertext,
      secret.hint
    ])
  );
  return { id, secret: secret.secret };
}

const deliveries = (ws: Workspace) => withTenant(ws.orgId, (c) => c.query("SELECT * FROM webhook_deliveries ORDER BY id")).then((r) => r.rows);
const makeDue = (ws: Workspace) => withTenant(ws.orgId, (c) => c.query("UPDATE webhook_deliveries SET next_attempt_at = now() WHERE status = 'retrying'"));
async function pay(ws: Workspace, amount = "10.00") {
  await invoice(ws, "Acme Ltd", amount);
  await withTenant(ws.orgId, (c) => ingestObservation(c, ws.wallet, transfer(ws, usd(amount), ws.customers["Acme Ltd"]!.address!), "settled"));
}
/** Deliver only this workspace's queue (other suites share the database). */
async function deliver(ws: Workspace, opts: { timeoutMs?: number; maxAttempts?: number } = {}) {
  await withSystem((c) => c.query("UPDATE webhook_deliveries SET next_attempt_at = now() + interval '1 day' WHERE organization_id <> $1 AND status IN ('pending','retrying')", [ws.orgId]));
  return deliverDueWebhooks({ timeoutMs: opts.timeoutMs ?? 800, maxAttempts: opts.maxAttempts ?? 10 });
}

describe("failure classes", () => {
  for (const status of [400, 401, 404, 429, 500, 503] as const) {
    it(`HTTP ${status} is retried with backoff and recorded, never marked delivered`, async () => {
      const ws = await workspace();
      const path = `/fail-${status}-${ws.orgId}`;
      behaviour.set(path, status);
      await endpoint(ws, path);
      await pay(ws);
      await deliver(ws);
      const [d] = await deliveries(ws);
      expect(d).toMatchObject({ status: "retrying", attempt_count: 1, last_response_status: status });
      expect(new Date(d.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 10_000); // backoff scheduled
      const attempts = (await withTenant(ws.orgId, (c) => c.query("SELECT * FROM webhook_attempts WHERE delivery_id = $1", [d.id]))).rows;
      expect(attempts).toHaveLength(1);
      expect(attempts[0].response_status).toBe(status);
    });
  }

  it("a timeout is retried and recorded with a clear error", async () => {
    const ws = await workspace();
    const path = `/timeout-${ws.orgId}`;
    behaviour.set(path, "timeout");
    await endpoint(ws, path);
    await pay(ws);
    await deliver(ws, { timeoutMs: 300 });
    const [d] = await deliveries(ws);
    expect(d.status).toBe("retrying");
    expect(d.last_response_status).toBeNull();
    expect(d.last_error).toMatch(/Timed out/);
  });

  it("410 Gone stops retries immediately", async () => {
    const ws = await workspace();
    const path = `/gone-${ws.orgId}`;
    behaviour.set(path, 410);
    await endpoint(ws, path);
    await pay(ws);
    await deliver(ws);
    expect((await deliveries(ws))[0]).toMatchObject({ status: "failed", attempt_count: 1 });
  });

  it("gives up after the maximum attempts and marks the delivery failed (visible, replayable)", async () => {
    const ws = await workspace();
    const path = `/always-500-${ws.orgId}`;
    behaviour.set(path, 500);
    await endpoint(ws, path);
    await pay(ws);
    for (let i = 0; i < 3; i++) {
      await makeDue(ws);
      await deliver(ws, { maxAttempts: 3 });
    }
    expect((await deliveries(ws))[0]).toMatchObject({ status: "failed", attempt_count: 3 });
  });
});

describe("recovery, replay and idempotency", () => {
  it("fails, then succeeds once the receiver recovers; the same event id is delivered each time", async () => {
    const ws = await workspace();
    const path = `/recover-${ws.orgId}`;
    behaviour.set(path, 503);
    const { secret } = await endpoint(ws, path);
    await pay(ws);
    await deliver(ws);
    behaviour.set(path, 200);
    await makeDue(ws);
    await deliver(ws);
    const [d] = await deliveries(ws);
    expect(d).toMatchObject({ status: "delivered", attempt_count: 2, last_response_status: 200 });
    const mine = hits.filter((h) => h.path === path);
    expect(mine).toHaveLength(2);
    expect(mine[0]!.headers["x-setra-event-id"]).toBe(mine[1]!.headers["x-setra-event-id"]);
    expect(mine[0]!.headers["x-setra-delivery-id"]).toBe(mine[1]!.headers["x-setra-delivery-id"]);
    const last = mine[1]!;
    expect(verifySignature(secret, last.body, String(last.headers["x-setra-timestamp"]), String(last.headers["x-setra-signature"]))).toBe(true);
  });

  it("replay sends the identical event with a new delivery id, so receivers can dedupe on the event id", async () => {
    const ws = await workspace();
    const path = `/replay-${ws.orgId}`;
    await endpoint(ws, path);
    await pay(ws);
    await deliver(ws);
    const [original] = await deliveries(ws);
    await withTenant(ws.orgId, (c) => replayDelivery(c, ws.orgId, original.id, ws.actor));
    await deliver(ws);
    const mine = hits.filter((h) => h.path === path);
    expect(mine).toHaveLength(2);
    expect(JSON.parse(mine[0]!.body).id).toBe(JSON.parse(mine[1]!.body).id);
    expect(mine[0]!.headers["x-setra-delivery-id"]).not.toBe(mine[1]!.headers["x-setra-delivery-id"]);
  });

  it("outbox: the financial event exists and is correct even while every delivery fails", async () => {
    const ws = await workspace();
    const path = `/down-${ws.orgId}`;
    behaviour.set(path, 500);
    await endpoint(ws, path);
    await pay(ws);
    await deliver(ws);
    const events = (await withTenant(ws.orgId, (c) => c.query("SELECT type FROM financial_events ORDER BY id"))).rows.map((r) => r.type);
    expect(events).toEqual(["PAYMENT_OBSERVED", "PAYMENT_MATCHED"]);
    expect((await withTenant(ws.orgId, (c) => c.query("SELECT status FROM invoices"))).rows[0].status).toBe("paid");
  });

  it("a delivery claimed by a worker that died is picked up again after its lock expires", async () => {
    const ws = await workspace();
    const path = `/orphan-${ws.orgId}`;
    await endpoint(ws, path);
    await pay(ws);
    await withTenant(ws.orgId, (c) => c.query("UPDATE webhook_deliveries SET status = 'delivering', locked_until = now() - interval '1 second'"));
    await deliver(ws);
    expect((await deliveries(ws))[0].status).toBe("delivered");
  });
});

describe("signature verification at the receiver", () => {
  it("valid passes; tampered payload, wrong secret, stale timestamp and replayed old signature fail", async () => {
    const ws = await workspace();
    const path = `/verify-${ws.orgId}`;
    const { secret } = await endpoint(ws, path);
    await pay(ws);
    await deliver(ws);
    const h = hits.find((x) => x.path === path)!;
    const ts = String(h.headers["x-setra-timestamp"]);
    const sig = String(h.headers["x-setra-signature"]);
    expect(verifySignature(secret, h.body, ts, sig)).toBe(true);
    expect(verifySignature(secret, h.body.replace('"10.00"', '"100.00"'), ts, sig)).toBe(false);
    expect(verifySignature("whsec_wrong", h.body, ts, sig)).toBe(false);
    expect(verifySignature(secret, h.body, ts, sig, { now: (Number(ts) + 3600) * 1000 })).toBe(false);
    expect(verifySignature(secret, h.body, String(Number(ts) - 1), sig)).toBe(false);
    void randomAddress;
  });
});
