# Pilot kit: real businesses before judging

The goal: two or three real businesses (freelancers, small agencies, crypto-native startups) run a real
invoice through Setra on Monad testnet, and one of them says, in their own words, whether it would help
them. A single real user is worth more to judges than any feature. Setra stays on testnet for now, so
no real money moves.

## Who to ask

- Freelancers and small studios already invoicing clients in USDC.
- Startups paying contractors or receiving customer payments in stablecoins.
- Anyone in the Monad community who gets paid onchain and does their own books.

## What to be honest about (say this up front)

- Setra is a hackathon-stage product. It is non-custodial: it only reads public wallet addresses, and
  funds never pass through it.
- The pilot runs on Monad testnet: payments use testnet USDC, which has no value. Nothing real is at risk.
- The payment-intent smart contract is deployed on Monad testnet only and is not audited; without it
  configured, payments use direct USDC transfers, which is fully supported.
- Their data stays in the pilot workspace; they can ask for it to be deleted.

## Message you can send

> Hi {name}, when a client pays you in USDC, how do you work out which invoice it was for and get it
> into your books?
>
> I'm building Setra for the Monad Metropolis hackathon. About two seconds after a payment lands, it
> matches the payment to its invoice and records it in your books, with exports to QuickBooks or Xero.
>
> Would you try it for 15 minutes and tell me honestly if it would save you time? It runs on Monad
> testnet, so you'd pay a test invoice with free testnet USDC. No real money is involved, and Setra
> never touches your funds.

## The 15-minute session

1. They sign up ("Create your workspace"), choose **Collect my first payment**, and paste their public wallet address.
2. Stay in **test mode** (Monad testnet). Create a payment request with Seti or **New invoice**, using
   the kind of amount and description they'd put on a real invoice.
3. The client (or they, from a second wallet funded with testnet USDC and a little testnet MON from a
   faucet) pays from the payment page.
4. Watch it arrive: payment detected → paid → **In the books**.
5. They open **Books** and **Reports**, and ask Seti "How much did we make this month?".
6. Optional: **Export for your accountant** → the format they use.

## Questions to ask afterwards (write down their exact words)

1. How do you keep track of stablecoin payments today? How long does it take each month?
2. Was anything confusing? Where did you hesitate?
3. Would you trust these books? What would you check first?
4. Would you use this for real invoices? What's missing before you would?
5. What would you pay for it, if anything?
6. May we quote you (name or anonymous) in our submission?

## For the submission

Record per pilot: date, business type, number of testnet payments, the transaction hash of at least
one (testnet explorer link), and their answers. Describe them as testnet pilots. Only report what
actually happened; if a pilot didn't finish, say so.
