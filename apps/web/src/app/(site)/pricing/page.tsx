import type { Metadata } from "next";
import Link from "next/link";
import { CheckList, PageHero, wrap } from "@/components/marketing";
import { Seti } from "@/components/seti";
import { Reveal, Stagger, StaggerItem, Tilt } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Pricing", description: "Setra pricing: free test mode, Build, Scale, Enterprise and a fixed-scope paid pilot." };

const PLANS = [
  {
    name: "Test",
    price: "Free",
    note: "For development",
    cta: "Start building",
    href: "/signup",
    features: ["Unlimited test mode on Monad testnet", "Simulated payment scenarios", "API, webhooks and exports", "1 workspace"]
  },
  {
    name: "Build",
    price: "$499",
    per: "/month",
    note: "Up to 1,000 payments / month",
    cta: "Start building",
    href: "/signup",
    featured: true,
    features: ["Live on Monad mainnet", "Matching, exceptions and reconciliation", "Signed webhooks with replay", "Up to 5 teammates", "Email support"]
  },
  {
    name: "Scale",
    price: "$1,499",
    per: "/month",
    note: "Up to 10,000 payments / month",
    cta: "Talk to us",
    href: "mailto:hello@setra.dev",
    features: ["Everything in Build", "Multiple receiving wallets and networks", "Unlimited teammates and roles", "Priority support"]
  },
  {
    name: "Enterprise",
    price: "Custom",
    note: "High volume and custom needs",
    cta: "Contact sales",
    href: "mailto:hello@setra.dev",
    features: ["Dedicated infrastructure and RPC", "Custom retention and exports", "Security review support", "Named contact"]
  }
];

export default function PricingPage() {
  return (
    <>
      <PageHero title="Simple pricing. No percentage of your payments." mascot="curious">
        Setra charges for software, not for moving your money, because it never does. Build freely in test mode and pay when you go live.
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
                <h2 className="text-[clamp(2rem,4vw,3rem)] font-bold tracking-[-0.03em]">Paid pilot: $1,000, fixed scope</h2>
                <p className="mt-3.5 text-[1.0625rem] text-muted-foreground">
                  Four weeks to go live on Monad with your real payment flow: integration support, a reconciliation review with your finance team, and a written go/no-go. Credited toward your first three months if you
                  continue.
                </p>
              </div>
              <Button asChild size="lg">
                <a href="mailto:hello@setra.dev?subject=Setra%20paid%20pilot">Start a pilot</a>
              </Button>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
