"use client";

import Link from "next/link";
import { useState } from "react";
import { MoreHorizontal, Plus, RotateCcw, Send, Webhook } from "lucide-react";
import { useSession } from "@/components/session";
import { Alert, Badge, Button, Card, CodeBlock, CopyButton, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, SkeletonRows, useToast } from "@/components/app-ui";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api, qs, useApi, type ApiError } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { WEBHOOK_EVENT_TYPES } from "@setra/schemas";

// Setra's servers deliver from the internet, so a local or private address can never receive events
// (fine while developing locally, where the console itself runs on localhost).
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.0\.0\.0)|\.local$/;
function unreachable(url: string): string | null {
  if (typeof window !== "undefined" && PRIVATE_HOST.test(window.location.hostname)) return null;
  try {
    const u = new URL(url);
    if (PRIVATE_HOST.test(u.hostname)) return "This is a local address. Setra's servers can't reach it, so every delivery fails. Replace it with your public HTTPS address.";
    if (u.protocol !== "https:") return "Setra only delivers to HTTPS addresses. Switch this endpoint to https://.";
  } catch {
    return "This address isn't a valid URL.";
  }
  return null;
}

const DELIVERY_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = { delivered: "success", retrying: "warning", failed: "danger", pending: "info", delivering: "info" };

