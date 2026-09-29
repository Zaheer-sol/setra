import { networks } from "@setra/config";
import { withGlobal } from "@setra/database";
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
  | { status: "disabled" | "not_configured" | "unsupported_chain"; source: "nansen"; message: string }
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
const NANSEN_URL = "https://api.nansen.ai/api/v1/profiler/address/labels";

/** Nansen's chain name for a Setra chain. Testnets map to their mainnet (addresses are the same). */
export function nansenChain(chainId: number): { chain: string; testnet: boolean } | null {
  const n = networks().byChainId(chainId);
  if (!n) return null;
  if (n.family === "monad") return { chain: "monad", testnet: n.environment === "test" };
  if (n.family === "base") return { chain: "base", testnet: n.environment === "test" };
  return null;
}

/** Read labels in plain words. Deterministic, so the same labels always give the same advice. */
export function interpretLabels(labels: CounterpartyLabel[]): { kind: CounterpartyKind; summary: string; suggestion: string } {
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
    if (!res.ok) throw new Error(`Nansen responded ${res.status}`);
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
export async function counterpartyIntel(organizationId: string, chainId: number, rawAddress: string, opts: { refresh?: boolean } = {}): Promise<CounterpartyIntel> {
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
  const stale = !row || row.status === "error" || Date.now() - new Date(row.fetched_at).getTime() > TTL_MS;
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
  const reading = interpretLabels(labels);
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
