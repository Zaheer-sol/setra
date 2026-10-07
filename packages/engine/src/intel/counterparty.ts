import { networks } from "@setra/config";
import { withGlobal, withTenant } from "@setra/database";
import { log } from "../context";

/**
 * Counterparty intelligence: who is behind the wallet that sent an unidentified payment?
 *
 * Setra asks Nansen for the public labels on the sender's address and turns them into a plain
 * explanation and a suggested next step. It is a hint for a person, never a match: Setra's matching
 * stays deterministic and nothing is applied or classified from a label. Off by default per
 * workspace (it sends the address to Nansen); results are cached for a week.
 */

export interface CounterpartyLabel {
  label: string;
  category: string | null;
  kind: string[];
}

export type CounterpartyKind = "exchange" | "bridge" | "fund" | "contract" | "protocol" | "wallet" | "unknown";

export type CounterpartyIntel =
  | { status: "disabled" | "not_configured" | "unsupported_chain" | "not_looked_up"; source: "nansen"; message: string }
  | { status: "error"; source: "nansen"; message: string }
  | {
      status: "ok" | "none";
      source: "nansen";
      chain: string;
      address: string;
      mainnetLabelsForTestnet: boolean;
      labels: CounterpartyLabel[];
      kind: CounterpartyKind;
      summary: string;
      suggestion: string;
      fetchedAt: string;
      cached: boolean;
    };

const TTL_MS = 7 * 86_400_000;
// A failed lookup isn't retried on every page view: wait a while, so a missing key, empty credits or a
// rate limit don't turn each visit into another paid request.
const ERROR_RETRY_MS = 15 * 60_000;

/** Fresh enough to serve without asking Nansen again. */
const fresh = (row: { status: string; fetched_at: Date } | undefined) =>
  !!row && Date.now() - new Date(row.fetched_at).getTime() < (row.status === "error" ? ERROR_RETRY_MS : TTL_MS);

/** Nansen's HTTP errors in words a person can act on. */
function nansenError(status: number): string {
  if (status === 401) return "Nansen didn't accept the API key.";
  if (status === 402 || status === 403) return "The Nansen account is out of credits or its plan doesn't include this lookup.";
  if (status === 429) return "Nansen is limiting requests right now. Try again in a minute.";
  return `Nansen responded ${status}.`;
}
const NANSEN_URL = "https://api.nansen.ai/api/v1/profiler/address/labels";

/** Nansen's chain name for a Setra chain. Testnets map to their mainnet (addresses are the same). */
export function nansenChain(chainId: number): { chain: string; testnet: boolean } | null {
  const n = networks().byChainId(chainId);
  if (!n) return null;
  if (n.family === "monad") return { chain: "monad", testnet: n.environment === "test" };
  if (n.family === "base") return { chain: "base", testnet: n.environment === "test" };
  return null;
}

/** What kind of wallet the labels describe. */
export function labelKind(labels: CounterpartyLabel[]): CounterpartyKind {
  const text = labels.map((l) => `${l.label} ${l.category ?? ""} ${l.kind.join(" ")}`).join(" | ").toLowerCase();
  if (!labels.length) return "unknown";
  if (/\b(cex|exchange|binance|coinbase|kraken|okx|bybit|kucoin|gate\.io|bitget|htx|huobi|deposit wallet|hot wallet)\b/.test(text)) return "exchange";
  if (/\b(bridge|wormhole|layerzero|stargate|across|relay|axelar|cctp)\b/.test(text)) return "bridge";
  if (/\b(fund|capital|ventures|vc|treasury|dao)\b/.test(text)) return "fund";
  if (/\b(contract|deployer|router|vault|pool)\b/.test(text)) return "contract";
  if (/\b(defi|protocol|dex|lending)\b/.test(text)) return "protocol";
  return "wallet";
}

/** Wallets that many people pay from or into. Saving one to a single customer or vendor would misattribute future money. */
export const isSharedKind = (kind: CounterpartyKind) => kind === "exchange" || kind === "bridge" || kind === "contract" || kind === "protocol";

