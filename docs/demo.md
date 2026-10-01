# Setra demo: 3 minutes

**One sentence:** Businesses get paid in stablecoins on Monad, and their books are done the moment the
payment is final. No wallet spreadsheets, no guessing, no crypto knowledge needed.

Everything below runs in the demo workspace (`owner@acme.test`, test mode, Monad testnet). Payments
labelled "Simulated" went through the same pipeline as chain payments; say so if asked.

## Before you start (10 minutes ahead)

- [ ] `npm run dev` is running and http://localhost:3000 loads. Sign in as `owner@acme.test`.
- [ ] Test mode is on (orange bar). The header wallet pill is green ("Monitoring").
- [ ] A wallet with testnet USDC and a little MON is open in the browser (for the live payment), and
      the hosted payment page loads for a fresh invoice.
- [ ] Tabs open, left to right: Overview · the new invoice · Books · Reports › Profit and loss · Seti.
- [ ] Browser zoom 110–125% so numbers read on a projector; notifications off.
- [ ] Backup: the pre-recorded run (see bottom) is on the desktop.

## The run

| Time | Say | Do |
|---|---|---|
| 0:00 | "Stablecoins are becoming how businesses get paid. Today, their accountant reconciles wallet addresses in a spreadsheet at month end." | Overview page. |
| 0:15 | "Setra is where a business gets paid in stablecoins and its books keep themselves." | Open **Seti**, type: *Create a $250 USDC payment request for Acme Ltd for website development, due Friday*. Confirm the card. |
| 0:40 | "The customer doesn't need to know anything about crypto: they get a payment page." | Open the payment link. Pay 250 USDC from the wallet. |
| 1:00 | "Monad finalizes in about a second. Setra saw it at the tip, waited for finality, and matched it to the invoice with a reason for every check." | Back on the invoice: **Payment detected → Paid**. Open the payment: the checks, the transaction hash, "View on explorer". |
| 1:25 | "And the books are already done: receipt and application, double entry, traceable to that transaction." | Click **In the books** → the journal entry → the transaction link. |
| 1:45 | "Money nobody can explain never becomes revenue. It waits here for a decision." | **Books › Waiting for a decision**: the $740 from an unknown sender. |
| 2:05 | "Owners don't read ledgers. They ask." | **Seti**: *Why is profit different from last month?* It names revenue, contractors and rent, from the ledger. Then *What do we owe vendors?* (the overdue hosting bill). |
| 2:30 | "Their accountant keeps QuickBooks or Xero: one click exports the journal in their import format." | **Books › Export for your accountant** → QuickBooks → Journal entries. |
| 2:45 | "Setra: get paid in stablecoins, and your books are already done. Built on Monad because per-payment finality is what makes real-time books possible." | Books page: **Everything reconciles**. |

## If something goes wrong

| Problem | Do this |
|---|---|
| The live payment is slow or the wallet misbehaves | On the invoice, **Simulate payment → Exact**. Same pipeline; it's labelled "Simulated". |
| The API or web app doesn't respond | Switch to the recording. Afterwards: `curl localhost:4000/v1/health`. |
| Seti misunderstands | Use the suggestion chips in Seti's panel (they're the same questions). |
| A number is questioned | Open it: every figure opens its account, entry and transaction. |

## Questions to be ready for

- **Why not Stripe, QuickBooks or Request Finance?** Stripe moves money; QuickBooks and Xero record
  what you type; Request Finance does invoicing and payouts. Setra is the only one that turns each
  verified onchain payment into correct double-entry books automatically, never guesses a match, and
  keeps a trail from every number back to the chain. It works alongside QuickBooks and Xero via export.
- **Why Monad?** Books can only be real-time if settlement is final per payment. Monad's finality lets
  Setra book each payment within seconds; the execution-events path (built on Monad's SDK) detects
  payments before they're final and shows them as provisional.
- **Is it custodial?** No. Setra only needs public addresses. Funds never pass through it.
- **What about unknown or wrong payments?** Partial, overpaid, duplicate, late, wrong-token and unknown
  payments go to review with evidence; the ledger holds unidentified money separately until someone decides.
- **What's live?** Real Monad testnet payments (see `docs/status.md`). Mainnet ingestion was verified
  read-only; the payment-intent contract is tested (32 tests) and deployed on testnet only.
- **Business model?** A subscription per workspace, see the pricing page.

## Recording the backup

Record the run above once it's rehearsed (screen at 1440×900, 110% zoom, cursor highlight on). Keep it
under 3 minutes; it doubles as the submission's demo video.
