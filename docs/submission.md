# Metropolis submission: copy for each field

Everything except the two video links. Items in [brackets] need your input before you paste.

---

## 1. Project info

### Project logo
`docs/brand/png/setra-logo-square-1024-white.png` (square, 1024 px). If the form wants the mark with no padding, use `setra-mark-1024.png` (transparent). For banners or a wide header, `setra-logo-horizontal-light.png` (or `-dark` on dark backgrounds).

### Project name
Setra

### One-line description
Pick one. Both are under 100 characters.

> Get paid in stablecoins. Your books are already done.

> Stablecoin payments on Monad, matched to the right invoice and booked in about two seconds.

### Full description

> When a customer pays a business in stablecoins (digital dollars on a blockchain, one coin for one dollar), the money arrives in seconds. What the business sees is an amount and a wallet address. Someone still has to work out who paid, which invoice it was for, and how to record it in the books. Today that usually happens in a spreadsheet.
>
> Setra does that work for businesses paid in USDC on Monad. It has three parts.
>
> **A payment processor.** Setra takes payments and tells the business they arrived. Customers pay the business's own wallet, from a Setra payment page or straight from their wallet, and Setra never holds the money. Orders can come in by themselves from Shopify, WooCommerce or the business's own backend, so nobody has to type up invoices. About two seconds after a payment lands, Setra knows who paid and for which invoice. When a payment doesn't fit (too little, too much, a duplicate, or from a wallet nobody recognises), Setra holds it for a person to decide and records the reason. It never guesses.
>
> **Business tools that keep the books.** Every payment is recorded in double-entry books automatically: each dollar is written down twice, where it came from and where it went, so the books always balance. Sales tax goes to Taxes Payable instead of income. From those records come profit and loss, the balance sheet, cash flow, what customers owe and what the business owes vendors. Setra checks its own work against the wallet's real balance on Monad, walks the owner through closing each month, and exports everything for QuickBooks or Xero. A closed month can be published on Monad as a fingerprint of the books, so an accountant or lender can confirm nothing changed afterwards.
>
> **Seti, an assistant you talk to.** Ask what needs your attention today, how much tax you owe, who your top customers are, or what accrual accounting means. Tell it to bill a client or say what an unexplained payment was, and it prepares the record for you to confirm. Every number comes from the books. The AI model only ever sees what you typed, never your customers or figures, and nothing changes without your yes.
>
> **Why Monad.** Setra shows a payment the moment it appears and records it only once Monad finalizes the block, the point after which it can't be undone. In a read-only test on Monad mainnet, 34 real USDC transfers went from detected to paid in 1.8 seconds on average. That speed is what lets the books update payment by payment instead of at month end. Setra also has two contracts on Monad testnet: one that carries an invoice reference inside the payment, and one that records books fingerprints.
>
> **What's real today.** Setra is live at setra.up.railway.app on Monad testnet. A real testnet payment was matched to its invoice and booked 2.4 seconds after it landed, and an identical second payment was flagged as a possible duplicate instead of counted twice. The codebase has more than 350 automated tests, plus browser tests that make real transfers on a local chain. We don't have paying customers yet.

### GTM & user acquisition strategy

(Full plan in `docs/gtm.md`. This version fits a form field.)

> **Who we sell to first.** Small businesses already paid in USDC, starting on Monad: agencies and freelancers with clients abroad, online stores that accept stablecoins, and companies selling to crypto-native customers. The problem shows up with every payment ("who sent this?") and gets expensive at month end, when someone reconciles by hand. Frequent and costly problems are where word of mouth and content compound.
>
> **How they find us.**
> - **The Monad ecosystem first:** founders from Metropolis and the Monad community who invoice clients in USDC, reached directly by the founder with a free setup call.
> - **Every invoice is an ad:** each payment page says "Powered by Setra", and the person paying is often a business too. One click takes them to Setra.
> - **Accountants and bookkeepers:** one bookkeeper serving crypto businesses brings many clients, and Setra exports to QuickBooks and Xero, the tools they already use.
> - **Store app listings:** Setra already takes orders from Shopify and WooCommerce; listing there reaches merchants the moment they start accepting stablecoins.
> - **Guides people search for:** how to record a USDC payment, handle sales tax on a stablecoin sale, or reconcile a wallet.
>
> No paid ads until we know what a customer costs to win.
>
> **How they start and stay.** Free with no card: connect a wallet, send an invoice, and watch the payment reach the books in minutes. Businesses stay because they close their months in Setra, their accountant works from its exports, and Seti makes the books part of the daily routine.
>
> **How we make money.** A monthly price set by payments received, never a percentage of the money: free up to 20 payments a month, $49 up to 200, $149 up to 2,000, custom above. The first 20 businesses get half price for a year with hands-on setup.
>
> **What we measure.** Payments matched per month (north star), a first matched payment within 24 hours (activation), months closed in Setra (retention), and sign-ups from payment pages and partners (referral). Our 90-day goal: 20 businesses using Setra, 5 paying, and one accountant partner with at least three clients.

---

## 2. GitHub repo

https://github.com/Zaheer-sol/setra

[The repo is private. Make it public before judging starts on 14 October, or reviewers can't open it. Before it goes public, I'll scan the full history for secrets.]

---

## 3. Product link and access instructions

**Product link:** https://setra.up.railway.app

**Access instructions:**

> Setra runs on Monad testnet. No real money is involved.
>
> **Fastest look:** sign in at https://setra.up.railway.app/login with `owner@acme.test` / `SetraDemo!2026`. It's a demo business in test mode with sample data. Try:
> - **Needs review** to see payments Setra held instead of guessing.
> - **Books** and **Reports** for the double-entry books, profit and loss, and balance sheet.
> - **Seti** (top right): ask "What should I focus on today?" or "How much tax do I owe?"
> - **Developers → Test payments** to simulate exact, partial, overpaid and unknown payments and watch them reach the books.
>
> **Your own workspace:** create one at https://setra.up.railway.app/signup (free, no card). Add any public Monad wallet address, create an invoice and pay it with testnet USDC, or use "Simulate a test payment" on the payment page.
>
> **Verify a published month:** https://setra.up.railway.app/verify
>
> **Evidence on Monad testnet:** the README's "Where Setra uses Monad" table links every contract and transaction on the explorer.

---

## 4. Promotional material (optional)

### Project X profile
[Your X handle, if you have one for Setra.]

### Product advertisement
A post you can use with the pitch video or a screenshot:

> Getting paid in stablecoins is fast. Knowing who paid, and getting it into your books, still isn't.
>
> Setra is a payment processor, business tools and an assistant for businesses paid in USDC on Monad. About two seconds after a payment lands, it's matched to its invoice and in your books.
>
> Live on Monad testnet: setra.up.railway.app
> Built for @monad Metropolis.

---

## 5. Bounties

[Bounty fields go here once the bounty is chosen.]
