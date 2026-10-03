import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * @setra/sdk, a small, dependency-free client for the Setra API, plus webhook verification.
 *
 *   const setra = new Setra({ apiKey: process.env.SETRA_KEY! });
 *   const invoice = await setra.invoices.create({ customer_id, title: "September Infrastructure Services", amount: "2000.00" }, { idempotencyKey: order.id });
 */

export interface SetraOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class SetraError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "SetraError";
  }
}

export interface List<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

type Params = Record<string, string | number | boolean | undefined | null>;
type Json = Record<string, unknown>;

export class Setra {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SetraOptions) {
    if (!/^sk_(test|live)_/.test(options.apiKey)) throw new Error("Setra: apiKey must start with sk_test_ or sk_live_");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://setra.up.railway.app/api").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Low-level request. Retries network errors and 5xx responses on idempotent calls. */
  async request<T = Json>(method: string, path: string, options: { body?: unknown; query?: Params; idempotencyKey?: string } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, accept: "application/json", "user-agent": "setra-node/0.1.0" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const retryable = method === "GET" || Boolean(options.idempotencyKey);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (error) {
        if (retryable && attempt < 2) {
          await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
          continue;
        }
        throw new SetraError(0, "network_error", (error as Error).message);
      }
      if (res.status >= 500 && retryable && attempt < 2) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      const text = await res.text();
      const data = text ? JSON.parse(text) : undefined;
      if (!res.ok) {
        const e = data?.error ?? {};
        throw new SetraError(res.status, e.code ?? "error", e.message ?? res.statusText, e.request_id, e.details);
      }
      return data as T;
    }
  }

  /** Iterate every item of a list endpoint, following cursors. */
  async *paginate<T = Json>(path: string, query: Params = {}): AsyncGenerator<T> {
    let cursor: string | null | undefined;
    do {
      const page: List<T> = await this.request("GET", path, { query: { ...query, limit: query.limit ?? 100, starting_after: cursor ?? undefined } });
      for (const item of page.data) yield item;
      cursor = page.next_cursor;
    } while (cursor);
  }

  readonly invoices = {
    create: (body: Json, opts: { idempotencyKey?: string } = {}) => this.request("POST", "/v1/invoices", { body, idempotencyKey: opts.idempotencyKey }),
    retrieve: (id: string) => this.request("GET", `/v1/invoices/${encodeURIComponent(id)}`),
    list: (query: Params = {}) => this.request<List<Json>>("GET", "/v1/invoices", { query }),
    cancel: (id: string, reason?: string) => this.request("POST", `/v1/invoices/${encodeURIComponent(id)}/cancel`, { body: { reason } })
  };

  readonly customers = {
    create: (body: Json, opts: { idempotencyKey?: string } = {}) => this.request("POST", "/v1/customers", { body, idempotencyKey: opts.idempotencyKey }),
    retrieve: (id: string) => this.request("GET", `/v1/customers/${encodeURIComponent(id)}`),
    list: (query: Params = {}) => this.request<List<Json>>("GET", "/v1/customers", { query }),
    addWalletAddress: (id: string, body: Json) => this.request("POST", `/v1/customers/${encodeURIComponent(id)}/wallet-addresses`, { body })
  };

  readonly payments = {
    retrieve: (id: string) => this.request("GET", `/v1/payments/${encodeURIComponent(id)}`),
    list: (query: Params = {}) => this.request<List<Json>>("GET", "/v1/payments", { query })
  };

  readonly exceptions = {
    list: (query: Params = {}) => this.request<List<Json>>("GET", "/v1/exceptions", { query }),
    retrieve: (id: string) => this.request("GET", `/v1/exceptions/${encodeURIComponent(id)}`),
    resolve: (id: string, body: { action: "assign" | "dismiss" | "acknowledge" | "write_off"; reason: string; invoice_id?: string; remember_sender?: boolean }) =>
      this.request("POST", `/v1/exceptions/${encodeURIComponent(id)}/resolve`, { body })
  };

  readonly financialEvents = {
    list: (query: Params = {}) => this.request<List<Json>>("GET", "/v1/financial-events", { query }),
    retrieve: (id: string) => this.request("GET", `/v1/financial-events/${encodeURIComponent(id)}`)
  };

  readonly paymentIntents = {
    create: (body: { invoice_id: string; expires_in_seconds?: number }, opts: { idempotencyKey?: string } = {}) => this.request("POST", "/v1/payment-intents", { body, idempotencyKey: opts.idempotencyKey }),
    retrieve: (id: string) => this.request("GET", `/v1/payment-intents/${encodeURIComponent(id)}`)
  };

  readonly webhookEndpoints = {
    create: (body: { url: string; event_types?: string[]; description?: string }) => this.request("POST", "/v1/webhook-endpoints", { body }),
    list: () => this.request<List<Json>>("GET", "/v1/webhook-endpoints"),
    rotateSecret: (id: string) => this.request<{ secret: string }>("POST", `/v1/webhook-endpoints/${encodeURIComponent(id)}/rotate-secret`)
  };

  readonly reconciliation = {
    retrieve: (query: { period_start?: string; period_end?: string } = {}) => this.request("GET", "/v1/reconciliation", { query })
  };

  /** Test mode only. */
  readonly test = {
    simulatePayment: (body: { scenario: string; invoice_id?: string; amount?: string; finalize?: boolean }) => this.request("POST", "/v1/test/payments", { body })
  };
}

/**
 * Verify a Setra webhook signature against the RAW request body.
 * Header format: `v1=<hex>[,v1=<hex>]` (two values during secret rotation).
 */
export function verifySetraWebhook(secret: string, rawBody: string | Buffer, timestamp: string | undefined | null, signatureHeader: string | undefined | null, toleranceSeconds = 300): boolean {
  if (!timestamp || !signatureHeader) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSeconds) return false;
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest();
  return signatureHeader
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.startsWith("v1="))
    .some((p) => {
      const candidate = Buffer.from(p.slice(3), "hex");
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
}
