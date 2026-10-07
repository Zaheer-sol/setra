# Nansen in Setra

Setra's hardest case is money nobody can identify: a payment arrives on Monad from a wallet that isn't
saved to any customer. Setra won't guess, so the payment waits for a person. Nansen helps that person
decide. Setra asks Nansen who is behind the wallet and turns the answer into accounting advice.

Nansen never decides anything. Matching stays rule-based, and nothing is assigned, saved or classified
from a label. A person reads the suggestion and makes the call, with a reason on record.

## Four places it shows up

| Where | What the person sees | Nansen data |
|---|---|---|
| **An unknown payment** (Payments, Needs review) | "Labelled as an exchange wallet. A customer probably paid from their exchange account, so the address won't match a wallet on file. Look for an open invoice with this amount around this date. Don't save this address to a customer." | Address labels |
| **The likely customer behind it** (same panel) | "This wallet has transacted with Acme Ltd's saved wallet 3 times in the last year." Only this workspace's own customers are ever named. | Address counterparties |
| **Saving an address** (customers and vendors) | A warning before an exchange, bridge or app address is saved to one customer, which would make strangers' future payments match that customer. "Remember this sender" isn't pre-ticked for those. | Address labels |
| **Money going out** (Classify) | Who received a transfer waiting to be classified, with advice: "Sent to an exchange wallet. If the account is yours, classify it as a transfer between your own accounts, not spending." | Address labels |

Seti uses the same lookup, so "who sent the $740?" gets the label, the likely customer and a suggested
next step in one answer.

## How it works

- `packages/engine/src/intel/counterparty.ts`: calls Nansen's
  [address labels](https://docs.nansen.ai/api/profiler/address-labels) and
  [address counterparties](https://docs.nansen.ai/api/profiler/address-counterparties) endpoints on
  chain `monad`, reads the labels into a kind (exchange, bridge, fund, contract, protocol, wallet), and
  writes the advice. The advice is deterministic, so the same labels always give the same words.
- `apps/api/src/routes/accounting/counterparty.ts`: the API routes for a payment, an outgoing transfer
  and an address.
- `apps/web/src/components/counterparty.tsx`: the "Who sent this?" panel and the address check.
- `apps/api/src/assistant/orchestrator.ts` (`whoSent`): Seti's answer.
- `apps/api/test/counterparty.test.ts`: tests against a fake Nansen, including isolation between
  workspaces and credit use.
- Migrations `0010_counterparty_intel.sql` and `0014_counterparty_relations.sql`: the switch and the caches.

Test-mode payments run on Monad testnet. Addresses are the same on mainnet, so Setra shows the address's
Monad mainnet labels and says so.

## Privacy and cost

- **Off by default.** Each workspace turns it on in Settings, because the sender's address is sent to Nansen.
- **Cached for a week** per address, shared across workspaces (labels are public data). Counterparty
  matches against saved customers happen inside the workspace, under its row-level security.
- **Credits are spent only when a person asks.** "Who sent this?" runs on a click, and the address check
  runs when someone enters a full address to save. Background checks on page loads only read earlier
  answers. A failed lookup (no key, no credits, rate limit) is explained in
  plain words and not retried for 15 minutes.

## Turning it on

1. Set `NANSEN_API_KEY` on the API service.
2. In Setra, Settings → Counterparty lookups → on.
3. Open an unknown payment and choose **Who sent this?**.
