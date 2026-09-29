import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { randomBytes } from "node:crypto";
import { setLogger, silentLogger } from "../../../packages/engine/src";
import { buildServer } from "../src/server";

setLogger(silentLogger);

let app: FastifyInstance | undefined;
export async function server(): Promise<FastifyInstance> {
  app ??= await buildServer({ logger: false });
  return app;
}

export const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";
export const randomAddress = () => `0x${randomBytes(20).toString("hex")}`;

export interface Session {
  cookie: string;
  orgId: string;
  userId: string;
  email: string;
}

export type Auth = { cookie: string } | { key: string } | null;

export async function call(method: string, url: string, auth: Auth, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse & { data: any }> {
  const s = await server();
  const h: Record<string, string> = { ...headers };
  if (auth && "cookie" in auth) {
    h.cookie = auth.cookie;
    if (method !== "GET" && !("origin" in headers)) h.origin = ORIGIN;
  }
  if (auth && "key" in auth) h.authorization = `Bearer ${auth.key}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await s.inject({ method: method as never, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
  let data: any = null;
  try {
    data = res.json();
  } catch {
    data = res.body;
  }
  return Object.assign(res, { data });
}

export async function signup(business = "Acme Infrastructure"): Promise<Session> {
  const email = `owner+${randomBytes(4).toString("hex")}@acme.test`;
  // Each simulated merchant signs up from its own address, so the per-IP auth rate limit applies realistically.
  const ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const res = await call("POST", "/v1/auth/signup", null, { name: "Maya Chen", email, password: "correct horse battery", business_name: business }, { "x-forwarded-for": ip });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.body}`);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  return { cookie, orgId: res.data.organization_id, userId: res.data.user.id, email };
}

/** Wallet + customers ready for invoicing in test mode (Monad testnet). */
export async function setupWorkspace(s: Session) {
  const auth = { cookie: s.cookie };
  const wallet = (await call("POST", "/v1/wallets", auth, { name: "Main Wallet", network: "monad", address: randomAddress(), assets: ["USDC"] })).data;
  const acmeAddress = randomAddress();
  const acme = (await call("POST", "/v1/customers", auth, { name: "Acme Ltd", email: "ap@acme.test", wallet_addresses: [{ address: acmeAddress, network: "monad" }] })).data;
  const nova = (await call("POST", "/v1/customers", auth, { name: "Nova Systems" })).data;
  const studio = (await call("POST", "/v1/customers", auth, { name: "Studio Ten", wallet_addresses: [{ address: randomAddress(), network: "monad" }] })).data;
  return { wallet, acme, nova, studio, acmeAddress };
}

export async function apiKey(s: Session, options: { scope?: "read_write" | "read_only"; mode?: "test" | "live" } = {}): Promise<string> {
  const res = await call("POST", "/v1/api-keys", { cookie: s.cookie }, { name: "Test key", scope: options.scope ?? "read_write", mode: options.mode });
  if (res.statusCode !== 201) throw new Error(`key creation failed: ${res.body}`);
  return res.data.secret;
}
