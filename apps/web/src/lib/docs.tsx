import type { ReactNode } from "react";
import { CodeBlock } from "@/components/app-ui";

/** Developer documentation content. Examples use the real request/response shapes of the Setra API. */

export interface DocPage {
  slug: string;
  title: string;
  group: string;
  lead: string;
  body: ReactNode;
}

const Code = ({ children }: { children: string }) => <CodeBlock className="not-prose my-4" code={children.trim()} />;

export const DOCS: DocPage[] = [
  {
    slug: "quickstart",
    group: "Get started",
    title: "Quickstart",
    lead: "Create an invoice, get paid in USDC on Monad, and receive a signed payment.matched webhook, in test mode, in about ten minutes.",
    body: (
      <>
        <h2>1. Create an account and a test key</h2>
        <p>Sign up, add a receiving wallet (any address you control on Monad testnet), then open <strong>Developers → API keys</strong> and create a test key. It starts with <code>sk_test_</code> and is shown once.</p>
        <p>Test keys operate on <strong>Monad testnet (chain 10143)</strong> and can run simulated payments. Live keys (<code>sk_live_</code>) operate on <strong>Monad mainnet (chain 143)</strong>.</p>
        <h2>2. Create a customer</h2>
        <Code>{`
curl https://api.setra.dev/v1/customers \\
  -H "Authorization: Bearer $SETRA_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "name": "Acme Ltd", "email": "ap@acme.test",
        "wallet_addresses": [{ "address": "0x91c4…0a72", "network": "monad" }] }'
`}</Code>
        <p>Linking the wallet a customer pays from lets Setra attribute their payments with certainty, including partial payments.</p>
        <h2>3. Create an invoice</h2>
        <Code>{`
curl https://api.setra.dev/v1/invoices \\
  -H "Authorization: Bearer $SETRA_KEY" \\
  -H "Idempotency-Key: order-8812" \\
  -H "Content-Type: application/json" \\
  -d '{ "customer_id": "cus_01J9…", "number": "INV-2041",
        "title": "September Infrastructure Services",
        "amount": "2000.00", "asset": "USDC", "network": "monad" }'
`}</Code>
        <Code>{`
{
  "id": "inv_01J9Z3…",
  "object": "invoice",
  "number": "INV-2041",
  "status": "open",
  "amount_due": "2000.00",
  "amount_remaining": "2000.00",
  "asset": { "symbol": "USDC", "decimals": 6, "address": "0x534b2f3a21130d7a60830c2df862319e593943a3" },
  "network": "monad",
  "chain_id": 10143,
  "payment_url": "https://app.setra.dev/pay/9c2V…",
  "livemode": false
}
`}</Code>
        <h2>4. Add a webhook endpoint</h2>
        <p>In <strong>Developers → Webhooks</strong>, add your HTTPS endpoint and copy the signing secret (<code>whsec_…</code>). Or use the API: <code>POST /v1/webhook-endpoints</code>.</p>
        <h2>5. Pay it</h2>
        <p>Open <code>payment_url</code> and pay with testnet USDC from any wallet (Circle&rsquo;s faucet at faucet.circle.com), or run a simulation through the same pipeline:</p>
        <Code>{`
curl https://api.setra.dev/v1/test/payments \\
  -H "Authorization: Bearer $SETRA_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "scenario": "exact", "invoice_id": "inv_01J9Z3…" }'
`}</Code>
        <p>Your endpoint receives <code>payment.matched</code>. Verify it (see <a href="/docs/webhooks">Webhooks</a>) and fulfil the order.</p>
      </>
    )
  },
  {
    slug: "authentication",
    group: "Get started",
    title: "Authentication",
    lead: "Authenticate server-side requests with a secret API key in the Authorization header.",
    body: (
      <>
        <Code>{`Authorization: Bearer sk_test_4f…`}</Code>
        <ul>
          <li><strong>Test keys</strong> (<code>sk_test_</code>) see only test-mode data on Monad testnet.</li>
          <li><strong>Live keys</strong> (<code>sk_live_</code>) see only live data on Monad mainnet. Only owners and admins can create them.</li>
          <li><strong>Read-only</strong> keys can call every <code>GET</code> endpoint and nothing else.</li>
          <li>Keys can&rsquo;t manage other keys, members or workspace settings, those require the console.</li>
        </ul>
        <p>Keys are 256-bit random secrets. Setra stores only a SHA-256 hash and shows the key once. Revocation is immediate. Never ship a key in browser or mobile code.</p>
        <h2>Rate limits</h2>
        <p>Default: 300 requests per minute per key. Exceeding it returns <code>429</code> with <code>rate_limited</code>. Back off and retry.</p>
        <h2>Request IDs</h2>
        <p>Every response carries <code>X-Request-Id</code> (e.g. <code>req_01J9…</code>), also included in error bodies. Include it when contacting support.</p>
      </>
    )
  },
  {
    slug: "invoices",
    group: "Core concepts",
    title: "Invoices",
    lead: "An invoice is a request for a specific amount, in a specific stablecoin, on a specific network, to a specific wallet you control.",
    body: (
      <>
        <h2>Create</h2>
        <table>
          <thead><tr><th>Field</th><th>Description</th></tr></thead>
          <tbody>
            <tr><td><code>customer_id</code></td><td>Required. The customer who owes the money.</td></tr>
            <tr><td><code>title</code></td><td>Required. What the payment is for, e.g. <code>&quot;September Infrastructure Services&quot;</code>. Shown to the payer and carried onto every payment, webhook and export.</td></tr>
            <tr><td><code>purpose</code></td><td>Optional detail, e.g. <code>&quot;Cloud architecture, deployment and monitoring&quot;</code>. Shown under the title.</td></tr>
            <tr><td><code>line_items</code></td><td>Optional. <code>[{"{ description, quantity, unit_amount }"}]</code>, integer quantities, decimal-string prices. Must add up to <code>amount</code>; if <code>amount</code> is omitted it is their total. Stored exactly, never changed.</td></tr>
            <tr><td><code>amount</code></td><td>Decimal string, e.g. <code>&quot;2000.00&quot;</code>. Never a JSON number. Required unless <code>line_items</code> are given.</td></tr>
            <tr><td><code>currency</code></td><td><code>USD</code>. Settled 1:1 in a USD stablecoin.</td></tr>
            <tr><td><code>asset</code></td><td>Default <code>USDC</code>.</td></tr>
            <tr><td><code>network</code></td><td>Default <code>monad</code>. Resolves to Monad testnet for test keys and Monad mainnet for live keys.</td></tr>
            <tr><td><code>wallet_id</code></td><td>Optional. Defaults to your first wallet that accepts the asset on that network.</td></tr>
            <tr><td><code>number</code></td><td>Optional. Your reference, unique per workspace. Auto-numbered if omitted.</td></tr>
            <tr><td><code>due_at</code>, <code>expires_at</code></td><td>Optional ISO timestamps. Payments after expiry are flagged as late, not auto-applied.</td></tr>
            <tr><td><code>metadata</code></td><td>Optional. Stored for you, never shown to the payer.</td></tr>
          </tbody>
        </table>
        <h2>Send to the customer</h2>
        <p><code>POST /v1/invoices/:id/send</code> emails the payment request (what it is for, the items, the amount due and the payment link) to the customer&rsquo;s email or to <code>to</code>, with an optional <code>message</code>. The invoice records <code>last_sent_at</code> and <code>last_sent_to</code>. Requires <code>SMTP_URL</code> in production.</p>
        <h2>Statuses</h2>
        <table>
          <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td><code>open</code></td><td>Awaiting payment. <code>amount_confirming</code> is non-zero while a payment is detected but not yet final.</td></tr>
            <tr><td><code>partially_paid</code></td><td>Some money applied; <code>amount_remaining</code> is still due.</td></tr>
            <tr><td><code>paid</code></td><td>Fully paid (or remainder written off).</td></tr>
            <tr><td><code>overpaid</code></td><td>More than the amount due was received. See <code>amount_overpaid</code>.</td></tr>
            <tr><td><code>expired</code></td><td>Expired with nothing paid.</td></tr>
            <tr><td><code>cancelled</code></td><td>Cancelled by you. Only unpaid invoices can be cancelled.</td></tr>
          </tbody>
        </table>
        <p>Balances are computed from an append-only allocation ledger. A reversed payment creates a compensating allocation; nothing is overwritten.</p>
      </>
    )
  },
  {
    slug: "payments",
    group: "Core concepts",
    title: "Payments and matching",
    lead: "A payment is money that actually arrived at one of your wallets. Setra decides which invoice it belongs to with a deterministic, explainable engine.",
    body: (
      <>
        <h2>Lifecycle</h2>
        <table>
          <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td><code>confirming</code></td><td>Observed at the Monad chain tip. No economic effect yet.</td></tr>
            <tr><td><code>matched</code></td><td>Final, applied, and the invoice is now paid.</td></tr>
            <tr><td><code>partial</code></td><td>Final, applied, invoice still has a balance.</td></tr>
            <tr><td><code>overpaid</code></td><td>Final, applied, more than was due.</td></tr>
            <tr><td><code>needs_review</code></td><td>Final, but Setra could not safely decide. An exception explains why.</td></tr>
            <tr><td><code>reversed</code></td><td>The source is no longer canonical. Any effect was compensated.</td></tr>
            <tr><td><code>dismissed</code></td><td>An operator recorded it as not a customer payment.</td></tr>
          </tbody>
        </table>
        <h2>Finality on Monad</h2>
        <p>Setra scans two ranges: the chain tip (<code>latest</code>, Monad&rsquo;s <em>proposed</em> state) for instant detection, and the settled range (Monad&rsquo;s <code>finalized</code> tag, minus a small safety margin for load-balanced RPC nodes) for economic effects. A tip observation that never appears in the settled range is dropped with history.</p>
        <h2>Matching rules (match-v1.1)</h2>
        <ol>
          <li>The token must be an approved asset for the receiving wallet. Otherwise: <code>wrong_token</code>.</li>
          <li>A verified payment-intent reference identifies an invoice when its asset, network, receiving wallet and payment window still match. Expired or cancelled invoices go to review.</li>
          <li>A known customer wallet narrows candidates to that customer&rsquo;s open invoices. One open invoice, or one uniquely identified by the exact amount, is a match. Identical invoice balances need review unless an onchain payment intent identifies one.</li>
          <li>For unknown senders, only an exact remaining amount that identifies exactly one open invoice is a match.</li>
          <li>Anything else becomes an exception with candidates: <code>unknown_payment</code>, <code>ambiguous_match</code>, <code>late_payment</code>, <code>duplicate_payment</code> or <code>wrong_network</code>.</li>
        </ol>
        <p>Every payment exposes <code>decision.checks</code>, the list shown in the console as &ldquo;Why this payment was matched&rdquo;.</p>
        <h2>What a payment is for</h2>
        <p>Every payment carries <code>business_object</code> (<code>{"{ type: \"invoice\", id, number, title, purpose }"}</code>), <code>purpose_status</code> and <code>context_source</code>:</p>
        <table>
          <thead><tr><th><code>purpose_status</code></th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td><code>known</code></td><td>Applied to an invoice. <code>context_source</code> says how: <code>automatic_match</code>, <code>payment_intent</code> or <code>manual_resolution</code>.</td></tr>
            <tr><td><code>provisional</code></td><td>Still confirming; the invoice it matches is shown, nothing is applied yet.</td></tr>
            <tr><td><code>unknown</code></td><td>No invoice identified. <code>business_object</code> is <code>null</code>; Setra never guesses a purpose.</td></tr>
          </tbody>
        </table>
        <p>The payment detail adds <code>context_history</code>: every decision and resolution in order, so a payment that was unknown and later assigned shows both steps. Search (<code>?search=</code>) matches titles and purposes as well as customers, invoice numbers, payment ids and transaction hashes.</p>
        <h2>Corrections</h2>
        <p><code>POST /v1/payments/:id/corrections</code> with <code>{"{ action: \"reassign\", invoice_id, reason }"}</code> moves an applied payment to another invoice; <code>{"{ action: \"unassign\", reason }"}</code> takes it back to review. The original application stays in the history, a compensating allocation reverses it, the old invoice is reopened if needed, and <code>payment.unassigned</code> is sent (followed by the new settlement event for a move). Payments identified by an onchain payment-intent reference can&rsquo;t be moved.</p>
        <h2>Refunds</h2>
        <p>Setra records stablecoin sent <em>from</em> your monitored wallets (finalized blocks only). To record that a payment was sent back, <code>GET /v1/payments/:id/refund-candidates</code> lists those transfers, and <code>POST /v1/payments/:id/refunds</code> with <code>{"{ outgoing_transfer_id, reason }"}</code> links one. It must come from the receiving wallet, in the same token, after the payment, and be no larger than what is refundable (the whole payment if unapplied, the excess if overpaid). A fully refunded payment becomes <code>refunded</code>; exceptions can also be resolved with <code>action: &quot;refund&quot;</code>. Each refund emits <code>payment.refunded</code> with the transaction.</p>
        <h2>Detection</h2>
        <p>Setra reads Monad over RPC (tip and finalized) and, when a node-side sidecar is attached, from Monad&rsquo;s execution events. Either way the first sighting is provisional and money only moves on finalized canonical data. The payment detail&rsquo;s <code>detection</code> object reports the source and measured timings.</p>
        <h2>Exceptions</h2>
        <p><code>GET /v1/exceptions?status=open</code> is the review queue. Resolve with <code>POST /v1/exceptions/:id/resolve</code> and one of <code>assign</code>, <code>dismiss</code>, <code>acknowledge</code> or <code>write_off</code> plus a <code>reason</code>. Resolutions are permanent and audited.</p>
      </>
    )
  },
  {
    slug: "financial-events",
    group: "Core concepts",
    title: "Financial events",
    lead: "Financial events are Setra's conclusions: append-only, versioned, and each linked to its onchain evidence and the rule that produced it.",
    body: (
      <>
        <table>
          <thead><tr><th>Type</th><th>Webhook topic</th><th>When</th></tr></thead>
          <tbody>
            <tr><td><code>PAYMENT_OBSERVED</code></td><td><code>payment.observed</code></td><td>Seen at the chain tip (pending).</td></tr>
            <tr><td><code>PAYMENT_MATCHED</code></td><td><code>payment.matched</code></td><td>Final and settles the invoice exactly.</td></tr>
            <tr><td><code>PARTIALLY_PAID</code></td><td><code>payment.partially_paid</code></td><td>Final, applied, balance remains.</td></tr>
            <tr><td><code>OVERPAID</code></td><td><code>payment.overpaid</code></td><td>Final, applied, more than due.</td></tr>
            <tr><td><code>UNKNOWN_PAYMENT</code></td><td><code>payment.unknown</code></td><td>Final, needs review. <code>reason</code> gives the exception type.</td></tr>
            <tr><td><code>PAYMENT_REVERSED</code></td><td><code>payment.reversed</code></td><td>Source no longer canonical. <code>reverses_event_id</code> points to the original.</td></tr>
            <tr><td><code>PAYMENT_DISMISSED</code></td><td><code>payment.dismissed</code></td><td>Recorded as not a customer payment.</td></tr>
          </tbody>
        </table>
        <h2>Shape</h2>
        <Code>{`
{
  "id": "fevt_01J9Z4…",
  "object": "financial_event",
  "type": "PAYMENT_MATCHED",
  "event_version": 1,
  "schema_version": "1.0",
  "status": "confirmed",
  "customer": { "id": "cus_01J9…", "name": "Acme Ltd" },
  "invoice": { "id": "inv_01J9…", "number": "INV-2041", "status": "paid",
               "title": "September Infrastructure Services",
               "purpose": "Cloud architecture, deployment and monitoring",
               "amount_due": "2000.00", "amount_paid": "2000.00", "amount_remaining": "0.00" },
  "purpose_status": "known",
  "context_source": "automatic_match",
  "payment": { "id": "pay_01J9…", "amount": "2000.00", "asset": "USDC", "network": "monad",
               "chain_id": 143, "sender": "0x91c4…", "recipient": "0x5e7a…",
               "transaction_hash": "0xabc…", "explorer_url": "https://monadscan.com/tx/0xabc…" },
  "evidence": { "observation_id": "obs_01J9…", "source_type": "erc20_transfer",
                "block_number": "108488412", "block_hash": "0x…", "log_index": 14,
                "confirmation_state": "finalized", "rule_version": "match-v1.1" },
  "decision": { "outcome": "matched", "rule_version": "match-v1.1", "checks": [ … ] },
  "reverses_event_id": null
}
`}</Code>
        <p>Schemas are versioned. Additive fields may appear at any time; breaking changes increment <code>event_version</code>.</p>
      </>
    )
  },
  {
    slug: "webhooks",
    group: "Integrate",
    title: "Webhooks",
    lead: "Setra POSTs signed events to your endpoints, retries failures with backoff, keeps every attempt, and lets you replay any delivery.",
    body: (
      <>
        <h2>Headers</h2>
        <table>
          <tbody>
            <tr><td><code>X-Setra-Event-Id</code></td><td>The financial event id. Use it to deduplicate.</td></tr>
            <tr><td><code>X-Setra-Event-Type</code></td><td>e.g. <code>payment.matched</code></td></tr>
            <tr><td><code>X-Setra-Delivery-Id</code></td><td>Unique per delivery attempt series (replays get a new one).</td></tr>
            <tr><td><code>X-Setra-Timestamp</code></td><td>Unix seconds when signed.</td></tr>
            <tr><td><code>X-Setra-Signature</code></td><td><code>v1=&lt;hex&gt;</code>, HMAC-SHA256 of <code>timestamp + &quot;.&quot; + raw body</code>. During secret rotation two <code>v1=</code> values are present.</td></tr>
          </tbody>
        </table>
        <h2>Verify</h2>
        <Code>{`
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySetraWebhook(secret, rawBody, timestamp, header, toleranceSeconds = 300) {
  if (!timestamp || !header) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(\`\${timestamp}.\${rawBody}\`).digest();
  return header.split(",").some((part) => {
    const sig = Buffer.from(part.trim().replace(/^v1=/, ""), "hex");
    return sig.length === expected.length && timingSafeEqual(sig, expected);
  });
}
`}</Code>
        <p>Always verify against the <strong>raw</strong> request body, before parsing JSON. The same function ships in <code>@setra/sdk</code>.</p>
        <h2>Retries</h2>
        <p>Any non-2xx response or timeout (10s) is retried with exponential backoff and jitter, roughly 30s, 1m, 2m, 4m … capped at 6 hours, up to 10 attempts. Return <code>410 Gone</code> to stop retries. A delivery is marked <em>delivered</em> only after an actual 2xx response.</p>
        <h2>Idempotency on your side</h2>
        <p>Deliveries are at-least-once. Deduplicate on <code>X-Setra-Event-Id</code>. Setra never creates two economic effects from one onchain fact, so the same event id always means the same thing.</p>
        <h2>Replay and rotation</h2>
        <p><code>POST /v1/webhook-deliveries/:id/replay</code> sends the identical payload as a new delivery. <code>POST /v1/webhook-endpoints/:id/rotate-secret</code> returns a new secret; the previous one keeps signing for 24 hours.</p>
      </>
    )
  },
  {
    slug: "payment-intents",
    group: "Integrate",
    title: "Payment intents",
    lead: "An optional Monad contract that puts a machine-readable reference inside the payment transaction, so matching never depends on amounts.",
    body: (
      <>
        <p>Direct transfers are first-class and need no contract. Payment intents add certainty when several invoices share an amount, and are used automatically by the hosted payment page when the contract is configured for the network.</p>
        <h2>How it works</h2>
        <ol>
          <li><code>POST /v1/payment-intents {"{ invoice_id }"}</code> returns the terms: merchant wallet, token, exact amount, expiry and an opaque reference.</li>
          <li>The intent id is <code>keccak256(chainId, contract, merchant, token, amount, expiresAt, ref)</code>, computed offchain; no transaction is needed to create it.</li>
          <li>The customer approves the token and calls <code>pay(terms)</code>. Tokens move directly from payer to your wallet in the same call.</li>
          <li>The contract emits <code>PaymentIntentPaid(intentId, merchant, payer, token, amount, ref)</code>. Setra observes it, verifies the terms, and matches the invoice by reference.</li>
        </ol>
        <h2>Guarantees</h2>
        <ul>
          <li>Non-custodial: the contract never holds a balance. No owner, no admin, no upgrades, no fees.</li>
          <li>Each intent can be paid once, only before expiry, and only exactly as stated, changing any term changes the id.</li>
          <li>Ids are domain-separated by chain and deployment, so they can&rsquo;t be replayed elsewhere.</li>
          <li>Fee-on-transfer or otherwise inexact tokens are rejected, so the event always equals what arrived.</li>
          <li>Merchants can <code>cancel</code> an open intent and <code>refund</code> a paid one to the original payer.</li>
        </ul>
        <div className="not-prose my-4 rounded-2xl bg-primary/10 px-4 py-3 text-foreground/80">The contract has fuzz and invariant tests but has not been audited by a third party.</div>
      </>
    )
  },
  {
    slug: "test-mode",
    group: "Integrate",
    title: "Test mode",
    lead: "Test mode runs on Monad testnet and can simulate every payment outcome through the real pipeline.",
    body: (
      <>
        <p>Everything in test mode is isolated from live data: customers, invoices, wallets, payments, events, webhook endpoints and API keys.</p>
        <h2>Real testnet payments</h2>
        <p>Add a Monad testnet wallet and pay invoices with Circle&rsquo;s testnet USDC (<code>0x534b…43A3</code>). The worker ingests Monad testnet exactly as it ingests mainnet.</p>
        <h2>Simulations</h2>
        <Code>{`POST /v1/test/payments  { "scenario": "partial", "invoice_id": "inv_…", "amount": "1500.00" }`}</Code>
        <table>
          <thead><tr><th>Scenario</th><th>Result</th></tr></thead>
          <tbody>
            <tr><td><code>exact</code></td><td>PAYMENT_MATCHED, invoice paid</td></tr>
            <tr><td><code>partial</code></td><td>PARTIALLY_PAID from the customer&rsquo;s known wallet (otherwise needs review)</td></tr>
            <tr><td><code>overpaid</code></td><td>OVERPAID with an overpayment exception</td></tr>
            <tr><td><code>duplicate</code></td><td>Possible duplicate on an already-paid invoice</td></tr>
            <tr><td><code>unknown</code></td><td>UNKNOWN_PAYMENT with candidates</td></tr>
            <tr><td><code>wrong_token</code></td><td>Recorded and flagged; never settles an invoice</td></tr>
          </tbody>
        </table>
        <p><code>POST /v1/test/payments/:id/reorg</code> invalidates a simulated payment&rsquo;s block and exercises the compensation path (<code>payment.reversed</code>). Simulated payments are labelled <code>simulated: true</code> everywhere.</p>
      </>
    )
  },
  {
    slug: "errors",
    group: "Reference",
    title: "Errors and idempotency",
    lead: "Errors share one envelope. Creates accept an Idempotency-Key so retries are always safe.",
    body: (
      <>
        <Code>{`
{
  "error": {
    "code": "wallet_required",
    "message": "Add a Monad Testnet receiving wallet that accepts USDC first.",
    "request_id": "req_01J9Z6…"
  }
}
`}</Code>
        <table>
          <thead><tr><th>Status</th><th>Typical codes</th></tr></thead>
          <tbody>
            <tr><td>400</td><td><code>invalid_request</code>, <code>invalid_idempotency_key</code></td></tr>
            <tr><td>401</td><td><code>unauthenticated</code>, <code>invalid_api_key</code></td></tr>
            <tr><td>403</td><td><code>forbidden</code>, <code>test_mode_only</code>, <code>csrf_rejected</code></td></tr>
            <tr><td>404</td><td><code>not_found</code> (also returned for other workspaces&rsquo; objects)</td></tr>
            <tr><td>409</td><td><code>invoice_number_taken</code>, <code>exception_already_resolved</code>, <code>idempotency_in_progress</code></td></tr>
            <tr><td>422</td><td><code>validation_error</code> (with <code>details</code>), <code>invalid_amount</code>, <code>resolution_not_allowed</code>, <code>idempotency_key_reused</code></td></tr>
            <tr><td>429</td><td><code>rate_limited</code></td></tr>
            <tr><td>500</td><td><code>internal_error</code>, safe to retry with the same Idempotency-Key</td></tr>
          </tbody>
        </table>
        <h2>Idempotency</h2>
        <p>Send <code>Idempotency-Key: &lt;unique string&gt;</code> on <code>POST</code> requests that create objects. The same key and body within 24 hours returns the original response with <code>Idempotent-Replayed: true</code>. The same key with a different body is rejected with <code>422</code>.</p>
        <h2>Pagination</h2>
        <p>Lists return <code>{"{ object: \"list\", data, has_more, next_cursor }"}</code>. Pass <code>next_cursor</code> as <code>starting_after</code>. <code>limit</code> is 1–100 (default 25).</p>
      </>
    )
  },
  {
    slug: "api-reference",
    group: "Reference",
    title: "API reference",
    lead: "All endpoints are versioned under /v1. The complete OpenAPI 3.1 document is served at /openapi.json with an interactive explorer at /docs on the API host.",
    body: (
      <>
        {[
          ["Invoices", [["POST", "/v1/invoices"], ["GET", "/v1/invoices"], ["GET", "/v1/invoices/:id"], ["POST", "/v1/invoices/:id/cancel"]]],
          ["Payments", [["GET", "/v1/payments"], ["GET", "/v1/payments/:id"]]],
          ["Exceptions", [["GET", "/v1/exceptions"], ["GET", "/v1/exceptions/:id"], ["POST", "/v1/exceptions/:id/resolve"]]],
          ["Customers", [["POST", "/v1/customers"], ["GET", "/v1/customers"], ["GET", "/v1/customers/:id"], ["PATCH", "/v1/customers/:id"], ["POST", "/v1/customers/:id/wallet-addresses"]]],
          ["Wallets", [["POST", "/v1/wallets"], ["GET", "/v1/wallets"], ["GET", "/v1/wallets/:id"], ["PATCH", "/v1/wallets/:id"], ["DELETE", "/v1/wallets/:id"]]],
          ["Reporting", [["GET", "/v1/reconciliation"], ["GET", "/v1/overview"], ["GET", "/v1/exports/payments.csv"], ["GET", "/v1/exports/reconciliation.csv"]]],
          ["Financial events", [["GET", "/v1/financial-events"], ["GET", "/v1/financial-events/:id"]]],
          ["Webhooks", [["POST", "/v1/webhook-endpoints"], ["GET", "/v1/webhook-endpoints"], ["PATCH", "/v1/webhook-endpoints/:id"], ["DELETE", "/v1/webhook-endpoints/:id"], ["POST", "/v1/webhook-endpoints/:id/rotate-secret"], ["POST", "/v1/webhook-endpoints/:id/test"], ["GET", "/v1/webhook-deliveries"], ["GET", "/v1/webhook-deliveries/:id"], ["POST", "/v1/webhook-deliveries/:id/replay"]]],
          ["Payment intents", [["POST", "/v1/payment-intents"], ["GET", "/v1/payment-intents"], ["GET", "/v1/payment-intents/:id"]]],
          ["Test mode", [["POST", "/v1/test/payments"], ["POST", "/v1/test/payments/:id/confirm"], ["POST", "/v1/test/payments/:id/reorg"]]],
          ["System", [["GET", "/v1/health"]]]
        ].map(([group, rows]) => (
          <div key={group as string}>
            <h2>{group as string}</h2>
            <table>
              <tbody>
                {(rows as string[][]).map(([m, p]) => (
                  <tr key={`${m}${p}`}>
                    <td className="font-mono text-[13px]"><span className="inline-block min-w-[52px] font-semibold text-primary">{m}</span>{p}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </>
    )
  },
  {
    slug: "changelog",
    group: "Reference",
    title: "Changelog",
    lead: "Changes to the API and event schemas.",
    body: (
      <>
        <h2>2026-10-01</h2>
        <ul>
          <li>Initial API version: invoices, payments, exceptions, reconciliation, financial events (schema 1.0), webhooks and payment intents.</li>
          <li>Matching rules <code>match-v1.1</code>.</li>
          <li>Monad mainnet (live) and Monad testnet (test) supported; Base available as a secondary network.</li>
        </ul>
      </>
    )
  }
];

export const DOC_GROUPS = [...new Set(DOCS.map((d) => d.group))];
