"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Radio } from "lucide-react";
import { Badge, Card, EmptyState, ErrorState, Money, Mono, PageHeader, Pager, Select, SkeletonRows, useCursorPager } from "@/components/app-ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { qs, useApi } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { eventLabel } from "@/lib/status";
import { BUSINESS_EVENT_NAMES, BUSINESS_EVENT_TYPES, FINANCIAL_EVENT_TYPES, WEBHOOK_EVENT_NAMES } from "@setra/schemas";

const TOPICS: Record<string, string> = { ...WEBHOOK_EVENT_NAMES, ...BUSINESS_EVENT_NAMES };

const TONE: Record<string, "success" | "warning" | "danger" | "info" | "accent" | "neutral"> = {
  PAYMENT_OBSERVED: "info",
  PAYMENT_MATCHED: "success",
  PARTIALLY_PAID: "warning",
  OVERPAID: "accent",
  UNKNOWN_PAYMENT: "warning",
  PAYMENT_REVERSED: "danger",
  PAYMENT_DISMISSED: "neutral",
  PAYABLE_CREATED: "info",
  PAYABLE_SETTLED: "success",
  EXPENSE_RECORDED: "info",
  JOURNAL_ENTRY_POSTED: "neutral",
  JOURNAL_ENTRY_REVERSED: "warning"
};

export default function EventsPage() {
  const router = useRouter();
  const [type, setType] = useState("");
  const pager = useCursorPager();
  const { reset } = pager;
  useEffect(() => reset(), [type, reset]);
  const { data, error, mutate } = useApi<{ data: any[]; has_more: boolean; next_cursor: string | null }>(`/v1/financial-events${qs({ type, limit: 30, starting_after: pager.cursor })}`, { refreshInterval: 4000, keepPreviousData: true });
  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Developers", href: "/app/developers" }, { label: "Events" }]}
        title="Financial events"
        description="The append-only record of what Setra concluded from onchain activity. Each event references its source evidence and the rule version that produced it."
      />
      <Card
        actions={
          <Select size="sm" className="w-auto" value={type} onValueChange={setType} aria-label="Event type" options={[{ value: "", label: "All events" }, ...[...FINANCIAL_EVENT_TYPES, ...BUSINESS_EVENT_TYPES].map((t) => ({ value: t, label: eventLabel[t] ?? t }))]} />
        }
        title="Event log"
      >
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data ? (
          <SkeletonRows rows={8} cols={5} />
        ) : data.data.length === 0 ? (
          <EmptyState icon={<Radio />} title="No events yet">Events are created when payments are observed, matched, flagged or reversed, and when bills, expenses and journal entries are recorded.</EmptyState>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Event</TableHead>
                  <TableHead className="max-md:hidden">Webhook topic</TableHead>
                  <TableHead>Customer / invoice</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="max-md:hidden">Rule</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((e) => (
                  <TableRow key={e.id} className="cursor-pointer" tabIndex={0} onClick={() => router.push(`/app/developers/events/${e.id}`)} onKeyDown={(ev) => ev.key === "Enter" && router.push(`/app/developers/events/${e.id}`)}>
                    <TableCell>
                      <Badge tone={TONE[e.type] ?? "neutral"}>{eventLabel[e.type] ?? e.type}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground max-md:hidden">{TOPICS[e.type]}</TableCell>
                    <TableCell>
                      {e.customer?.name ?? e.vendor?.name ?? <span className="text-muted-foreground">{e.payment ? "Unknown" : "None"}</span>}
                      {(e.invoice ?? e.bill) && <Mono className="block text-xs text-muted-foreground">{(e.invoice ?? e.bill).number}</Mono>}
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {e.payment ? <Money value={e.payment.amount} asset={e.payment.asset ?? ""} /> : <Money value={e.amount} asset={e.currency} />}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground max-md:hidden">{e.evidence.rule_version}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{timeAgo(e.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager hasMore={data.has_more} canPrev={pager.canPrev} onNext={() => pager.next(data.next_cursor)} onPrev={pager.prev} count={data.data.length} />
          </>
        )}
      </Card>
    </div>
  );
}
