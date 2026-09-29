import { afterAll, describe, expect, it } from "vitest";
import { closePools } from "../../../packages/database/src";
import { call, server, setupWorkspace, signup } from "./helpers";

/** The sidecar's service endpoints: authenticated, validated, and never part of tenant APIs. */

afterAll(async () => {
  await (await server()).close();
  await closePools();
});

const TOKEN = process.env.EXEC_EVENTS_INGEST_TOKEN!;
const auth = { authorization: `Bearer ${TOKEN}` };

describe("execution events ingestion endpoint", () => {
  it("requires the shared token", async () => {
    expect((await call("POST", "/v1/internal/execution-events", null, { chain_id: 10143, sidecar_id: "x", signals: [] })).statusCode).toBe(401);
    expect((await call("POST", "/v1/internal/execution-events", null, { chain_id: 10143, sidecar_id: "x", signals: [] }, { authorization: "Bearer wrong-token-wrong-token-wrong-token" })).statusCode).toBe(401);
    // A tenant API key or session is not a sidecar credential.
    const s = await signup();
    expect((await call("POST", "/v1/internal/execution-events", { cookie: s.cookie }, { chain_id: 10143, sidecar_id: "x", signals: [] })).statusCode).toBe(401);
  });

  it("accepts a heartbeat for a monitored chain and reports stream health", async () => {
    const res = await call("POST", "/v1/internal/execution-events", null, { chain_id: 10143, sidecar_id: "node-1", stats: { events_consumed: 5000, events_relevant: 0 }, signals: [] }, auth);
    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({ accepted: 0, observations: 0 });
    const health = await call("GET", "/v1/health", null);
    const stream = health.data.checks.execution_events.streams.find((s: any) => s.chain_id === 10143);
    expect(stream).toMatchObject({ network: "monad-testnet", sidecar_id: "node-1", events_consumed: "5000" });
    expect(health.data.checks.execution_events.enabled).toBe(true);
  });

  it("refuses chains this deployment doesn't monitor and malformed signals", async () => {
    const unknown = await call("POST", "/v1/internal/execution-events", null, { chain_id: 1, sidecar_id: "x", signals: [] }, auth);
    expect(unknown.statusCode).toBe(422);
    expect(unknown.data.error.code).toBe("network_not_monitored");
    const bad = await call("POST", "/v1/internal/execution-events", null, { chain_id: 10143, sidecar_id: "x", signals: [{ kind: "log", block_hash: "nope" }] }, auth);
    expect(bad.statusCode).toBe(422);
  });

  it("serves a watchlist of monitored wallets and supported tokens", async () => {
    const s = await signup();
    const { wallet } = await setupWorkspace(s);
    const res = await call("GET", "/v1/internal/execution-events/watchlist?chain_id=10143", null, undefined, auth);
    expect(res.statusCode).toBe(200);
    expect(res.data.chain_id).toBe(10143);
    expect(res.data.recipients).toContain(wallet.address);
    expect(res.data.tokens).toContain("0x534b2f3a21130d7a60830c2df862319e593943a3");
    expect((await call("GET", "/v1/internal/execution-events/watchlist?chain_id=10143", null)).statusCode).toBe(401);
  });

  it("is not in the public OpenAPI document", async () => {
    const doc = await call("GET", "/openapi.json", null);
    expect(JSON.stringify(doc.data)).not.toContain("/v1/internal/");
  });
});