export default function WebhooksPage() {
  const { can } = useSession();
  const toast = useToast();
  const { data: endpoints, error, mutate } = useApi<{ data: any[] }>("/v1/webhook-endpoints", { refreshInterval: 10000 });
  const [filter, setFilter] = useState("");
  const { data: deliveries, mutate: refreshDeliveries } = useApi<{ data: any[] }>(`/v1/webhook-deliveries${qs({ limit: 30, status: filter })}`, { refreshInterval: 3000 });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ label: string; secret: string } | null>(null);
  const [openDelivery, setOpenDelivery] = useState<string | null>(null);

  const act = async (path: string, body: unknown, message: string, method = "POST") => {
    try {
      const res = await api<any>(path, { method, body });
      await mutate();
      await refreshDeliveries();
      if (res?.secret) setSecret({ label: "New signing secret", secret: res.secret });
      toast("success", message);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Developers", href: "/app/developers" }, { label: "Webhooks" }]}
        title="Webhooks"
        description="Optional, for businesses with their own software. Setra tells your system the moment a payment lands, so it can mark the order paid or start fulfilment. You don't need this to get paid or keep your books, and you never need to run a node or set up an RPC."
        actions={can("webhooks:write") && <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>Add endpoint</Button>}
      />
      {secret && (
        <Alert tone="warning" title={`${secret.label}: copy it now. It won't be shown again`}>
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-warning/30 bg-card px-2.5 py-2">
            <code className="flex-1 truncate font-mono text-xs">{secret.secret}</code>
            <CopyButton value={secret.secret} label="Copy secret" />
          </div>
        </Alert>
      )}
      <Card title="Endpoints">
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !endpoints ? (
          <SkeletonRows rows={2} cols={4} />
        ) : endpoints.data.length === 0 ? (
          <EmptyState icon={<Webhook />} title="No endpoints yet" mascot="curious" actions={can("webhooks:write") && <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>Add endpoint</Button>}>
            Paste the web address your developer gives you, for example your shop's order system. Setra sends it a signed message each time a payment is matched, needs review or is reversed.
          </EmptyState>
        ) : (
          <ul>
            {endpoints.data.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-4 border-t px-6 py-3.5 first:border-t-0 max-md:px-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-[8px] flex-wrap">
                    <code className="truncate font-mono text-[0.92em] font-semibold">{e.url}</code>
                    {!e.enabled && <Badge>Disabled</Badge>}
                    {e.failed_deliveries > 0 && <Badge tone="danger">{e.failed_deliveries} failed</Badge>}
                    {e.rotating_until && <Badge tone="info">Rotating secret</Badge>}
                    {unreachable(e.url) && <Badge tone="warning">Can&apos;t be reached</Badge>}
                  </div>
                  {unreachable(e.url) && <p className="mt-[4px] text-sm text-warning">{unreachable(e.url)}</p>}
                  <p className="text-muted-foreground text-sm mt-[4px]">
                    {e.description ? `${e.description} · ` : ""}
                    {e.event_types.join(", ")}
                  </p>
                  <p className="text-muted-foreground text-xs mt-[2px]">
                    Secret {e.secret_hint} · {e.last_delivered_at ? `Last delivered ${timeAgo(e.last_delivered_at)}` : "No successful deliveries yet"}
                  </p>
                </div>
                {can("webhooks:write") && (
                  <EndpointMenu
                    enabled={e.enabled}
                    onTest={() => act(`/v1/webhook-endpoints/${e.id}/test`, undefined, "Test event queued.")}
                    onRotate={() => act(`/v1/webhook-endpoints/${e.id}/rotate-secret`, undefined, "Secret rotated. The previous secret stays valid for 24 hours.")}
                    onToggle={() => act(`/v1/webhook-endpoints/${e.id}`, { enabled: !e.enabled }, e.enabled ? "Endpoint disabled." : "Endpoint enabled.", "PATCH")}
                    onDelete={() => window.confirm("Delete this endpoint? Delivery history is kept.") && act(`/v1/webhook-endpoints/${e.id}`, undefined, "Endpoint deleted.", "DELETE")}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Deliveries"
        description="Every attempt to reach your endpoints."
        actions={
          <Select
            size="sm"
            className="w-auto"
            value={filter}
            onValueChange={setFilter}
            aria-label="Delivery status"
            options={[
              { value: "", label: "All" },
              { value: "delivered", label: "Delivered" },
              { value: "retrying", label: "Retrying" },
              { value: "failed", label: "Failed" },
              { value: "pending", label: "Pending" }
            ]}
          />
        }
      >
        {!deliveries ? (
          <SkeletonRows rows={4} cols={5} />
        ) : deliveries.data.length === 0 ? (
          <EmptyState icon={<Send />} title="No deliveries yet">Deliveries appear here as soon as a financial event matches one of your endpoints.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="max-md:hidden">Endpoint</TableHead>
                <TableHead className="text-right max-md:hidden">Response</TableHead>
                <TableHead className="text-right max-md:hidden">Attempts</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.data.map((d) => (
                <TableRow key={d.id} className="cursor-pointer" tabIndex={0} onClick={() => setOpenDelivery(d.id)} onKeyDown={(ev) => ev.key === "Enter" && setOpenDelivery(d.id)}>
                  <TableCell className="font-mono text-[0.92em] font-medium">
                    {d.event_type}
                    {d.replay_of && (
                      <Badge tone="neutral" dot={false} className="ml-2 h-5 rounded-md px-1.5 font-sans text-[11px]">
                        Replay
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge tone={DELIVERY_TONE[d.status]} pulse={d.status === "delivering"}>
                      {d.status.charAt(0).toUpperCase() + d.status.slice(1)}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate font-mono text-xs text-muted-foreground max-md:hidden">{d.endpoint_url}</TableCell>
                  <TableCell className="text-right font-mono text-[0.92em] max-md:hidden">
                    {d.last_response_status ? `${d.last_response_status}${d.last_duration_ms !== null ? ` · ${d.last_duration_ms}ms` : ""}` : d.last_error ? <span className="text-muted-foreground">{d.last_error.slice(0, 32)}</span> : "-"}
                  </TableCell>
                  <TableCell className="tabular text-right max-md:hidden">{d.attempt_count}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{timeAgo(d.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card title="Receiving events" description="What your developer needs to accept Setra's messages. Full details and copy-paste code in the webhooks docs.">
        <dl className="grid gap-3 px-6 py-5 text-sm max-md:px-4 sm:grid-cols-[180px_minmax(0,1fr)]">
          <dt className="font-medium">Request</dt>
          <dd className="text-muted-foreground">A <code className="font-mono text-[0.9em]">POST</code> with a JSON body to your HTTPS address. Reply with any 2xx within 10 seconds.</dd>
          <dt className="font-medium">Headers</dt>
          <dd className="text-muted-foreground"><code className="font-mono text-[0.9em]">X-Setra-Event-Type</code>, <code className="font-mono text-[0.9em]">X-Setra-Event-Id</code>, <code className="font-mono text-[0.9em]">X-Setra-Timestamp</code>, <code className="font-mono text-[0.9em]">X-Setra-Signature</code></dd>
          <dt className="font-medium">Signature</dt>
          <dd className="text-muted-foreground"><code className="font-mono text-[0.9em]">v1=</code> HMAC-SHA256 of <code className="font-mono text-[0.9em]">timestamp.rawBody</code> with the endpoint&apos;s signing secret. Reject anything older than 5 minutes.</dd>
          <dt className="font-medium">Retries</dt>
          <dd className="text-muted-foreground">Anything other than 2xx is retried for about a day and a half (30 s, 1 m, 2 m, up to every 6 hours). Reply 410 to stop.</dd>
          <dt className="font-medium">Duplicates</dt>
          <dd className="text-muted-foreground">A retry or replay can deliver the same event twice. Ignore an <code className="font-mono text-[0.9em]">X-Setra-Event-Id</code> you&apos;ve already handled.</dd>
          <dt className="font-medium">Try it</dt>
          <dd className="text-muted-foreground">Add your endpoint, then <strong>Send test</strong>. A <code className="font-mono text-[0.9em]">webhook.test</code> event arrives signed exactly like a real one. <Link href="/docs/webhooks" target="_blank" className="text-primary hover:underline">Read the webhooks docs</Link></dd>
        </dl>
      </Card>

      <CreateEndpointModal open={creating} onClose={() => setCreating(false)} onCreated={(s) => { setSecret({ label: "Signing secret", secret: s }); setCreating(false); mutate(); }} />
      {openDelivery && <DeliveryModal id={openDelivery} onClose={() => setOpenDelivery(null)} onReplayed={() => refreshDeliveries()} />}
    </div>
  );
}

function EndpointMenu({ enabled, onTest, onRotate, onToggle, onDelete }: { enabled: boolean; onTest: () => void; onRotate: () => void; onToggle: () => void; onDelete: () => void }) {
  return (
    <div>
      <div className="flex items-center gap-[6px]">
        <Button size="sm" icon={<Send />} onClick={onTest}>Send test</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label="More actions" icon={<MoreHorizontal />} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onRotate}>Rotate signing secret</DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggle}>{enabled ? "Disable endpoint" : "Enable endpoint"}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>Delete endpoint</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function CreateEndpointModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (secret: string) => void }) {
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [types, setTypes] = useState<string[]>(["payment.matched", "payment.partially_paid", "payment.overpaid", "payment.unknown", "payment.reversed"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add webhook endpoint"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!url || !types.length}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const e = await api<{ secret: string }>("/v1/webhook-endpoints", { method: "POST", body: { url, description: description || undefined, event_types: types } });
                setUrl("");
                onCreated(e.secret);
              } catch (err) {
                setError(err as ApiError);
              } finally {
                setBusy(false);
              }
            }}
          >
            Add endpoint
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        <Field label="Your system's web address" htmlFor="we-url" hint="Provided by your developer or software. It must start with https://. You don't need an RPC or a node: Setra watches Monad for you.">
          <Input id="we-url" type="url" className="font-mono text-[0.92em]" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/setra/webhooks" autoFocus />
        </Field>
        <Field label="Description" htmlFor="we-desc" optional>
          <Input id="we-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Order fulfilment" />
        </Field>
        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-sm font-medium text-foreground/80">Events</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {WEBHOOK_EVENT_TYPES.map((t) => (
              <div key={t} className="flex items-center gap-2">
                <Checkbox id={`evt-${t}`} checked={types.includes(t)} onCheckedChange={(v) => setTypes((s) => (v === true ? [...s, t] : s.filter((x) => x !== t)))} />
                <Label htmlFor={`evt-${t}`} className="font-mono text-[12.5px] font-normal">
                  {t}
                </Label>
              </div>
            ))}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

function DeliveryModal({ id, onClose, onReplayed }: { id: string; onClose: () => void; onReplayed: () => void }) {
  const { data: d, mutate } = useApi<any>(`/v1/webhook-deliveries/${id}`, { refreshInterval: 3000 });
  const toast = useToast();
  const { can } = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={d ? d.event_type : "Delivery"}
      description={d ? `${d.endpoint_url} · created ${dateTime(d.created_at)}` : undefined}
      footer={
        d && can("webhooks:write") && (
          <Button
            icon={<RotateCcw />}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/v1/webhook-deliveries/${id}/replay`, { method: "POST" });
                toast("success", "Replay queued as a new delivery with the identical payload.");
                onReplayed();
                await mutate();
              } catch (e) {
                toast("error", (e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Replay
          </Button>
        )
      }
    >
      {!d ? (
        <SkeletonRows rows={4} cols={2} />
      ) : (
        <div className="grid gap-3">
          <div className="flex items-center gap-[8px]">
            <Badge tone={DELIVERY_TONE[d.status]}>{d.status}</Badge>
            {d.next_attempt_at && <span className="text-muted-foreground text-sm">Next attempt {timeAgo(d.next_attempt_at)}</span>}
            {d.replay_of && <span className="text-muted-foreground text-sm">Replay of {d.replay_of}</span>}
          </div>
          <div className="text-sm font-semibold text-muted-foreground mt-[8px]">Attempts</div>
          {d.attempts.length === 0 ? (
            <p className="text-muted-foreground">Not attempted yet.</p>
          ) : (
            d.attempts.map((a: any) => (
              <details key={a.id} className="rounded-xl bg-muted/60 px-3.5 py-2.5" open={a.attempt_number === d.attempts.length}>
                <summary className="flex cursor-pointer items-center justify-between gap-3">
                  <span className="flex items-center gap-[8px]">
                    <strong>Attempt {a.attempt_number}</strong>
                    <Badge tone={a.response_status >= 200 && a.response_status < 300 ? "success" : "danger"}>{a.response_status ?? "No response"}</Badge>
                    <span className="text-muted-foreground font-mono text-xs">{a.duration_ms}ms</span>
                  </span>
                  <span className="text-muted-foreground text-sm">{dateTime(a.created_at)}</span>
                </summary>
                <div className="grid gap-3 mt-[10px]">
                  {a.error && <Alert tone="danger">{a.error}</Alert>}
                  <div className="text-sm font-semibold text-muted-foreground">Request headers</div>
                  <CodeBlock code={Object.entries(a.request_headers).map(([k, v]) => `${k}: ${v}`).join("\n")} />
                  <div className="text-sm font-semibold text-muted-foreground">Response body</div>
                  <CodeBlock code={a.response_body_excerpt || "(empty)"} />
                </div>
              </details>
            ))
          )}
          <div className="text-sm font-semibold text-muted-foreground mt-[8px]">Payload</div>
          <CodeBlock code={JSON.stringify(d.payload, null, 2)} />
        </div>
      )}
    </Modal>
  );
}