/** Money going out: what the recipient's labels suggest it was. */
function interpretOutgoing(labels: CounterpartyLabel[]): { kind: CounterpartyKind; summary: string; suggestion: string } {
  const kind = labelKind(labels);
  const names = labels.slice(0, 3).map((l) => l.label).join(", ");
  switch (kind) {
    case "unknown":
      return { kind, summary: "No public labels for the receiving wallet. It's most likely a person's private wallet.", suggestion: "If it paid a contractor or a vendor, record it as an expense or a bill payment. If it went to an owner, classify it as an owner draw." };
    case "exchange":
      return { kind, summary: `Sent to an exchange wallet (${names}). This is often money moved to your own exchange account, for example to cash out.`, suggestion: "If the exchange account is yours, classify it as a transfer between your own accounts, not spending. If you paid someone through their exchange address, record it as an expense or bill payment." };
    case "bridge":
      return { kind, summary: `Sent to a bridge (${names}). The money left Monad for another chain.`, suggestion: "If it went to another wallet of yours, classify it as a transfer between your accounts; otherwise record what it paid for." };
    case "contract":
    case "protocol":
      return { kind, summary: `Sent to an app or protocol (${names}), not directly to a person.`, suggestion: "Check what you did in that app (a swap, a deposit, a subscription) and classify it to match." };
    case "fund":
      return { kind, summary: `Sent to a fund or treasury (${names}).`, suggestion: "If this repays a loan or returns an investment, classify it to that liability or equity account." };
    default:
      return { kind, summary: `Public labels: ${names}.`, suggestion: "Use the labels as a clue only, and confirm what it paid for before classifying it." };
  }
}

/** Read labels in plain words. Deterministic, so the same labels always give the same advice. */
export function interpretLabels(labels: CounterpartyLabel[], direction: "in" | "out" = "in"): { kind: CounterpartyKind; summary: string; suggestion: string } {
  if (direction === "out") return interpretOutgoing(labels);
  const text = labels.map((l) => `${l.label} ${l.category ?? ""} ${l.kind.join(" ")}`).join(" | ").toLowerCase();
  const names = labels.slice(0, 3).map((l) => l.label).join(", ");
  if (!labels.length) {
    return {
      kind: "unknown",
      summary: "No public labels for this wallet. It's most likely a private wallet.",
      suggestion: "Compare the amount and date with open invoices, or ask the customer you expected to pay. If it isn't a customer payment, classify it (for example, an owner contribution)."
    };
  }
  if (/\b(cex|exchange|binance|coinbase|kraken|okx|bybit|kucoin|gate\.io|bitget|htx|huobi|deposit wallet|hot wallet)\b/.test(text)) {
    return {
      kind: "exchange",
      summary: `Labelled as an exchange wallet (${names}). A customer probably paid from their exchange account, so the address won't match a wallet on file.`,
      suggestion: "Look for an open invoice with this amount around this date and assign it. Don't save this address to a customer: exchange wallets are shared by many people."
    };
  }
  if (/\b(bridge|wormhole|layerzero|stargate|across|relay|axelar|cctp)\b/.test(text)) {
    return {
      kind: "bridge",
      summary: `Labelled as a bridge (${names}). The money was moved to Monad from another chain, so the original sender is on that chain.`,
      suggestion: "Match by amount and date, or ask the customer for the source-chain transaction."
    };
  }
  if (/\b(fund|capital|ventures|vc|treasury|dao)\b/.test(text)) {
    return {
      kind: "fund",
      summary: `Labelled as a fund or treasury (${names}).`,
      suggestion: "If you expected an investment or a grant, classify it to the right equity or liability account; otherwise check for a matching invoice."
    };
  }
  if (/\b(contract|deployer|router|vault|pool)\b/.test(text)) {
    return {
      kind: "contract",
      summary: `Labelled as a smart contract (${names}). The payment came through an app, not directly from a person.`,
      suggestion: "Check which app your customer used to pay, then match by amount and date."
    };
  }
  if (/\b(defi|protocol|dex|lending)\b/.test(text)) {
    return { kind: "protocol", summary: `Labelled as a DeFi protocol wallet (${names}).`, suggestion: "It may be a withdrawal or a refund from a protocol rather than a customer payment; classify it accordingly." };
  }
  return {
    kind: "wallet",
    summary: `Public labels: ${names}.`,
    suggestion: "Use the labels as a clue only: confirm with the customer before assigning the payment."
  };
}

async function fetchNansen(chain: string, address: string): Promise<{ status: "ok" | "none"; labels: CounterpartyLabel[] }> {
  const key = process.env.NANSEN_API_KEY;
  if (!key) throw new Error("NANSEN_API_KEY is not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(NANSEN_URL, {
      method: "POST",
      headers: { apikey: key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ address, chain, pagination: { page: 1, per_page: 50 } }),
      signal: controller.signal
    });
    if (res.status === 404) return { status: "none", labels: [] };
    if (!res.ok) throw new Error(nansenError(res.status));
    const body = (await res.json()) as { data?: Array<{ label?: unknown; category?: unknown; kind?: unknown }> };
    const labels = (body.data ?? [])
      .filter((d) => typeof d.label === "string" && d.label.trim())
      .map((d) => ({ label: String(d.label).slice(0, 120), category: typeof d.category === "string" ? d.category.slice(0, 60) : null, kind: Array.isArray(d.kind) ? d.kind.filter((k): k is string => typeof k === "string").slice(0, 5) : [] }));
    return { status: labels.length ? "ok" : "none", labels };
  } finally {
    clearTimeout(timer);
  }
}

