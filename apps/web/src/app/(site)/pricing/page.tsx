import type { Metadata } from "next";
import Link from "next/link";
import { CheckList, PageHero, wrap } from "@/components/marketing";
import { Seti } from "@/components/seti";
import { Reveal, Stagger, StaggerItem, Tilt } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Pricing", description: "Setra pricing: free up to 20 payments a month, Starter at $49, Growth at $149, and never a percentage of your payments." };

const PLANS = [
  {
    name: "Free",
    price: "$0",
    note: "Up to 20 payments / month",
    cta: "Start free",
    href: "/signup",
    features: ["Live on Monad, plus unlimited test mode", "Invoices, payment page and matching", "Double-entry books and reports", "1 wallet, 1 teammate"]
  },
  {
    name: "Starter",
    price: "$49",
    per: "/month",
    note: "Up to 200 payments / month",
    cta: "Start with Starter",
    href: "/signup?plan=starter",
    features: ["Everything in Free", "Seti, your accounting assistant", "Orders from Shopify, WooCommerce or your backend", "API, signed webhooks and accountant exports", "3 teammates"]
  },
  {
    name: "Growth",
    price: "$149",
    per: "/month",
    note: "Up to 2,000 payments / month",
    cta: "Start with Growth",
    href: "/signup?plan=growth",
    featured: true,
    features: ["Everything in Starter", "Multiple receiving wallets", "Bank reconciliation and month close", "Books published on Monad for your accountant or lender", "Unlimited teammates and roles", "Priority support"]
  },
  {
    name: "Scale",
    price: "Custom",
    note: "More than 2,000 payments / month",
    cta: "Create workspace",
    href: "/signup?plan=scale",
    features: ["Everything in Growth", "Volume pricing", "Hands-on setup and migration", "Named contact"]
  }
];

export default function PricingPage() {
  return (
    <>
      <PageHero title="Pay for the software, never a share of your receipts." mascot="curious">
        Free to start, then one monthly price set by how many payments you receive. Customers pay your wallet directly, so no percentage ever comes off a payment. No card needed to start, and paying yearly gets you two months free.
      </PageHero>
      <section className="pb-16">
        <Stagger className={`${wrap} grid gap-4 sm:grid-cols-2 lg:grid-cols-4`}>
          {PLANS.map((p) => (
            <StaggerItem key={p.name} className="h-full">
              <Tilt max={4} className="h-full rounded-3xl">
                <div className={cn("flex h-full flex-col gap-3.5 rounded-3xl bg-card p-7 text-card-foreground shadow-card", p.featured && "shadow-[0_0_0_2px_var(--primary),var(--raised-shadow)]")}>
                  <div>
                    <h3 className="text-[1.0625rem] font-semibold">{p.name}</h3>
                    <p className="text-sm text-muted-foreground">{p.note}</p>
                  </div>
                  <div className="text-4xl font-semibold tracking-[-0.03em]">
                    {p.price}
                    {p.per && <small className="text-sm font-medium tracking-normal text-muted-foreground">{p.per}</small>}
                  </div>
                  <CheckList items={p.features} className="gap-2 text-sm" />
                  <Button asChild variant={p.featured ? "default" : "secondary"} className="mt-auto">
                    <Link href={p.href}>{p.cta}</Link>
                  </Button>
                </div>
              </Tilt>
            </StaggerItem>
          ))}
        </Stagger>
      </section>
      <section className="py-28 max-md:py-16">
        <div className={wrap}>
          <Reveal>
            <div className="grid items-center gap-6 rounded-[32px] bg-card px-14 py-16 text-card-foreground max-md:px-5 max-md:py-9 md:grid-cols-[auto_1fr_auto]">
              <Seti mood="success" size={140} className="max-md:hidden" />
              <div>
                <h2 className="text-[clamp(2rem,4vw,3rem)] font-bold tracking-[-0.03em]">Be one of our first 20 businesses</h2>
                <p className="mt-3.5 text-[1.0625rem] text-muted-foreground">
                  Founding customers get half price on any paid plan for their first year, and we set Setra up with you: your wallet, your store or invoices, and your first month close.
                </p>
              </div>
              <Button asChild size="lg">
                <Link href="/signup?plan=founding">Claim a founding spot</Link>
              </Button>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
