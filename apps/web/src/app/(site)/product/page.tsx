import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CheckList, Flow, wrap } from "@/components/marketing";
import { Reveal } from "@/components/motion";
import { Seti } from "@/components/seti";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Product", description: "How Setra turns wallet activity on Monad into matched payments, double-entry books, reconciliations and verifiable records." };

const STAGES = [
  {
    name: "Receive",
    title: "Receive USDC in the wallet you control",
    body: "Keep your current wallet and payment flow. Customers can pay from a Setra payment page, your checkout, or their own wallet. Funds settle directly to your address on Monad.",
    points: ["Monad and USDC selected by default", "Browser-wallet checkout or manual transfer", "Optional payment intents carry an onchain reference"]
  },
  {
    name: "Understand",
    title: "Every payment checked against the chain",
    body: "Setra records each relevant transfer with its block, transaction, log position and token contract. Activity is visible at the chain tip, but it does not affect invoices or books until Monad finalizes the block.",
    points: ["Detected within one block", "Applied only after Monad finality", "A chain reorganization adds a correcting entry; nothing is edited in place"]
  },
  {
    name: "Match",
    title: "Know what every payment was for",
    body: "Versioned rules match each payment using its onchain reference, sender, receiving wallet, amount and payment window. A match is automatic only when the evidence points to exactly one invoice or order. If more than one answer is plausible, Setra asks you instead of guessing.",
    points: ["Every decision shows the checks it passed", "Every decision records the rule version that made it", "Partial, over, late and duplicate payments recognized"]
  },
  {
    name: "Book",
    title: "Keep one ledger for money in and money out",
    body: "Invoices, matched payments, bills, expenses and corrections post to one double-entry ledger. Setra keeps unidentified transfers in holding accounts so they never count as revenue or spending until you say what they were.",
    points: ["Cash or accrual accounting", "Append-only journal with reversing entries", "Chart of accounts and controlled periods"]
  },
  {
    name: "Reconcile",
    title: "See what arrived, what is missing and what needs review",
    body: "Compare expected, received, matched and outstanding amounts for any period. Setra warns you when it's missing chain data for a period, and the review list shows exactly why each held payment wasn't applied.",
    points: ["Allocation history behind every invoice balance", "Wallet, invoice and ledger integrity checks", "Payments, reconciliation and accountant exports"]
  },
  {
    name: "Report",
    title: "Move from a total to its source in one click",
    body: "Profit and loss, balance sheet, cash flow, receivables and payables come from posted journal entries. Each figure can be traced through the entry to the invoice, bill, document or onchain transaction that created it.",
    points: ["Reports for cash and accrual books", "QuickBooks and Xero import layouts", "Optional monthly proof published on Monad"]
  },
  {
    name: "Connect",
    title: "Let your own software act on every payment",
    body: "Create customers, orders and invoices through the API. Versioned financial events and signed webhooks let your systems act on the same conclusions shown in the console.",
    points: ["HMAC-SHA256 signatures with timestamps", "Retries, attempt history and replay", "Test mode runs the same pipeline as live"]
  }
];

export default function ProductPage() {
  return (
    <>
      <section className="pt-22 pb-14 max-md:pt-14">
        <div className={`${wrap} grid items-start gap-14 lg:grid-cols-2`}>
          <div>
            <Seti mood="welcome" size={112} priority className="mb-5 lg:hidden" />
            <h1 className="max-w-[860px] text-[clamp(2.5rem,5vw,4rem)] leading-[1.05] font-bold tracking-[-0.03em] text-balance">Accounting for businesses that run on stablecoins.</h1>
            <p className="mt-5 max-w-[680px] text-[clamp(1.1875rem,1.6vw,1.375rem)] leading-[1.42] tracking-[-0.015em] text-muted-foreground">
              Customers pay your wallet in USDC on Monad. Setra matches each payment to its invoice or order, keeps the books, and links every figure back to the transaction behind it. The money never passes through Setra.
            </p>
            <div className="mt-8">
              <Button asChild size="lg">
                <Link href="/signup">
                  Create your workspace <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            </div>
            <Seti mood="welcome" size={210} priority className="mt-10 ml-2 max-lg:hidden" />
          </div>
          <Flow
            label="Flow: Monad, payment, Setra, customer, invoice, financial state, business action"
            nodes={[
              { title: "Monad", detail: "where the money moves", tone: "monad" },
              { title: "Payment", detail: "2,000 USDC · finalized" },
              { title: "Setra", detail: "matches it and books it", tone: "dark" },
              { title: "Customer", detail: "Acme Ltd" },
              { title: "Invoice", detail: "INV-2041" },
              { title: "Status", detail: "Paid" },
              { title: "Business action", detail: "payment.matched → ship" }
            ]}
          />
        </div>
      </section>
      {STAGES.map((s, i) => (
        <section key={s.name} className="border-t py-16">
          <Reveal className={`${wrap} grid items-start gap-14 lg:grid-cols-2`}>
            <div>
              <div className="text-[1.0625rem] font-semibold tracking-[-0.015em] text-muted-foreground">
                0{i + 1} · {s.name}
              </div>
              <h2 className="mt-2 text-[clamp(2rem,4vw,3rem)] leading-[1.08] font-bold tracking-[-0.03em] text-balance">{s.title}</h2>
            </div>
            <div>
              <p className="text-[1.0625rem] leading-relaxed text-foreground/80">{s.body}</p>
              <CheckList items={s.points} className="mt-6" />
            </div>
          </Reveal>
        </section>
      ))}
      <section className="py-28 max-md:py-16">
        <div className={wrap}>
          <Reveal>
            <div className="rounded-[32px] bg-card px-14 py-20 text-center text-card-foreground max-md:px-5 max-md:py-9">
              <Seti mood="attention" size={132} className="mb-4" />
              <h2 className="text-[clamp(2rem,4vw,3rem)] font-bold tracking-[-0.03em]">Where Setra fits</h2>
              <p className="mx-auto mt-3 max-w-[680px] text-[1.0625rem] text-muted-foreground">
                Setra keeps the books for the stablecoins your business receives and pays out. It never holds your money or trades it: funds stay in your wallets. Your accountant can work in Setra or import the posted entries into QuickBooks or Xero.
              </p>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