/** Labels and advice for a sender address, if the workspace has it enabled and Nansen covers the chain. */
export async function counterpartyIntel(organizationId: string, chainId: number, rawAddress: string, opts: { refresh?: boolean; direction?: "in" | "out"; cacheOnly?: boolean } = {}): Promise<CounterpartyIntel> {
  const address = rawAddress.toLowerCase();
  const enabled = (await withGlobal((c) => c.query("SELECT counterparty_intel_enabled FROM organizations WHERE id = $1", [organizationId]))).rows[0]?.counterparty_intel_enabled;
  if (!enabled) return { status: "disabled", source: "nansen", message: "Counterparty lookups are off for this workspace. Turn them on in Settings." };
  if (!process.env.NANSEN_API_KEY) return { status: "not_configured", source: "nansen", message: "Counterparty lookups need a Nansen API key on the server (NANSEN_API_KEY)." };
  const mapped = nansenChain(chainId);
  if (!mapped || !/^0x[0-9a-f]{40}$/.test(address)) return { status: "unsupported_chain", source: "nansen", message: "Nansen doesn't cover this network." };

  let row = (await withGlobal((c) => c.query("SELECT * FROM counterparty_labels WHERE source = 'nansen' AND chain = $1 AND address = $2", [mapped.chain, address]))).rows[0] as
    | { status: string; labels: CounterpartyLabel[]; error: string | null; fetched_at: Date }
    | undefined;
  let cached = true;
  const stale = !fresh(row);
  // Background checks (page loads) only read what someone already looked up; each new lookup costs credits.
  if (stale && opts.cacheOnly) return { status: "not_looked_up", source: "nansen", message: "Not looked up yet." };
  if (stale || opts.refresh) {
    cached = false;
    try {
      const r = await fetchNansen(mapped.chain, address);
      row = (
        await withGlobal((c) =>
          c.query(
            `INSERT INTO counterparty_labels (source, chain, address, status, labels, error, fetched_at) VALUES ('nansen', $1, $2, $3, $4, NULL, now())
             ON CONFLICT (source, chain, address) DO UPDATE SET status = EXCLUDED.status, labels = EXCLUDED.labels, error = NULL, fetched_at = now() RETURNING *`,
            [mapped.chain, address, r.status, JSON.stringify(r.labels)]
          )
        )
      ).rows[0];
    } catch (error) {
      const message = (error as Error).name === "AbortError" ? "Nansen didn't answer in time." : (error as Error).message.slice(0, 200);
      log().warn("counterparty_lookup_failed", { chain: mapped.chain, error: message });
      if (!row || row.status === "error") {
        await withGlobal((c) =>
          c.query(
            `INSERT INTO counterparty_labels (source, chain, address, status, labels, error, fetched_at) VALUES ('nansen', $1, $2, 'error', '[]', $3, now())
             ON CONFLICT (source, chain, address) DO UPDATE SET status = 'error', error = EXCLUDED.error, fetched_at = now()`,
            [mapped.chain, address, message]
          )
        );
        return { status: "error", source: "nansen", message: `Couldn't look up this wallet right now: ${message}` };
      }
      cached = true; // fall back to the last good answer
    }
  }
  const labels = (row!.labels ?? []) as CounterpartyLabel[];
  const reading = interpretLabels(labels, opts.direction ?? "in");
  return {
    status: labels.length ? "ok" : "none",
    source: "nansen",
    chain: mapped.chain,
    address,
    mainnetLabelsForTestnet: mapped.testnet,
    labels,
    kind: reading.kind,
    summary: reading.summary,
    suggestion: reading.suggestion,
    fetchedAt: new Date(row!.fetched_at).toISOString(),
    cached
  };
}

// ── related customers ─────────────────────────────────────────────────────────────────────────

export interface RelatedCustomer {
  customer_id: string;
  customer_name: string;
  wallet: string;
  interactions: number;
  volume_usd: number | null;
}

interface Counterparty {
  address: string;
  label: string | null;
  interactions: number;
  volume_usd: number | null;
}

const NANSEN_COUNTERPARTIES_URL = "https://api.nansen.ai/api/v1/profiler/address/counterparties";
const LOOKBACK_DAYS = 365;

