# Developer walkthrough (≈ 3 minutes)

> The investor/judge demo is `docs/demo.md`. This is the more technical walkthrough (API, webhooks,
> live testnet). **Only run `npm run db:reset` on a throwaway database**: it deletes everything,
> including the real Monad testnet payments recorded in `setra_dev`.

## Before you start

```bash
docker compose up -d && npm run db:reset && npm run dev   # api, worker, web
npm run webhook-receiver                                   # second terminal: prints verified webhooks
```

For the **live Monad testnet** part you need a browser wallet (e.g. MetaMask/Rabby) with a little
testnet MON for gas and testnet USDC from faucet.circle.com (Monad testnet), plus a second address you
control to receive (your "merchant" wallet).

Sign in as `owner@acme.test` / `SetraDemo!2026`. The workspace is labelled as a demo; its history is
simulated in test mode.

## 1. What Setra is (20 s): Overview

"Businesses receive stablecoins on Monad. Setra tells them what each payment means." Point at the
metrics (received, matched, needs attention, unknown), recent activity and the needs-attention queue.
The top bar shows **Live on Monad Testnet**, the worker's real cursor.

## 2. Create an invoice (25 s): Wallets → Invoices → New invoice

- Wallets → **Add wallet**: paste your merchant testnet address (USDC, Monad Testnet). Status goes
  Starting → Monitoring within seconds.
- Invoices → **New invoice**: Acme Ltd, `$2.00` (testnet amounts can be small), Monad + USDC are
  preselected, choose your new wallet. Create → open the invoice.

## 3. Customer pays on Monad (40 s): Open payment page

- **Open payment page**: merchant, invoice, amount, USDC on Monad Testnet, wallet checkout or manual
  send with QR.
- **Connect wallet → Pay 2.00 USDC**. The wallet switches to Monad Testnet and sends a real USDC
  transfer to your merchant address.
- Within about a second the page shows **Payment detected, confirming**, then **Payment received**
  with a link to the real transaction on the Monad explorer.

## 4. What Setra concluded (40 s): Invoice → Payment

- The invoice is **Paid**; the reconciliation ledger shows one automatic allocation.
- Open the payment: **Why this payment was matched**: supported network, correct receiving wallet,
  approved asset, exact amount, valid window, one deterministic candidate, rule `match-v1.0`.
- **Evidence**: block number, block hash, transaction hash, log index, `Finalized`, straight from
  Monad. **History**: observed at tip → finalized → payment detected → payment matched.

## 5. Webhook + API (20 s)

- Terminal: the receiver printed `✓ payment.matched INV-… Acme Ltd 2.00 USDC`, signature verified.
- Developers → Webhooks: delivery `200 OK · 42ms · attempt 1`; open it to see headers and payload;
  **Replay**.

## 6. When it doesn't match (35 s): Needs review

- Open **$740.00 could belong to more than one invoice**: two open $740 invoices, an unknown sender:
  Setra refuses to guess and shows both candidates with reasons. Assign it to INV-2043 with a reason;
  the decision and the original ambiguity are both kept.
- Point at **Partial payment on INV-2042** ($1,500 of $2,000, $500 remaining), **Overpayment on
  INV-2044** (+$500) and **Payment reversed** (a controlled reorg: compensating history, invoice
  reopened).
- Optional: Test payments → Unknown / Wrong token to show more outcomes live.

## 7. Reconciliation + export (15 s)

Reconciliation: expected vs received vs matched vs needs attention for the month, coverage note ("chain
data verified through …"), outstanding invoices. **Export CSV**.

## Advanced: payment intents

If `SetraPaymentIntent` is deployed on Monad testnet and configured, the hosted page's wallet checkout
uses it automatically (approve + pay). The payment detail then shows **Payment intent reference**
passed, the contract, and `PaymentIntentPaid`, with the ERC-20 transfer as supporting evidence. Without
a deployment, demonstrate it on the local devnet: `npm run local-chain`, enable `LOCAL_*` in `.env`, and
run the chain test (`npx vitest run packages/engine/test/chain.test.ts`) which pays two same-amount
invoices and shows the reference deciding.

## Developer flow

```bash
KEY=sk_test_…   # Developers → API keys
curl -s localhost:4000/v1/invoices -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-$(date +%s)" -d '{"customer_id":"cus_…","amount":"2000.00"}'
curl -s localhost:4000/v1/test/payments -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"scenario":"exact","invoice_id":"inv_…"}'
# → the receiver prints payment.matched; GET /v1/financial-events shows PAYMENT_MATCHED with evidence.
```
