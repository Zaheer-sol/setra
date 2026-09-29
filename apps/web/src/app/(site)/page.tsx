import Link from "next/link";
import { ArrowRight, BadgeCheck, CheckCircle2, CircleDollarSign, FileSearch, GitMerge, Radar, Scale, ShieldCheck, Webhook, Zap } from "lucide-react";
import { HeroVisual } from "@/components/payment-visual";
import { Seti } from "@/components/seti";
import { Badge, ChainMark, CodeBlock } from "@/components/app-ui";
import { Bullet, Eyebrow, Feature, InlineCode, SectionHead, TextArrow, section, wrap } from "@/components/marketing";
import { Aurora, CountTo, Float, Pop, Reveal, ScrollLift, ScrollWords, SlideIn, Stagger, StaggerItem, Tilt } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function HomePage() {
  return (
    <>
      <section className="relative isolate overflow-hidden pt-22 pb-28 text-center max-md:pt-14 max-md:pb-18">
        <Aurora className="bottom-auto h-[760px]" />
        <Stagger onView={false} gap={0.09} delay={0.05} className={wrap}>
          <StaggerItem>
            <Eyebrow>Stablecoin payments and bookkeeping on Monad</Eyebrow>
          </StaggerItem>
          <StaggerItem>
            <h1 className="mt-6 text-[clamp(2.75rem,5.6vw,4.75rem)] leading-[1.05] font-bold tracking-[-0.03em] text-balance">Get paid in stablecoins.<br />Your books are already done.</h1>
          </StaggerItem>
          <StaggerItem>
            <p className="mx-auto mt-[22px] max-w-[680px] text-[clamp(1.1875rem,1.6vw,1.4375rem)] leading-[1.42] tracking-[-0.015em] text-pretty text-muted-foreground">
              The moment a payment is final on Monad, Setra knows which invoice it paid and your books are updated. No wallet spreadsheets, no guessing, and no crypto knowledge needed for you or your customers.
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
              {["Your wallets stay yours", "Every number traces to the chain", "Export to QuickBooks or Xero"].map((t) => (
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
          <ScrollWords
            className="mx-auto max-w-[980px] text-center text-[clamp(1.875rem,4vw,3.25rem)] leading-[1.1] font-semibold tracking-[-0.03em] text-balance"
            text="Blockchains tell you where money moved. Setra tells your business what it means."
            highlight="Setra tells your business what it means."
          />
        </div>
      </section>

      <section className={section} id="how">
        <div className={wrap}>
          <Reveal>
            <SectionHead kicker="How it works" title="From wallet activity to books you can explain.">
              Keep the way you receive money. Setra helps you classify activity, reconcile your records and understand your business. Create payment requests only when you need them.
            </SectionHead>
          </Reveal>
          <Stagger className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["Connect", "Add a public wallet address on Monad. You keep control of your funds and how you get paid."],
              ["Understand", "Review verified incoming and outgoing stablecoin activity. Unidentified money stays separate from revenue."],
              ["Record", "Match receipts, classify transfers, and record bills and expenses in your double-entry books."],
              ["Reconcile", "Check the ledger against invoices, bills and monitored wallet activity. Resolve differences with a reason on record."],
              ["Report", "See profit and loss, your balance sheet and cash flow, then trace the figures back to their journal entries."]
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
            <SectionHead kicker="Your books, not just your invoices" title="Know what you earned. Know what you owe.">
              A shared ledger connects your day-to-day work to financial reports. Start without creating a payment link or asking customers to change how they pay.
            </SectionHead>
          </Reveal>
          <Stagger className="grid gap-4 md:grid-cols-3">
            <StaggerItem><Feature icon={<FileSearch />} title="Bills and expenses" body="Record vendor bills, approve expenses and link outgoing transfers to what they paid for. Offchain payments can be recorded manually." /></StaggerItem>
            <StaggerItem><Feature icon={<Scale />} title="Double-entry books" body="Review your chart of accounts and journal. Posted entries stay on record; reversals correct mistakes without erasing history." /></StaggerItem>
            <StaggerItem><Feature icon={<CircleDollarSign />} title="Reports with a trail" body="Read profit and loss, balance sheet and cash flow reports built from posted journal entries, with CSV exports for your finance team." /></StaggerItem>
          </Stagger>
          <p className="mt-6 text-sm text-muted-foreground">Currently focused on USD-pegged stablecoins. Setra is not a bank feed, tax-filing service or automatic integration with your existing payment provider.</p>
        </div>
      </section>

      <section className={cn(section, "pt-0")}>
        <div className={wrap}>
          <Reveal>
            <SectionHead kicker="Payment collection, when you need it" title="A payment isn’t just a transaction. It’s a business event." />
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
                  {["Correct receiving wallet", "Approved asset · USDC on Monad", "Exact amount", "Within the payment window", "One deterministic candidate"].map((c) => (
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
              <SectionHead kicker="When payments don’t match perfectly" title="Setra never guesses with your money.">
                Partial, extra, unknown, late or wrong-token payments go to a review queue with the evidence and the options, and every decision is recorded.
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
                title="Unknown money, explained"
                body="A payment nobody claims shows the plausible invoices and exactly why each one fits. Assign it in two clicks, with a reason on record."
              />
            </StaggerItem>
            <StaggerItem>
              <Feature inset icon={<GitMerge />} title="History you can trust" body="Evidence is immutable. Reversals and resolutions are compensating entries, so you can always see what happened and when." />
            </StaggerItem>
          </Stagger>
        </div>
      </section>

      <section className={section}>
        <div className={cn(wrap, "grid items-center gap-14 lg:grid-cols-2")}>
          <Reveal>
            <SectionHead kicker="Built for Monad" title="Money observed is not yet money confirmed." className="mb-0">
              Setra detects activity near the chain tip, then checks Monad&rsquo;s <InlineCode>finalized</InlineCode> block tag and its configured safety lag before applying payments. Blockchain evidence stays attached to the financial record.
            </SectionHead>
            <ul className="mt-6 grid gap-3.5">
              <Bullet icon={<Zap />} title="Detected at the tip.">
                A provisional observation can show &ldquo;payment detected&rdquo; before settlement. Timing depends on the RPC provider and worker health.
              </Bullet>
              <Bullet icon={<BadgeCheck />} title="Applied at finality.">
                Confirmed payments reach the books after settlement checks. Observation events remain explicitly provisional.
              </Bullet>
              <Bullet icon={<Radar />} title="Canonical USDC.">
                Tokens are identified by chain and contract address, never by symbol.
              </Bullet>
            </ul>
          </Reveal>
          <ScrollLift from={12}>
            <Tilt max={4} className="rounded-[28px]">
              <div className="rounded-[28px] bg-black bg-[radial-gradient(520px_320px_at_100%_0%,rgba(124,99,245,0.35),transparent_65%)] p-9 text-[#f5f5f7] shadow-overlay max-md:p-6 dark:shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.12)]">
                <div className="flex items-center gap-2.5">
                  <ChainMark className="size-[22px] rounded-[7px]" />
                  <strong className="font-semibold">A payment on Monad, through Setra</strong>
                </div>
                <Stagger className="mt-[22px] grid gap-2.5 text-sm" gap={0.18} delay={0.2}>
                  {[
                    ["Transfer", <>Customer&rsquo;s USDC transfer appears onchain</>],
                    ["Observe", <>Setra records provisional evidence: &ldquo;Payment detected&rdquo;</>],
                    ["Verify", <>Finality and safety checks pass; Setra matches it to INV-2041</>],
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
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  {[
                    ["Linked", "evidence and books"],
                    ["0", "funds held by Setra"],
                    ["100%", "decisions explained"]
                  ].map(([b, l]) => (
                    <div key={l} className="rounded-2xl bg-white/7 p-4">
                      <b className="block text-[1.75rem] font-semibold tracking-[-0.03em]">{b === "100%" ? <CountTo value={100} suffix="%" /> : b}</b>
                      <span className="text-xs text-[#a1a1a6]">{l}</span>
                    </div>
                  ))}
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
            <SectionHead kicker="For developers" title="Not just a dashboard. Infrastructure." className="mb-0">
              Everything in the console is available through a versioned API with idempotency keys, cursor pagination and consistent errors. Webhooks are HMAC-signed, retried with backoff and replayable.
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
            <Feature icon={<ShieldCheck />} title="Non-custodial" body="Customers pay your wallet directly. Setra only needs public addresses, never keys, seed phrases or withdrawal rights." />
          </StaggerItem>
          <StaggerItem>
            <Feature icon={<Scale />} title="Books that connect" body="Journal entries, bills, expenses and financial reports share the same ledger. Corrections preserve the original history." />
          </StaggerItem>
          <StaggerItem>
            <Feature icon={<Webhook />} title="Records with a source" body="Onchain payments retain transaction evidence. Manual bills and expenses retain their source records, decisions and journal entries." />
          </StaggerItem>
        </Stagger>
      </section>

      <section className={cn(section, "pt-0")}>
        <div className={wrap}>
          <Reveal y={40}>
            <div className="relative isolate overflow-hidden rounded-[32px] bg-card px-14 py-20 text-center text-card-foreground max-md:px-5 max-md:py-9">
              <Aurora className="opacity-60" />
              <Seti mood="success" size={124} className="mb-4" />
              <h2 className="text-[clamp(2rem,4vw,3rem)] font-bold tracking-[-0.03em]">See what your money means.</h2>
              <p className="mt-3.5 text-[clamp(1.0625rem,1.3vw,1.25rem)] tracking-[-0.012em] text-muted-foreground">Start with your books or your first payment request. No change to how you get paid is required.</p>
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
