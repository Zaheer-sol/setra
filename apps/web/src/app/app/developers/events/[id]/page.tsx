"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge, Card, CodeBlock, ErrorState, KV, PageHeader, SkeletonBlock } from "@/components/app-ui";
import { useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { eventLabel } from "@/lib/status";
import { BUSINESS_EVENT_NAMES, WEBHOOK_EVENT_NAMES } from "@setra/schemas";

const TOPICS: Record<string, string> = { ...WEBHOOK_EVENT_NAMES, ...BUSINESS_EVENT_NAMES };

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: e, error, mutate } = useApi<any>(`/v1/financial-events/${id}`);
  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!e) return <SkeletonBlock height={400} />;
  const { webhook_deliveries: deliveries, ...event } = e;
  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Developers", href: "/app/developers" }, { label: "Events", href: "/app/developers/events" }, { label: e.id }]}
        title={eventLabel[e.type] ?? e.type}
        description={<span className="font-mono text-[13px]">{e.type} · {TOPICS[e.type]}</span>}
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px] [&>*]:min-w-0">
        <Card title="Payload" description="Exactly what your webhook endpoint receives as `data`.">
          <div className="px-6 py-5 max-md:px-4">
            <CodeBlock code={JSON.stringify(event, null, 2)} />
          </div>
        </Card>
        <div className="grid gap-6 [&>*]:min-w-0">
          <Card title="Summary">
            <div className="px-6 py-5 max-md:px-4 pt-[4px] pb-[4px]">
              <KV
                items={[
                  e.payment && ["Payment", <Link key="p" className="font-medium text-primary hover:underline font-mono text-[0.92em]" href={`/app/payments/${e.payment.id}`}>{e.payment.id.slice(0, 14)}…</Link>],
                  e.invoice && ["Invoice", <Link key="i" className="font-medium text-primary hover:underline font-mono text-[0.92em]" href={`/app/invoices/${e.invoice.id}`}>{e.invoice.number}</Link>],
                  e.journal_entry_id && ["Journal entry", <Link key="je" className="font-medium text-primary hover:underline font-mono text-[0.92em]" href={`/app/accounting/journal/${e.journal_entry_id}`}>{e.journal_entry_id.slice(0, 14)}…</Link>],
                  e.status && ["Status", e.status],
                  ["Rule version", <span key="r" className="font-mono text-[0.92em]">{e.evidence.rule_version}</span>],
                  ["Schema", `v${e.event_version} · ${e.schema_version}`],
                  e.reverses_event_id && ["Reverses", <Link key="rv" className="font-medium text-primary hover:underline font-mono text-[0.92em]" href={`/app/developers/events/${e.reverses_event_id}`}>{e.reverses_event_id.slice(0, 14)}…</Link>],
                  ["Created", dateTime(e.created_at)]
                ]}
              />
            </div>
          </Card>
          <Card title="Webhook deliveries">
            <div className="px-6 py-5 max-md:px-4 grid gap-3">
              {deliveries.length === 0 ? (
                <p className="text-muted-foreground">No endpoints subscribed to this event type.</p>
              ) : (
                deliveries.map((d: any) => (
                  <div key={d.id} className="flex items-center justify-between gap-3">
                    <span className="font-mono truncate text-xs max-w-[200px]">{d.endpoint_url}</span>
                    <Badge tone={d.status === "delivered" ? "success" : d.status === "failed" ? "danger" : "warning"}>{d.status}</Badge>
                  </div>
                ))
              )}
              <Link href="/app/developers/webhooks" className="font-medium text-primary hover:underline text-sm">View delivery log →</Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
