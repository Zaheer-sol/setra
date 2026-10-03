import Link from "next/link";
import { ArrowRight, BadgeCheck, CheckCircle2, CircleDollarSign, FileSearch, GitMerge, Radar, Scale, ShieldCheck, Webhook, Zap } from "lucide-react";
import { HeroVisual } from "@/components/payment-visual";
import { Seti } from "@/components/seti";
import { Badge, ChainMark, CodeBlock } from "@/components/app-ui";
import { Bullet, Eyebrow, Feature, InlineCode, SectionHead, TextArrow, section, wrap } from "@/components/marketing";
import { Float, Pop, Reveal, ScrollLift, SlideIn, Stagger, StaggerItem, Tilt } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function HomePage() {
  return (
    <>
      <section className="relative isolate overflow-hidden pt-22 pb-28 text-center max-md:pt-14 max-md:pb-18">
        <Stagger onView={false} gap={0.09} delay={0.05} className={wrap}>
          <StaggerItem>
            <Eyebrow>Invoices, payments and books for businesses paid in USDC</Eyebrow>
          </StaggerItem>
          <StaggerItem>
            <h1 className="mt-6 text-[clamp(2.75rem,5.6vw,4.75rem)] leading-[1.05] font-bold tracking-[-0.03em] text-balance">Get paid in stablecoins.<br />Your books are already done.</h1>
          </StaggerItem>
          <StaggerItem>
            <p className="mx-auto mt-[22px] max-w-[680px] text-[clamp(1.1875rem,1.6vw,1.4375rem)] leading-[1.42] tracking-[-0.015em] text-pretty text-muted-foreground">
              Send an invoice and your customer pays in USDC on Monad. About two seconds later, Setra has matched the payment to the invoice and posted it to your books. The money goes straight to your own wallet.
            </p>
          </StaggerItem>
          <StaggerItem>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-7 max-md:gap-5">
              <Button asChild size="lg">
                <Link href="/signup">Start your workspace</Link>
              </Button>
              <TextArrow href="#how">See how it works</TextArrow>
            </div>
          </StaggerItem>
          <StaggerItem>
            <div className="mt-5 flex flex-wrap justify-center gap-[18px] text-sm text-muted-foreground">
              {["Paid straight to your wallet", "Every figure links to its transaction", "Exports to QuickBooks and Xero"].map((t) => (
                <span key={t} className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" /> {t}
                </span>
              ))}
            </div>
          </StaggerItem>
          <StaggerItem>
            <ScrollLift className="mt-18 flex justify-center max-md:mt-12">
              <div className="relative">
                <Float amplitude={6} duration={8}>
                  <Tilt max={6} glare={false} scale={1}>
                    <HeroVisual />
                  </Tilt>
                </Float>
                <Seti mood="welcome" size={170} priority className="absolute right-full bottom-2 -mr-4 max-lg:hidden" />
                <Seti mood="welcome" size={124} priority className="absolute right-full bottom-2 -mr-6 max-md:hidden lg:hidden" />
                <Seti mood="welcome" size={86} priority className="absolute bottom-[-22px] left-[-6px] md:hidden" />
              </div>
            </ScrollLift>
          </StaggerItem>
        </Stagger>
      </section>

      <section className="bg-black py-30 text-[#f5f5f7] max-md:py-20 dark:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.12),inset_0_-0.5px_0_rgba(255,255,255,0.12)]">
        <div className={wrap}>
          <p className="mx-auto max-w-[980px] text-center text-[clamp(1.875rem,4vw,3.25rem)] leading-[1.1] font-semibold tracking-[-0.03em] text-balance">
            <span className="text-[#86868b]">A block explorer shows that 2,000 USDC moved.</span> Setra shows that Acme paid invoice INV-2041 and that it is in your books.
          </p>
        </div>
      </section>

      <section className={section} id="how">
        <div className={wrap}>
          <Reveal>
            <SectionHead kicker="How it works" title="From a wallet address to a full set of books.">
              You can start with the wallet you already use. Setra reads its activity, and you send invoices only when you want to.
            </SectionHead>
          </Reveal>
          <Stagger className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["Add your wallet", "Paste a public Monad address. Setra never asks for keys and never holds your funds."],
              ["Get paid", "Customers pay from an invoice link, or send USDC to your address the way they already do."],
              ["Match", "Each payment is matched to its invoice by a payment reference, a known customer wallet or an exact amount. Anything uncertain waits for you."],
              ["Book", "Matched payments post to a double-entry ledger. Money nobody has claimed is kept apart from revenue until you say what it was."],
              ["Report", "Profit and loss, balance sheet and cash flow, with each figure linked to the entries and transactions behind it."]
            ].map(([t, d], i) => (
              <StaggerItem key={t} className="h-full">
                <Tilt max={5} className="h-full rounded-[22px]">
                  <div className="grid h-full content-start gap-2 rounded-[22px] bg-card p-6 text-card-foreground">
                    <span className="tabular text-sm font-semibold text-primary">0{i + 1}</span>
                    <h3 className="text-xl font-semibold tracking-[-0.022em]">{t}</h3>
                    <p className="leading-normal text-muted-foreground">{d}</p>
                  </div>
                </Tilt>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      <section className={cn(section, "pt-0")}>
        <div className={wrap}>
          <Reveal>
            <SectionHead kicker="Spending too" title="Know what you earned and what you owe.">
              Outgoing USDC gets the same care as incoming. Record a vendor bill or an expense, link the transfer that paid it, and it lands in the same ledger as your invoices.
            </SectionHead>
          </Reveal>
          <Stagger className="grid gap-4 md:grid-cols-3">
            <StaggerItem><Feature icon={<FileSearch />} title="Bills and expenses" body="Record a bill, approve it, and link the transfer that paid it. Payments made off the chain can be entered by hand." /></StaggerItem>
            <StaggerItem><Feature icon={<Scale />} title="Double-entry books" body="Posted entries stay on record. A mistake is fixed with a reversing entry, so the history shows what changed and who changed it." /></StaggerItem>
            <StaggerItem><Feature icon={<CircleDollarSign />} title="Reports your accountant can check" body="Profit and loss, balance sheet and cash flow come from the same posted entries, and download as CSV or as a QuickBooks or Xero import." /></StaggerItem>
          </Stagger>
          <p className="mt-6 text-sm text-muted-foreground">Setra works with USD stablecoins today. It is not a bank feed or a tax-filing service, and it does not connect to card processors.</p>
        </div>
      </section>

      <section className={cn(section, "pt-0")}>
        <div className={wrap}>
          <Reveal>
            <SectionHead kicker="What a payment looks like" title="The same transfer, read two ways." />
          </Reveal>
          <div className="grid items-center gap-5 lg:grid-cols-[1fr_auto_1fr]">
            <SlideIn from="left" className="h-full">
              <div className="h-full rounded-[22px] bg-[#1d1d1f] p-7 font-mono text-[12.5px] leading-[1.8] text-[#d2d2d7] shadow-raised dark:shadow-card" aria-label="What the blockchain says">
                <h3 className="mb-4 font-sans text-sm font-semibold text-[#86868b]">What Monad records</h3>
                {[
                  ["event ", "Transfer"],
                  ["token ", "0x7547…b603 (USDC)"],
                  ["from  ", "0x91c4…0a72"],
                  ["to    ", "0x5e7a…93f1"],
                  ["value ", "2000000000"],
                  ["block ", "108,488,412 · finalized"],
                  ["log   ", "14"]
                ].map(([k, v]) => (
                  <div key={k} className="whitespace-pre">
                    <span className="text-[#86868b]">{k}</span>
                    <span className="text-[#f5f5f7]">{v}</span>
                  </div>
                ))}
              </div>
            </SlideIn>
            <Pop delay={0.35} className="mx-auto">
              <div className="grid size-11 place-items-center rounded-full bg-card text-primary shadow-card max-lg:rotate-90" aria-hidden="true">
                <ArrowRight className="size-[18px]" />
              </div>
            </Pop>
            <SlideIn from="right" delay={0.15} className="h-full">
              <div className="h-full rounded-[22px] bg-card p-7 text-card-foreground shadow-raised" aria-label="What Setra concludes">
                <h3 className="mb-4 text-sm font-semibold text-muted-foreground">What Setra tells you</h3>
                <div className="flex items-center justify-between gap-3">
                  <strong className="text-[1.0625rem] font-semibold">Acme Ltd paid INV-2041</strong>
                  <Badge tone="success">Paid</Badge>
                </div>
                <div className="tabular mt-2 mb-3.5 text-[1.75rem] font-semibold tracking-[-0.028em]">$2,000.00 USDC</div>
                <ul className="grid">
                  {["Correct receiving wallet", "Approved asset · USDC on Monad", "Exact amount", "Within the payment window", "Only one invoice fits"].map((c) => (
                    <li key={c} className="flex items-center gap-2.5 border-t py-2.5 first:border-t-0">
                      <span className="grid size-5 place-items-center rounded-full bg-success/12 text-success" aria-hidden="true">
                        <CheckCircle2 className="size-3" />
                      </span>
                      <span className="font-medium">{c}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </SlideIn>
          </div>
        </div>
      </section>

      <section className={cn(section, "bg-card")}>
        <div className={wrap}>
          <div className="flex items-end justify-between gap-8">
            <Reveal>
              <SectionHead kicker="When a payment doesn&apos;t fit" title="Setra doesn&apos;t guess with your money.">
                A partial payment, an overpayment, a payment in the wrong token or one nobody claims goes to a review list with the evidence and your options. Whatever you decide is recorded with your name and reason.
              </SectionHead>
            </Reveal>
            <Seti mood="curious" size={150} className="mr-6 mb-10 max-md:hidden" />
          </div>
          <Stagger className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <StaggerItem>
              <Feature
                inset
                icon={<CircleDollarSign />}
                title="Partial and overpayments"
                body="$1,500 of $2,000 is tracked as partially paid with $500 remaining. $2,500 is paid, with the $500 difference flagged for refund or credit."
              />
            </StaggerItem>
            <StaggerItem>
              <Feature
                inset
                icon={<FileSearch />}
                title="Unknown payments"
                body="When nobody claims a payment, Setra lists the invoices it could belong to and why each one fits. You assign it in two clicks, with a reason."
              />
            </StaggerItem>
            <StaggerItem>
              <Feature inset icon={<GitMerge />} title="Nothing gets overwritten" body="Chain evidence can&apos;t be edited. A reversal or a resolution is a new entry, so you can always see what happened and when." />
            </StaggerItem>
          </Stagger>
        </div>
      </section>

      <section className={section}>
        <div className={cn(wrap, "grid items-center gap-14 lg:grid-cols-2")}>
          <Reveal>
            <SectionHead kicker="Built on Monad" title="Detected right away, final in about two seconds." className="mb-0">
              Setra shows a payment as detected as soon as it appears at the chain tip, and applies it only once Monad marks the block <InlineCode>finalized</InlineCode>. On Monad mainnet that took 1.8 seconds on average in our tests.
            </SectionHead>
            <ul className="mt-6 grid gap-3.5">
              <Bullet icon={<Zap />} title="Detected at the tip.">
                You and your customer see &quot;Payment detected&quot; right away. Nothing is booked yet.
              </Bullet>
              <Bullet icon={<BadgeCheck />} title="Applied at finality.">
                The invoice and the books change only after Monad finalizes the block, so a payment is never booked and then taken back.
              </Bullet>
              <Bullet icon={<Radar />} title="The real USDC.">
                Setra identifies tokens by chain and contract address, never by symbol, so a look-alike token can&apos;t pay an invoice.
              </Bullet>
            </ul>
          </Reveal>
          <ScrollLift from={12}>
            <Tilt max={4} className="rounded-[28px]">
              <div className="rounded-[28px] bg-black p-9 text-[#f5f5f7] shadow-overlay max-md:p-6 dark:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.12)]">
                <div className="flex items-center gap-2.5">
                  <ChainMark className="size-[22px] rounded-[7px]" />
                  <strong className="font-semibold">A payment on Monad, through Setra</strong>
                </div>
                <Stagger className="mt-[22px] grid gap-2.5 text-sm" gap={0.18} delay={0.2}>
                  {[
                    ["Transfer", <>The customer&apos;s USDC transfer appears onchain</>],
                    ["Observe", <>Setra records the evidence and shows &quot;Payment detected&quot;</>],
                    ["Verify", <>Monad finalizes the block and Setra matches it to INV-2041</>],
                    [
                      "Record",
                      <>
                        Invoice and books updated; <InlineCode dark>payment.matched</InlineCode> webhook queued for delivery
                      </>
                    ]
                  ].map(([t, d], i) => (
                    <StaggerItem key={i} className="grid grid-cols-[64px_1fr] gap-3 text-[#d2d2d7]">
                      <b className="font-mono font-medium text-[#a78bfa]">{t}</b>
                      <span>{d}</span>
                    </StaggerItem>
                  ))}
                </Stagger>
                <div className="mt-5 flex items-baseline gap-4 rounded-2xl bg-white/7 p-4">
                  <b className="shrink-0 text-[1.75rem] font-semibold tracking-[-0.03em] whitespace-nowrap">1.8 s</b>
                  <span className="text-xs text-[#a1a1a6]">from detected to paid, averaged over 34 real USDC transfers on Monad mainnet (a read-only test)</span>
                </div>
              </div>
            </Tilt>
          </ScrollLift>
        </div>
      </section>

      <section className={cn(section, "pt-0")}>
        <div className={cn(wrap, "grid items-center gap-14 lg:grid-cols-2")}>
          <SlideIn from="left">
            <CodeBlock
              label="Example payment.matched webhook payload"
              code={`POST /webhooks/setra
x-setra-event-type: payment.matched
x-setra-signature: v1=6f1c…a09e

{
  "type": "payment.matched",
  "data": {
    "type": "PAYMENT_MATCHED",
    "customer": { "name": "Acme Ltd" },
    "invoice": { "number": "INV-2041", "status": "paid" },
    "payment": {
      "amount": "2000.00", "asset": "USDC",
      "network": "monad", "transaction_hash": "0xabc…"
    },
    "evidence": { "block_number": "108488412",
                  "rule_version": "match-v1.1" }
  }
}`}
            />
          </SlideIn>
          <Reveal>
            <SectionHead kicker="For developers" title="Everything in the console is in the API." className="mb-0">
              The API is versioned, with idempotency keys, cursor pagination and consistent errors. Webhooks are signed with HMAC, retried with backoff and can be replayed.
            </SectionHead>
            <div className="mt-8 flex flex-wrap gap-2.5">
              <Button asChild>
                <Link href="/docs/quickstart">Read the quickstart</Link>
              </Button>
              <Button asChild variant="secondary">
                <Link href="/developers">API overview</Link>
              </Button>
            </div>
          </Reveal>
        </div>
      </section>

      <section className={cn(section, "pt-0")}>
        <Stagger className={cn(wrap, "grid gap-4 md:grid-cols-2 lg:grid-cols-3")}>
          <StaggerItem>
            <Feature icon={<ShieldCheck />} title="Non-custodial" body="Customers pay your wallet directly. Setra reads public addresses only and never asks for keys, seed phrases or withdrawal rights." />
          </StaggerItem>
          <StaggerItem>
            <Feature icon={<Scale />} title="One ledger" body="Invoices, bills, expenses and reports all post to the same journal. A correction adds an entry and leaves the original in place." />
          </StaggerItem>
          <StaggerItem>
            <Feature icon={<Webhook />} title="A source for every record" body="An onchain payment keeps its transaction evidence. A bill entered by hand keeps its document, the approval and the journal entry." />
          </StaggerItem>
        </Stagger>
      </section>

      <section className={cn(section, "pt-0")}>
        <div className={wrap}>
          <Reveal y={40}>
            <div className="relative isolate overflow-hidden rounded-[32px] bg-card px-14 py-20 text-center text-card-foreground max-md:px-5 max-md:py-9">
              <Seti mood="success" size={124} className="mb-4" />
              <h2 className="text-[clamp(2rem,4vw,3rem)] font-bold tracking-[-0.03em]">Try it on Monad testnet.</h2>
              <p className="mt-3.5 text-[clamp(1.0625rem,1.3vw,1.25rem)] tracking-[-0.012em] text-muted-foreground">Create a workspace, send yourself an invoice and pay it with test USDC. It takes about five minutes, and no real money moves.</p>
              <div className="mt-8 flex flex-wrap justify-center gap-2.5">
                <Button asChild size="lg">
                  <Link href="/signup">
                    Start your workspace <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="secondary">
                  <Link href="/pricing">View pricing</Link>
                </Button>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