async function fetchCounterparties(chain: string, address: string): Promise<Counterparty[]> {
  const key = process.env.NANSEN_API_KEY;
  if (!key) throw new Error("NANSEN_API_KEY is not set");
  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 86_400_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(NANSEN_COUNTERPARTIES_URL, {
      method: "POST",
      headers: { apikey: key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ address, chain, date: { from: from.toISOString(), to: to.toISOString() }, source_input: "Combined", group_by: "wallet", pagination: { page: 1, per_page: 100 } }),
      signal: controller.signal
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(nansenError(res.status));
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    return (body.data ?? [])
      .map((d) => ({
        address: String(d.counterparty_address ?? "").toLowerCase(),
        label: Array.isArray(d.counterparty_address_label) ? String(d.counterparty_address_label[0] ?? "") || null : typeof d.counterparty_address_label === "string" ? d.counterparty_address_label.slice(0, 120) : null,
        interactions: Number(d.interaction_count ?? 0) || 0,
        volume_usd: d.total_volume_usd == null ? null : Number(d.total_volume_usd)
      }))
      .filter((c) => /^0x[0-9a-f]{40}$/.test(c.address));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Known customers whose wallets the sender has transacted with on chain. If an unknown wallet has
 * repeatedly moved money to or from a wallet saved for Acme Ltd, Acme is a good first guess. It is
 * only ever shown as a suggestion; nothing is assigned from it.
 */
export async function relatedCustomers(organizationId: string, environment: "test" | "live", chainId: number, rawAddress: string, opts: { refresh?: boolean; cacheOnly?: boolean } = {}): Promise<{ status: "ok" | "none" | "unavailable"; customers: RelatedCustomer[]; lookbackDays: number }> {
  const address = rawAddress.toLowerCase();
  const unavailable = { status: "unavailable" as const, customers: [], lookbackDays: LOOKBACK_DAYS };
  const enabled = (await withGlobal((c) => c.query("SELECT counterparty_intel_enabled FROM organizations WHERE id = $1", [organizationId]))).rows[0]?.counterparty_intel_enabled;
  const mapped = nansenChain(chainId);
  if (!enabled || !process.env.NANSEN_API_KEY || !mapped || !/^0x[0-9a-f]{40}$/.test(address)) return unavailable;

  let row = (await withGlobal((c) => c.query("SELECT * FROM counterparty_relations WHERE source = 'nansen' AND chain = $1 AND address = $2", [mapped.chain, address]))).rows[0] as
    | { status: string; counterparties: Counterparty[]; fetched_at: Date }
    | undefined;
  const stale = !fresh(row);
  if (stale && opts.cacheOnly) return unavailable;
  if (stale || opts.refresh) {
    try {
      const found = await fetchCounterparties(mapped.chain, address);
      row = (
        await withGlobal((c) =>
          c.query(
            `INSERT INTO counterparty_relations (source, chain, address, status, counterparties, error, fetched_at) VALUES ('nansen', $1, $2, $3, $4, NULL, now())
             ON CONFLICT (source, chain, address) DO UPDATE SET status = EXCLUDED.status, counterparties = EXCLUDED.counterparties, error = NULL, fetched_at = now() RETURNING *`,
            [mapped.chain, address, found.length ? "ok" : "none", JSON.stringify(found)]
          )
        )
      ).rows[0];
    } catch (error) {
      log().warn("counterparty_relations_failed", { chain: mapped.chain, error: (error as Error).message.slice(0, 200) });
      if (!row || row.status === "error") return unavailable;
    }
  }
  const counterparties = (row!.counterparties ?? []) as Counterparty[];
  if (!counterparties.length) return { status: "none", customers: [], lookbackDays: LOOKBACK_DAYS };
  // Match against this workspace's saved customer wallets on the same network family (testnet wallets
  // are the same addresses as on mainnet).
  const family = networks().byChainId(chainId)?.family;
  const chainIds = networks()
    .all.filter((n) => n.family === family && n.environment === environment)
    .map((n) => n.chainId);
  const saved = (
    await withTenant(organizationId, (c) =>
      c.query(
        `SELECT ca.address, ca.customer_id, cu.name FROM customer_addresses ca JOIN customers cu ON cu.id = ca.customer_id
          WHERE ca.organization_id = $1 AND ca.environment = $2 AND ca.chain_id = ANY($3::int[]) AND ca.address = ANY($4::text[])`,
        [organizationId, environment, chainIds, counterparties.map((c) => c.address)]
      )
    )
  ).rows as Array<{ address: string; customer_id: string; name: string }>;
  const byAddress = new Map(counterparties.map((c) => [c.address, c]));
  const customers = saved
    .map((s) => ({ customer_id: s.customer_id, customer_name: s.name, wallet: s.address, interactions: byAddress.get(s.address)!.interactions, volume_usd: byAddress.get(s.address)!.volume_usd }))
    .sort((a, b) => b.interactions - a.interactions)
    .filter((c, i, all) => all.findIndex((x) => x.customer_id === c.customer_id) === i)
    .slice(0, 3);
  return { status: customers.length ? "ok" : "none", customers, lookbackDays: LOOKBACK_DAYS };
}
