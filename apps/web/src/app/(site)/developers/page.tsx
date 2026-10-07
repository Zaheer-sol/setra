import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CodeBlock } from "@/components/app-ui";
import { Flow, PageHero, Tile, wrap } from "@/components/marketing";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Developers", description: "Connect your checkout or backend to Setra with idempotent APIs, versioned financial events and signed webhooks on Monad." };

export default function DevelopersMarketingPage() {
  return (
    <>
      <PageHero
        title="Integrate Setra into your payment flow."
        mascot="focused"
        actions={
          <>
            <Button asChild size="lg">
              <Link href="/docs/quickstart">
                Quickstart <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="secondary">
              <Link href="/docs">API reference</Link>
            </Button>
          </>
        }
      >
        Send Setra an invoice or order from your backend. When USDC reaches your wallet on Monad, Setra identifies it, updates the books and sends your system a signed financial event.
      </PageHero>
      <section className="py-16">
        <div className={`${wrap} grid items-start gap-14 lg:grid-cols-2`}>
          <Flow
            nodes={[
              { title: "Create payment request", detail: "POST /v1/invoices" },
              { title: "Customer pays", detail: "hosted page or intent" },
              { title: "Setra monitors Monad", detail: "tip → finalized", tone: "monad" },
              { title: "Setra matches payment", detail: "match-v1.1", tone: "dark" },
              { title: "payment.matched", detail: "signed webhook" }
            ]}
          />
          <CodeBlock
            code={`// 1. Send Setra the order (safe to repeat: same ID, same result)
const res = await fetch("https://setra.up.railway.app/api/v1/orders", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.SETRA_API_KEY}\`,
    "Idempotency-Key": \`order-\${order.id}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    external_id: order.id,
    amount: "2000.00",          // decimal strings, never floats
    customer: { external_ref: order.customerId, email: order.email },
  }),
});
const { invoice } = await res.json();
redirect(invoice.payment_url);   // or let them pay your wallet directly

// 2. React when it's paid (verifySetraWebhook: 10 lines, in the webhooks docs)
app.post("/webhooks/setra", express.raw({ type: "application/json" }), (req, res) => {
  if (!verifySetraWebhook(process.env.SETRA_WEBHOOK_SECRET, req.body.toString(),
      req.get("x-setra-timestamp"), req.get("x-setra-signature")))
    return res.sendStatus(400);
  const event = JSON.parse(req.body);
  if (event.type === "payment.matched") fulfil(event.data.invoice.external_id);
  res.sendStatus(200);
});`}
          />
        </div>
      </section>
      <section className="py-28 max-md:py-16">
        <div className={`${wrap} grid gap-4 md:grid-cols-2 lg:grid-cols-3`}>
          {[
            ["Versioned REST API", "Cursor pagination, filtering, sorting, request IDs, consistent errors and OpenAPI 3.1."],
            ["Idempotency keys", "Retry any create safely. Same key and body replays the original response; a different body is rejected."],
            ["Financial events", "PAYMENT_OBSERVED, PAYMENT_MATCHED, PARTIALLY_PAID, OVERPAID, UNKNOWN_PAYMENT, PAYMENT_REVERSED, each with evidence and a rule version."],
            ["Signed webhooks", "HMAC-SHA256 over timestamp and body, retries with backoff, every attempt stored, one-click replay, zero-downtime secret rotation."],
            ["Payment intents", "An optional Monad contract that puts a machine-readable reference inside the payment transaction. Non-custodial, no admin keys."],
            ["Test mode on the real pipeline", "sk_test_ keys run on Monad testnet, and you can simulate exact, partial, over, unknown, wrong-token and reorg scenarios through the same pipeline as live payments."]
          ].map(([t, d]) => (
            <Tile key={t} title={t}>
              {d}
            </Tile>
          ))}
        </div>
      </section>
    </>
  );
}
