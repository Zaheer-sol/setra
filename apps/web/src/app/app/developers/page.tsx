"use client";

import Link from "next/link";
import { ArrowRight, BookOpen, FlaskConical, KeyRound, Plug, Radio, Webhook } from "lucide-react";
import { useSession } from "@/components/session";
import { Card, CodeBlock, KV, PageHeader } from "@/components/app-ui";
import { useApi } from "@/lib/api";
import { eventLabel } from "@/lib/status";

export default function DevelopersPage() {
  const { isTest } = useSession();
  const { data: keys } = useApi<{ data: any[] }>("/v1/api-keys");
  const { data: sources } = useApi<{ data: any[] }>("/v1/order-sources");
  const { data: endpoints } = useApi<{ data: any[] }>("/v1/webhook-endpoints");
  const { data: events } = useApi<{ data: any[] }>("/v1/financial-events?limit=1");
  const { data: health } = useApi<any>("/v1/health", { refreshInterval: 10_000 });
  const prefix = isTest ? "sk_test" : "sk_live";

  const tiles = [
    { href: "/app/developers/orders", icon: <Plug />, title: "Orders from your systems", body: sources ? (sources.data.length ? `${sources.data.length} connected` : "Connect a store or backend") : "…" },
    { href: "/app/developers/api-keys", icon: <KeyRound />, title: "API keys", body: keys ? `${keys.data.filter((k) => !k.revoked_at).length} active` : "…" },
    { href: "/app/developers/webhooks", icon: <Webhook />, title: "Webhooks", body: endpoints ? `${endpoints.data.length} endpoint${endpoints.data.length === 1 ? "" : "s"}` : "…" },
    { href: "/app/developers/events", icon: <Radio />, title: "Financial events", body: events?.data[0] ? `Latest: ${eventLabel[events.data[0].type] ?? events.data[0].type}` : "No events yet" },
    ...(isTest ? [{ href: "/app/developers/test-mode", icon: <FlaskConical />, title: "Test payments", body: "Exercise every payment outcome" }] : [])
  ];

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader title="Developers" description="Send orders and invoices from your store or backend, read the same numbers shown in the console, and react to payments with signed webhooks." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {tiles.map((t) => (
          <Link key={t.href} href={t.href} className="grid min-w-0 gap-2 rounded-2xl bg-card px-6 py-5 shadow-card transition-shadow hover:shadow-raised">
            <span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground [&_svg]:size-5">{t.icon}</span>
            <strong className="mt-1 font-semibold">{t.title}</strong>
            <span className="text-sm break-words text-muted-foreground">{t.body}</span>
          </Link>
        ))}
      </div>
      {health && <DetectionStatus health={health} isTest={isTest} />}
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card title="1. Send an order" description="From your backend, keyed by your own order ID. Sending it again changes nothing.">
          <div className="px-6 py-5 max-md:px-4">
            <CodeBlock
              code={`curl https://setra.up.railway.app/api/v1/orders \\
  -H "Authorization: Bearer ${prefix}_…" \\
  -H "Idempotency-Key: order-8812" \\
  -H "Content-Type: application/json" \\
  -d '{
    "external_id": "8812",
    "amount": "2000.00",
    "customer": { "external_ref": "cus_42", "email": "ap@acme.example" }
  }'`}
            />
            <p className="mt-2.5 text-sm text-muted-foreground">
              Your customer can pay your wallet directly, or use the <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.86em]">payment_url</code> in the response. Stores can post orders instead: see <Link href="/app/developers/orders" className="text-primary hover:underline">Orders</Link>. {isTest ? "Test keys use Monad testnet." : "Live keys use Monad mainnet."}
            </p>
          </div>
        </Card>
        <Card title="2. React to payment.matched" description="Verify the signature, then fulfil the order.">
          <div className="px-6 py-5 max-md:px-4">
            <CodeBlock
              code={`import { verifySetraWebhook } from "@setra/sdk";

app.post("/setra", express.raw({ type: "application/json" }), (req, res) => {
  const ok = verifySetraWebhook(process.env.SETRA_WEBHOOK_SECRET, req.body.toString(),
    req.header("x-setra-timestamp"), req.header("x-setra-signature"));
  if (!ok) return res.sendStatus(400);

  const event = JSON.parse(req.body);
  if (event.type === "payment.matched") {
    markPaid(event.data.invoice.external_id, event.data.payment.transaction_hash);
  }
  res.sendStatus(200);
});`}
            />
          </div>
        </Card>
      </div>
      <Link href="/docs" target="_blank" className="flex items-center justify-between gap-3 rounded-2xl bg-card px-6 py-5 shadow-card transition-shadow hover:shadow-raised">
        <span className="flex items-center gap-3">
          <BookOpen className="size-[18px] text-primary" aria-hidden="true" />
          <span>
            <strong>Read the docs</strong>
            <span className="block text-sm text-muted-foreground">Quickstart, API reference, webhooks, payment intents, errors and test mode.</span>
          </span>
        </span>
        <ArrowRight size={16} aria-hidden="true" />
      </Link>
    </div>
  );
}

const STREAM_LABEL: Record<string, string> = { live: "Live", recovering: "Recovering from a gap (RPC covering it)", offline: "Not connected" };

/** How payments are detected on this deployment: RPC ingestion always, execution events when a sidecar is attached. */
function DetectionStatus({ health, isTest }: { health: any; isTest: boolean }) {
  const chainId = isTest ? 10143 : 143;
  const rpc = Array.isArray(health.checks.ingestion) ? health.checks.ingestion.find((n: any) => n.chain_id === chainId) : null;
  const ee = health.checks.execution_events;
  const stream = ee?.streams?.find((s: any) => s.chain_id === chainId);
  return (
    <Card title="Payment detection" description="How Setra sees payments on Monad. Invoices and books only change once a block is final.">
      <div className="px-6 py-1 max-md:px-4">
        <KV
          items={[
            ["RPC ingestion", rpc ? `${rpc.status === "ok" ? "Healthy" : rpc.status} · settled block ${Number(rpc.settled_block ?? 0).toLocaleString()}` : "Not configured"],
            [
              "Execution events",
              !ee?.enabled
                ? "Not enabled on this deployment (needs a Monad node with the Setra sidecar)"
                : stream
                  ? `${STREAM_LABEL[stream.status] ?? stream.status} · ${Number(stream.payment_signals).toLocaleString()} payment signals · ${stream.gaps} gap${stream.gaps === "1" ? "" : "s"}`
                  : "Enabled, waiting for a sidecar to connect"
            ]
          ]}
        />
      </div>
    </Card>
  );
}
