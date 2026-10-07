"use client";

import Link from "next/link";
import { useState } from "react";
import { Plug, Plus } from "lucide-react";
import { Alert, Badge, Button, Card, ChoiceCard, ChoiceGroup, CodeBlock, CopyButton, EmptyState, ErrorState, Field, fieldErrors, Input, Modal, PageHeader, SkeletonRows, useToast } from "@/components/app-ui";
import { useSession } from "@/components/session";
import { api, useApi, type ApiError } from "@/lib/api";
import { timeAgo } from "@/lib/format";

type Source = { id: string; kind: "generic" | "shopify"; name: string; status: string; secret_hint: string; inbound_url: string; last_event_at: string | null; counts: Record<string, number> };
type Created = Source & { secret: string | null };

const OUTCOME: Record<string, { label: string; tone: "success" | "info" | "neutral" | "warning" | "danger" }> = {
  created: { label: "Order added", tone: "success" },
  updated: { label: "Order updated", tone: "info" },
  unchanged: { label: "No change", tone: "neutral" },
  cancelled: { label: "Order cancelled", tone: "neutral" },
  ignored: { label: "Skipped", tone: "neutral" },
  failed: { label: "Not accepted", tone: "danger" }
};

export default function OrderSourcesPage() {
  const { can, isTest } = useSession();
  const { data, error, mutate } = useApi<{ data: Source[] }>("/v1/order-sources");
  const { data: wallets } = useApi<{ data: unknown[] }>("/v1/wallets");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const write = can("webhooks:write");
  const prefix = isTest ? "sk_test" : "sk_live";

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        title="Orders from your systems"
        description="Send each order from your store, checkout or backend. Setra matches the payment when it reaches your wallet, posts it to the books and asks you only when something doesn't add up."
        actions={write && <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>Connect a source</Button>}
      />
      {wallets && wallets.data.length === 0 && (
        <Alert tone="warning" title="Add the wallet your customers pay">
          Orders can come in now, but Setra can only match a payment once it knows which wallet receives it. <Link href="/app/wallets" className="font-medium text-primary hover:underline">Add a wallet</Link>
        </Alert>
      )}
      {created && <ConnectedNotice source={created} onDone={() => setCreated(null)} />}

      <Card title="Connected sources" description="Each one has its own address. Every order it sends is checked against its secret and recorded once, even if it's sent again.">
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data ? (
          <SkeletonRows rows={2} cols={3} />
        ) : data.data.length === 0 ? (
          <EmptyState icon={<Plug />} title="Nothing connected yet" mascot="curious" actions={write && <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>Connect a source</Button>}>
            Connect Shopify, or point your own checkout or backend at Setra.
          </EmptyState>
        ) : (
          <ul className="divide-y">
            {data.data.map((s) => (
              <SourceRow key={s.id} source={s} canWrite={write} onChange={() => mutate()} />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Or send orders from your backend" description="Call the orders API when an order is placed. Send it again whenever it changes; the same order twice changes nothing.">
        <div className="grid gap-3 px-6 py-5 max-md:px-4">
          <CodeBlock
            label="curl"
            code={`curl https://setra.up.railway.app/api/v1/orders \\
  -H "Authorization: Bearer ${prefix}_…" \\
  -H "Idempotency-Key: order-9281" \\
  -H "Content-Type: application/json" \\
  -d '{
    "external_id": "9281",
    "amount": "1000.00",
    "customer": { "external_ref": "alice_123", "name": "Alice", "email": "alice@example.com" },
    "metadata": { "cart": "c_77" }
  }'`}
          />
          <p className="text-sm text-muted-foreground">
            When the payment arrives, the <code className="font-mono text-[0.92em]">payment.matched</code> webhook carries your <code className="font-mono text-[0.92em]">external_id</code> and metadata, so your system can mark the order paid. To cancel, send{" "}
            <code className="font-mono text-[0.92em]">&quot;status&quot;: &quot;cancelled&quot;</code>. Keys are on the <Link href="/app/developers/api-keys" className="text-primary hover:underline">API keys</Link> page.
          </p>
        </div>
      </Card>

      <CreateSource open={creating} onClose={() => setCreating(false)} onCreated={(c) => { setCreating(false); setCreated(c); mutate(); }} />
    </div>
  );
}

function ConnectedNotice({ source, onDone }: { source: Created; onDone: () => void }) {
  return (
    <Alert tone={source.secret ? "warning" : "success"} title={source.secret ? `${source.name} is connected. Copy its secret now. It won't be shown again` : `${source.name} is connected`}>
      <div className="mt-2 grid gap-2">
        <Row label="Address" value={source.inbound_url} copy="Copy address" />
        {source.secret && <Row label="Secret" value={source.secret} copy="Copy secret" />}
        {source.kind === "shopify" ? (
          <ol className="ml-4 list-decimal text-sm text-muted-foreground">
            <li>In Shopify, open Settings, then Notifications, then Webhooks.</li>
            <li>Create a webhook for <b>Order creation</b> in JSON, with the address above. Do the same for <b>Order update</b> and <b>Order cancellation</b>.</li>
            <li>Orders waiting for payment in USD become expected payments in Setra. Orders Shopify already collected by card are skipped.</li>
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">
            POST each order to the address as JSON, signed like Setra&rsquo;s own webhooks: an <code className="font-mono">X-Setra-Timestamp</code> header and <code className="font-mono">X-Setra-Signature: v1=</code> HMAC-SHA256 of <code className="font-mono">timestamp.body</code> with the secret. Add <code className="font-mono">X-Setra-Delivery-Id</code> so retries are recognised.
          </p>
        )}
        <div><Button size="sm" variant="ghost" onClick={onDone}>Done</Button></div>
      </div>
    </Alert>
  );
}

function Row({ label, value, copy }: { label: string; value: string; copy: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-card px-2.5 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
        <CopyButton value={value} label={copy} />
      </div>
    </div>
  );
}

function SourceRow({ source: s, canWrite, onChange }: { source: Source; canWrite: boolean; onChange: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const { data: events } = useApi<{ data: any[] }>(open ? `/v1/order-sources/${s.id}/events?limit=20` : null);
  const total = Object.values(s.counts ?? {}).reduce((a, b) => a + b, 0);
  return (
    <li className="px-6 py-4 max-md:px-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {s.name}
            <Badge tone="neutral" dot={false}>{s.kind === "shopify" ? "Shopify" : "Signed JSON"}</Badge>
            {s.status !== "active" && <Badge tone="warning">Off</Badge>}
          </p>
          <p className="text-sm text-muted-foreground">
            {total ? `${s.counts.created ?? 0} added · ${s.counts.updated ?? 0} updated · ${s.counts.failed ?? 0} not accepted` : "Nothing received yet"}
            {s.last_event_at ? ` · last ${timeAgo(s.last_event_at)}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>{open ? "Hide activity" : "Activity"}</Button>
          {canWrite && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                try {
                  await api(`/v1/order-sources/${s.id}/status`, { method: "POST", body: { status: s.status === "active" ? "disabled" : "active" } });
                  onChange();
                } catch (e) {
                  toast("error", (e as Error).message);
                }
              }}
            >
              {s.status === "active" ? "Turn off" : "Turn on"}
            </Button>
          )}
        </div>
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{s.inbound_url}</code>
        <CopyButton value={s.inbound_url} label="Copy address" />
      </div>
      {open && (
        <div className="mt-3">
          {!events ? (
            <SkeletonRows rows={2} cols={3} />
          ) : events.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing received yet.</p>
          ) : (
            <ul className="grid gap-2">
              {events.data.map((e) => (
                <li key={e.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm">
                  <Badge tone={OUTCOME[e.outcome]?.tone ?? "neutral"}>{OUTCOME[e.outcome]?.label ?? e.outcome}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-xs">{e.external_id ?? "unknown order"}</span>
                    {e.invoice && (
                      <>
                        {" · "}
                        <Link href={`/app/invoices/${e.invoice.id}`} className="text-primary hover:underline">{e.invoice.number}</Link>
                      </>
                    )}
                    {e.detail && <span className="block text-muted-foreground">{e.detail}</span>}
                  </span>
                  <span className="text-xs text-muted-foreground">{timeAgo(e.received_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function CreateSource({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (s: Created) => void }) {
  const [kind, setKind] = useState<"shopify" | "generic">("shopify");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const errs = fieldErrors(error);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect a source"
      description="Setra gives it an address. From then on it sends each order by itself."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || (kind === "shopify" && secret.trim().length < 16)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const c = await api<Created>("/v1/order-sources", { method: "POST", body: kind === "shopify" ? { kind, name, secret } : { kind, name } });
                setName("");
                setSecret("");
                onCreated(c);
              } catch (e) {
                setError(e as ApiError);
              } finally {
                setBusy(false);
              }
            }}
          >
            Connect
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && !error.details && <Alert tone="danger">{error.message}</Alert>}
        <ChoiceGroup value={kind} onChange={(v) => setKind(v as "shopify" | "generic")} label="What are you connecting?">
          <ChoiceCard id="src-shopify" value="shopify" selected={kind === "shopify"} title="Shopify" description="Your store sends each order with Shopify's own webhooks." />
          <ChoiceCard id="src-generic" value="generic" selected={kind === "generic"} title="Your checkout or backend" description="Any system that can post signed JSON, such as a custom checkout or a payment processor's webhooks forwarded from your server." />
        </ChoiceGroup>
        <Field label="Name" htmlFor="src-name" hint="So you can tell sources apart, for example “Main store”." error={errs.name}>
          <Input id="src-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "shopify" ? "Main store" : "Checkout backend"} />
        </Field>
        {kind === "shopify" && (
          <Field label="Shopify webhook signing secret" htmlFor="src-secret" hint="In Shopify, Settings, then Notifications, then Webhooks. It's shown under the list as the secret your webhooks are signed with." error={errs.secret}>
            <Input id="src-secret" className="font-mono" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} autoComplete="off" />
          </Field>
        )}
      </div>
    </Modal>
  );
}
