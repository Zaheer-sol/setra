# Accounting

Setra keeps a double-entry general ledger for every workspace, separately for test and live mode. Most
of it is written automatically from what Setra already knows (payments, invoices, refunds, write-offs,
outgoing transfers, network fees); the rest comes from bills, expenses, classifications, bank
statements and manual journal entries. Every report is computed from one source: posted journal lines.

## Rules the ledger enforces

| Rule | Where |
|---|---|
| Debits equal credits; at least two lines; one positive side per line | Engine, and the `guard_journal_entry` trigger in PostgreSQL |
| Posted entries never change or disappear; corrections are reversing entries | `guard_journal_entry`, `guard_journal_line` |
| Nothing is posted into a closed month (the year-end closing entry is the one exception) | Engine and trigger |
| Each automatic posting happens once per business fact | Unique `source_key` per entry |
| Accounts that automatic postings rely on can't be deleted, retyped or archived | `guard_ledger_account` |
| A workspace only sees its own books | Row-level security, as everywhere else |

Amounts are integer micro-units (6 decimals) of the reporting currency (USD). USD stablecoins are
valued at their peg, and the rate source is stored on every line (`peg:USD`). Anything else (gas paid in
MON, a euro stablecoin) needs a rate the business enters or a named published source; with none, the
posting waits as an accounting issue. Setra never invents a rate.

## How facts reach the books

| Fact | Entry |
|---|---|
| Invoice issued (accrual) | Dr Accounts Receivable, Cr the invoice's revenue account (default Sales) |
| Payment final | Dr the wallet's asset account, Cr **Payments to Identify** |
| Payment applied to an invoice | Dr Payments to Identify, Cr Accounts Receivable (cash basis: Cr revenue); any excess Cr Customer Credits |
| Unknown, duplicate or set-aside payment | Stays in Payments to Identify. Never revenue |
| Payment taken off an invoice | The application entry is reversed |
| Payment reversed by a reorg | Every entry for the payment is reversed (credit it provided is withdrawn too) |
| Stablecoin sent from a wallet | Dr **Transfers to Classify**, Cr the wallet account |
| Refund recorded | Dr Customer Credits / Payments to Identify / Refunds & Returns, Cr Transfers to Classify |
| Transfer between your own wallets | Nets to zero; shown apart in the cash flow |
| Write-off | Dr Bad Debts, Cr Accounts Receivable |
| Invoice cancelled | The issue entry (and any credit notes) are reversed |
| Credit note | Dr Refunds & Returns (or a chosen revenue account), Cr Accounts Receivable; the invoice's amount due goes down |
| Customer credit applied to another invoice | Dr Customer Credits, Cr Accounts Receivable |
| Bill approved | Dr the expense account, Cr Accounts Payable |
| Bill paid | Dr Accounts Payable, Cr Transfers to Classify (onchain) or the paying account |
| Expense approved | Dr the expense account, Cr Transfers to Classify (onchain) or the paying account |
| Classification | Moves an amount out of a holding account into the chosen account (undoable) |
| Network fee paid by a wallet | Dr Network Fees, Cr the wallet's native-token account, at a dated rate |
| Opening balances | One entry against Opening Balance Equity; replacing them reverses the old entry |
| Bank statement line with no ledger match | Dr/Cr the bank account against the account you choose |
| Year-end close | Revenue and expenses to Retained Earnings, dated 31 December; P&L excludes it |

Receipt and application are separate on purpose: the ledger always shows money that arrived but isn't
explained yet, and it can't become revenue by accident.

An automatic posting that fails (for example, a gas fee with no rate yet) never blocks the payment. It's
rolled back to a savepoint, recorded as an accounting issue, shown on the Books page, and retried by
**Repair**. A posting dated in a closed month moves to the next open date, keeping the original date.

## Accounting method

Accrual (default) or cash basis, per workspace and mode, changeable only before anything is posted.

## Reports and checks

Profit and loss, balance sheet, cash flow, trial balance, receivables and payables aging, and the
general ledger, with CSV export and drill-down from any line to its account, entry, payment and
transaction. The Books page checks the ledger against open invoices, unpaid bills, each wallet's
recorded onchain activity (plus opening balances), the holding accounts, missing entries and failed
postings. Bank and card accounts are reconciled against imported statements.

## Working with other systems

The posted journal and the chart of accounts export in QuickBooks Online and Xero import layouts (and
plain CSV). Closing entries are left out, since those systems close the year themselves. An outside
accountant can be invited with the **Accountant** role.

Every export is named for the business it belongs to, for example
`acme-infrastructure-profit-and-loss-2026-09-01-to-2026-09-30.csv` (with `-test` for test mode).
Reports (trial balance, profit and loss, balance sheet, cash flow, aging, general ledger and
reconciliation) open with a title block: the business's name, the report, its period, basis,
currency and mode, and when and by whom it was generated. They start with a UTF-8 byte order mark so
Excel shows names with accents correctly. Import files (QuickBooks, Xero) and the payments list keep
their exact column layout, so only their filename carries the business's name.

## Permissions

| Permission | Owner | Admin | Accountant | Operator | Developer | Viewer | API key (read/write) |
|---|---|---|---|---|---|---|---|
| `financials:read` | yes | yes | yes | yes | no | yes | yes |
| `financials:write` (drafts, vendors, bills, expenses, classify, statements) | yes | yes | yes | yes | no | no | yes |
| `financials:approve` (post, approve, pay, reverse, reconcile) | yes | yes | yes | no | no | no | no |
| `financials:manage` (chart, periods, year-end, method, rates, opening balances, repair) | yes | yes | yes | no | no | no | no |

## Seti

Seti answers financial questions (profit, revenue, expenses, cash, what you owe, spend by account or
vendor, what changed since last period, whether the books reconcile) by calling these same endpoints as
the signed-in user, and never estimates a number. Recording an expense or a bill, or closing a month, is
always a confirmation card.

## Known limitations

- Reporting currency is USD. Euro stablecoin support (EURC on Base) is registered but not enabled for
  invoicing; its accounting (dated rates, exchange gains and losses) isn't finished.
- Foreign-currency balances aren't revalued at period end.
- Network fees are recorded for transfers a monitored wallet sent; other native-token activity isn't
  observed, so the native-token account shows fees and whatever you record.
- Fiscal years are calendar years.
