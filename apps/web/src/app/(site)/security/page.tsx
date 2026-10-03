import type { Metadata } from "next";
import { CheckList, PageHero, wrap } from "@/components/marketing";
import { Stagger, StaggerItem } from "@/components/motion";

export const metadata: Metadata = { title: "Security", description: "How Setra protects merchants: non-custodial design, tenant isolation, signed webhooks and immutable evidence." };

const SECTIONS = [
  {
    title: "Non-custodial by design",
    points: [
      "Customers pay your wallet directly; funds never pass through Setra.",
      "Setra needs only public addresses. It never asks for private keys, seed phrases or signing permissions.",
      "The optional payment-intent contract has no owner, no admin, no upgrade path and never holds a balance."
    ]
  },
  {
    title: "Wallet monitoring",
    points: [
      "Tokens are identified by chain ID and contract address, never by symbol.",
      "Payments are applied only after Monad finality; tip observations are provisional.",
      "If monitoring falls behind or a provider fails, Setra pauses and says so. It doesn't fill gaps with guesses."
    ]
  },
  {
    title: "API security",
    points: [
      "API keys are 256-bit random secrets, shown once and stored only as SHA-256 hashes.",
      "Test and live keys are separated; read-only scopes available; revocation is immediate.",
      "Rate limits, request IDs, strict input validation and idempotency keys on every create."
    ]
  },
  {
    title: "Webhook verification",
    points: [
      "Every delivery is signed with HMAC-SHA256 over the timestamp and raw body.",
      "Receivers reject stale timestamps to prevent replay; secrets rotate without downtime.",
      "Delivery status reflects real HTTP attempts, and every request and response is kept."
    ]
  },
  {
    title: "Evidence and audit history",
    points: [
      "Blockchain observations, match decisions, financial events, allocations and resolutions are append-only, enforced by the database.",
      "Manual resolutions record who, when, why, and the state before and after.",
      "Reorgs and reversals are compensating entries; history is never rewritten."
    ]
  },
  {
    title: "Data isolation",
    points: [
      "Every query is scoped to your organization, and PostgreSQL row-level security enforces it again underneath.",
      "The application connects as a non-superuser role, so isolation cannot be bypassed by a missing filter.",
      "Session cookies are HttpOnly and SameSite; state-changing requests from other origins are refused."
    ]
  }
];

export default function SecurityPage() {
  return (
    <>
      <PageHero title="How Setra keeps your records safe." mascot="resting">Setra handles payment records. The money itself goes straight from your customer to your wallet. This page explains how the records are protected and what Setra never has access to.</PageHero>
      <section className="pb-16">
        <Stagger className={`${wrap} grid gap-4 md:grid-cols-2`}>
          {SECTIONS.map((s) => (
            <StaggerItem key={s.title} className="rounded-[28px] bg-card px-[30px] py-8 text-card-foreground">
              <h3 className="text-xl font-semibold tracking-[-0.022em]">{s.title}</h3>
              <CheckList items={s.points} className="mt-4" />
            </StaggerItem>
          ))}
        </Stagger>
      </section>
      <section className="py-16">
        <div className={wrap}>
          <p className="max-w-[720px] text-muted-foreground">
            Setra&apos;s smart contract has an automated test suite with fuzz and invariant tests, but it has not been audited by a third party. We&apos;ll publish audit reports here when they exist. Report
            vulnerabilities to security@setra.dev.
          </p>
        </div>
      </section>
    </>
  );
}
