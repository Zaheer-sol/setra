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

> **Who we sell to first.** Small businesses already being paid in USDC: agencies, studios and freelancers with clients abroad, online stores that accept stablecoins, and software companies selling to crypto-native customers. They feel the problem every week, because their payments arrive as wallet addresses and their bookkeeping happens in spreadsheets. We start with teams building and selling on Monad, where we can reach founders directly.
>
> **How they find us.**
> - The Monad ecosystem first: founders from Metropolis and the Monad community who invoice clients in USDC. We'll offer the first five a hands-on pilot.
> - Accountants and bookkeepers who serve crypto businesses. One accountant brings many clients, and Setra's QuickBooks and Xero exports fit how they already work.
> - Store connections. Setra already takes orders from Shopify and WooCommerce. Listing in their app stores puts Setra in front of merchants who start accepting stablecoins.
> - Plain-language guides on questions owners search for, such as how to record a USDC payment in the books or how to handle sales tax on a stablecoin sale.
>
> **How they start.** Test mode is free and needs no card. A business can connect a wallet, send itself an invoice and watch it reach the books in a few minutes. Pilots are a fixed $1,000 for four weeks of hands-on setup, credited toward the first three months.
>
> **How we make money.** A monthly subscription by payment volume, never a percentage of payments: $499 a month for up to 1,000 payments, $1,499 for up to 10,000, custom above that. A card processor takes a slice of every sale; Setra charges for the software.
>
> **What we measure.** The first matched payment (activation), months closed in Setra (retention) and payments per month (expansion). Our goal for the next 90 days is five pilot businesses and the first paying customer.

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

### Best use of Nansen

[Only submit this if `NANSEN_API_KEY` is set on Railway and counterparty lookups are switched on in the demo workspace. Otherwise reviewers will see an empty panel.]

**What we built with Nansen**

> Setra's hardest case is money nobody can identify: a payment arrives from a wallet that isn't saved to any customer. Setra won't guess, so the payment waits for a person. Nansen helps that person decide. Setra asks Nansen who is behind the wallet and turns the answer into accounting advice:
>
> - **Unknown payments:** Nansen's address labels become a plain explanation and a next step. For example: "Labelled as an exchange wallet. A customer probably paid from their exchange account, so match by amount and date, and don't save this address to a customer."
> - **The likely customer:** Nansen's counterparties data shows whether the unknown wallet has dealt with a wallet already saved for one of the business's customers. "This wallet has transacted with Acme Ltd's saved wallet 3 times in the last year."
> - **Before saving an address:** Setra warns when someone tries to save an exchange, bridge or app address to a single customer, which would make strangers' future payments match that customer.
> - **Money going out:** labels for the recipient of a transfer waiting to be classified, with advice on how to record it.
> - **Seti:** "Who sent the $740?" gets the label, the likely customer and a suggested next step in one answer.
>
> Nansen never decides anything. Matching stays rule-based and every suggestion is for a person to confirm, which is what makes it safe to use in accounting.

**Nansen data used**

> Address labels (`/api/v1/profiler/address/labels`) and address counterparties (`/api/v1/profiler/address/counterparties`) on chain `monad`. Test-mode addresses use their Monad mainnet labels, and Setra says so.

**How it goes beyond raw data**

> Setra doesn't display labels. It reads them into a kind of wallet (exchange, bridge, fund, contract, protocol, private wallet), combines that with the business's own customers and open invoices, and produces a specific bookkeeping decision. The same labels always give the same advice.

**Where to see it**

> In the app: an unknown payment's page or Needs review, then "Who sent this?". Also the customer and vendor forms, the Classify page for money going out, and Seti.
>
> Code: `packages/engine/src/intel/counterparty.ts`, `apps/api/src/routes/accounting/counterparty.ts`, `apps/web/src/components/counterparty.tsx`, tests in `apps/api/test/counterparty.test.ts`. Full write-up: `docs/nansen.md`.

**Privacy and cost**

> Off by default per workspace, because the sender's address is sent to Nansen. Answers are cached for a week, credits are only spent when a person asks, and a failed lookup is explained in plain words.
