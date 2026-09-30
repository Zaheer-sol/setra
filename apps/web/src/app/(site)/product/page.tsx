import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CheckList, Flow, wrap } from "@/components/marketing";
import { Reveal } from "@/components/motion";
import { Seti } from "@/components/seti";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Product", description: "How Setra turns stablecoin payments on Monad into verified financial events." };

const STAGES = [
  {
    name: "Receive",
    title: "Get paid directly, in USDC on Monad",
    body: "Create an invoice in the console or through the API. Setra generates a hosted payment page your customer can pay from any wallet, by connecting it, or by sending the exact amount to your address. Funds settle straight to the wallet you control.",
    points: ["Monad and USDC by default", "Wallet checkout or manual transfer with QR code", "Optional payment intents put a reference inside the transaction"]
  },
  {
    name: "Understand",
    title: "Every transfer, verified against the chain",
    body: "Setra watches your wallets on Monad. It records each relevant log as immutable evidence (block, hash, log index, token contract) and tracks it from the chain tip to finality. Unsupported tokens and zero-value noise never become payments.",
    points: ["Detected within one block", "Applied only once final (Monad's finalized tag)", "A reorg adds a compensating entry; nothing is edited in place"]
  },
  {
    name: "Match",
    title: "Deterministic, explainable matching",
    body: "Fixed rules decide which invoice each payment belongs to (no AI model is involved): an onchain payment-intent reference, a known customer wallet, or an exact amount that identifies exactly one open invoice. If more than one answer is plausible, Setra asks you instead of guessing.",
    points: ["Every decision lists the checks it made", "Versioned rules on every conclusion", "Partial, over, late and duplicate payments recognized"]
  },
  {
    name: "Reconcile",
    title: "Know what arrived, what's missing, and why",
    body: "See expected, received, matched and outstanding amounts for any period, with the exceptions that explain the gap. Resolve unknown payments with a reason on record, and export a CSV your finance team can use as-is.",
    points: ["Allocation ledger behind every balance", "Coverage check: totals flag incomplete chain data", "Payments and reconciliation CSV exports"]
  },
  {
    name: "Act",
    title: "Let your systems react in real time",
    body: "Every conclusion is a versioned financial event, available through the API and delivered as a signed webhook. Fulfil orders on payment.matched, chase customers on payment.partially_paid, and review payment.unknown.",
    points: ["HMAC-SHA256 signatures with timestamp", "Retries with backoff, full attempt history, replay", "Test mode that exercises the real pipeline"]
  }
];

export default function ProductPage() {
  return (
    <>
      <section className="pt-22 pb-14 max-md:pt-14">
        <div className={`${wrap} grid items-start gap-14 lg:grid-cols-2`}>
          <div>
            <Seti mood="welcome" size={112} priority className="mb-5 lg:hidden" />
            <h1 className="max-w-[860px] text-[clamp(2.5rem,5vw,4rem)] leading-[1.05] font-bold tracking-[-0.03em] text-balance">Invoices, payment matching and books for USDC on Monad.</h1>
            <p className="mt-5 max-w-[680px] text-[clamp(1.1875rem,1.6vw,1.375rem)] leading-[1.42] tracking-[-0.015em] text-muted-foreground">
              Setra sits between Monad and your business: it observes where money moved, decides what it means, and gives you a place to operate it, without custody and without spreadsheets.
            </p>
            <div className="mt-8">
              <Button asChild size="lg">
                <Link href="/signup">
                  Start building <ArrowRight aria-hidden="true" />
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
              { title: "Setra", detail: "understands the money", tone: "dark" },
              { title: "Customer", detail: "Acme Ltd" },
              { title: "Invoice", detail: "INV-2041" },
              { title: "Financial state", detail: "Paid" },
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
              <h2 className="text-[clamp(2rem,4vw,3rem)] font-bold tracking-[-0.03em]">What Setra doesn&apos;t do</h2>
              <p className="mx-auto mt-3 max-w-[680px] text-[1.0625rem] text-muted-foreground">
                Setra isn&apos;t a bank, an exchange, a custodian or a general ledger. It never holds funds, never trades, and doesn&apos;t replace your accounting system, it gives it clean, verified payment records.
              </p>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
