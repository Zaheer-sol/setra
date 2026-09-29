# Accountant review checklist

For an accountant or bookkeeper to review Setra's books in about 30 minutes. Their verdict, even a
partial one, is strong evidence for judges and tells us what to fix. Please answer each item with
**Yes / No / Unsure** and a note.

Sign in to the demo workspace (test mode) or a pilot workspace, then open **Books**.

## The ledger

1. The chart of accounts (Books › Chart of accounts) is a sensible starting point for a small service business.
2. Every entry balances, and posted entries can't be edited (try: open any entry in the Journal).
3. Corrections are made by reversing entries, and the original stays on record.
4. Months can be closed; nothing can be posted into a closed month without reopening it with a reason.
5. The year-end close moves the year's result into Retained Earnings, and the year's P&L still reads normally.

## How payments are recorded

6. A stablecoin payment is first recorded as received into **Payments to Identify**, then applied to
   the invoice (reducing Accounts Receivable). Is that treatment acceptable?
7. Money nobody can explain stays in **Payments to Identify** and is never counted as revenue.
8. Overpayments sit in **Customer Credits** until refunded or applied to another invoice.
9. Stablecoins are valued 1:1 at their USD peg; a rate is recorded on every line. Is that acceptable for
   USDC and USDT0?
10. Stablecoin sent out waits in **Transfers to Classify** until it's recorded as a bill payment,
    expense, refund or owner draw.

## Tie-outs

11. Receivables aging equals the Accounts Receivable balance (Reports › Receivables aging).
12. Payables aging equals the Accounts Payable balance (Reports › Payables aging).
13. The balance sheet balances, and the cash flow statement reconciles to the change in cash.
14. The Books health check ("Do the books agree?") matches what you'd check by hand.

## Working with your tools

15. The QuickBooks Online (or Xero) journal export imports cleanly into your system
    (Books › Export for your accountant). Note any fields you had to map.
16. Bank reconciliation (Books › Bank reconciliation) works the way you'd expect with a real statement CSV.

## Overall

17. Would you accept these books from a client? If not, what would need to change?
18. May we quote your verdict (name/firm or anonymous) in our submission?

Posting rules are documented in `docs/accounting.md` (or `packages/engine/src/accounting/posting-rules.ts`).
