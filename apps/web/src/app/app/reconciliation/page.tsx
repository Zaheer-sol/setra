"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { ExceptionsList, InvoiceStatus } from "@/components/payment-tables";
import { Alert, Button, Card, CardBody, ErrorState, Metric, Metrics, Money, Mono, PageHeader, SkeletonBlock, TextLink } from "@/components/app-ui";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { qs, useApi } from "@/lib/api";
import { dateShort, timeAgo } from "@/lib/format";

function monthRange(offset: number) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end, label: start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) };
}

export default function ReconciliationPage() {
  const [offset, setOffset] = useState(0);
  const range = useMemo(() => monthRange(offset), [offset]);
  const params = { period_start: range.start.toISOString(), period_end: range.end.toISOString() };
  const { data, error, mutate } = useApi<any>(`/v1/reconciliation${qs(params)}`, { refreshInterval: 15000, keepPreviousData: true });

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        title="Reconciliation"
        description="Compare what you invoiced with the money that reached your wallets. See what was applied, what remains outstanding and what needs a decision."
        actions={
          <>
            <div className="flex items-center rounded-[9px] bg-muted p-0.5" role="group" aria-label="Period">
              <Button variant="ghost" size="sm" className="h-7 rounded-[7px] text-foreground" onClick={() => setOffset((o) => o - 1)} aria-label="Previous month" icon={<ChevronLeft />} />
              <span className="min-w-[140px] rounded-[7px] bg-card px-3 py-1 text-center text-sm font-semibold shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)] dark:bg-[#636366]">{range.label}</span>
              <Button variant="ghost" size="sm" className="h-7 rounded-[7px] text-foreground" onClick={() => setOffset((o) => Math.min(0, o + 1))} disabled={offset === 0} aria-label="Next month" icon={<ChevronRight />} />
            </div>
            <Button variant="secondary" icon={<Download aria-hidden="true" />} onClick={() => (window.location.href = `/api/v1/exports/reconciliation.csv${qs(params)}`)}>
              Export CSV
            </Button>
          </>
        }
      />

      {error ? (
        <Card>
          <ErrorState error={error} retry={() => mutate()} />
        </Card>
      ) : !data ? (
        <SkeletonBlock height={320} />
      ) : (
        <>
          <Coverage coverage={data.coverage} />
          <Metrics className="xl:grid-cols-4">
            <Metric label="Expected" value={data.summary.expected} money foot={`${data.invoices.count} invoice${data.invoices.count === 1 ? "" : "s"} issued`} />
            <Metric label="Received" value={data.summary.received} money foot={`${data.payments.count} payment${data.payments.count === 1 ? "" : "s"} settled`} />
            <Metric label="Matched" value={data.summary.applied} money foot={`${data.payments.applied} applied to invoices`} />
            <Metric label="Needs attention" value={data.summary.needs_review} money foot={`${data.payments.needs_review} unapplied payment${data.payments.needs_review === 1 ? "" : "s"}`} warn={data.summary.needs_review !== "0.00"} />
          </Metrics>

          <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            <Card title="Where the money stands" description={`Invoices issued in ${range.label}`}>
              <CardBody className="grid gap-3">
                <Bar summary={data.summary} />
                <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                  <Legend color="bg-success">Collected <Money value={data.summary.collected_on_period_invoices} /></Legend>
                  <Legend color="bg-warning">Outstanding <Money value={data.summary.outstanding} /></Legend>
                  <Legend color="bg-muted-foreground/40">Written off <Money value={data.summary.written_off} /></Legend>
                </div>
                <Separator className="my-1" />
                <Row label="Paid" value={data.invoices.paid} />
                <Row label="Partially paid" value={data.invoices.partially_paid} />
                <Row label="Overpaid" value={data.invoices.overpaid} extra={data.summary.overpaid !== "0.00" ? <Money value={data.summary.overpaid} sign /> : undefined} />
                <Row label="Awaiting payment" value={data.invoices.open} />
                <Row label="Expired unpaid" value={data.invoices.expired} />
              </CardBody>
            </Card>
            <Card title="Received vs. applied" description={`Payments received in ${range.label}`}>
              <CardBody className="grid gap-3">
                <Line label="Received" value={data.summary.received} strong />
                <Line label="Applied to invoices" value={data.summary.applied} />
                <Line label="Waiting for review" value={data.summary.needs_review} tone={data.summary.needs_review !== "0.00" ? "warning" : undefined} />
                <Line label="Set aside (not customer payments)" value={data.summary.set_aside} />
                {data.summary.refunded !== "0.00" && <Line label="Refunded (proven by outgoing transfers)" value={data.summary.refunded} />}
                <Separator className="my-1" />
                <Line label="Still confirming" value={data.summary.confirming} muted />
                <Line label="Reversed by the chain" value={data.summary.reversed} muted />
                {data.payments.unsupported_tokens > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {data.payments.unsupported_tokens} transfer{data.payments.unsupported_tokens === 1 ? "" : "s"} of unsupported tokens excluded from totals. <TextLink href="/app/exceptions?type=wrong_token">Review</TextLink>
                  </p>
                )}
                {data.payments.simulated > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Includes {data.payments.simulated} simulated test-mode payment{data.payments.simulated === 1 ? "" : "s"}.
                  </p>
                )}
              </CardBody>
            </Card>
          </div>

          <Card title="Needs attention" description="Open exceptions for payments received this period">
            <ExceptionsList
              rows={data.exceptions}
              empty={
                <CardBody className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle2 className="size-4 text-success" /> Nothing to resolve for {range.label}.
                </CardBody>
              }
            />
          </Card>

          <Card title="Settled" description="Invoices issued this period that have received payment, and what they were for">
            {data.settled_invoices.length === 0 ? (
              <CardBody className="text-muted-foreground">No invoices issued in {range.label} have been paid yet.</CardBody>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Invoice</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right max-md:hidden">Expected</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.settled_invoices.map((i: any) => (
                    <TableRow key={i.id} className="cursor-pointer" onClick={() => (window.location.href = `/app/invoices/${i.id}`)}>
                      <InvoiceCell number={i.number} title={i.title} />
                      <TableCell>{i.customer_name}</TableCell>
                      <TableCell className="w-px">
                        <InvoiceStatus status={i.status} />
                      </TableCell>
                      <TableCell className="text-right font-semibold max-md:hidden">
                        <Money value={i.expected} />
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        <Money value={i.received} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card title="Outstanding invoices" description="Issued this period and not fully paid">
            {data.outstanding_invoices.length === 0 ? (
              <CardBody className="flex items-center gap-2 text-muted-foreground">
                <CheckCircle2 className="size-4 text-success" /> Every invoice issued in {range.label} is settled.
              </CardBody>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Invoice</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="max-md:hidden">Due</TableHead>
                    <TableHead className="text-right max-md:hidden">Amount</TableHead>
                    <TableHead className="text-right">Remaining</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.outstanding_invoices.map((i: any) => (
                    <TableRow key={i.id} className="cursor-pointer" onClick={() => (window.location.href = `/app/invoices/${i.id}`)}>
                      <InvoiceCell number={i.number} title={i.title} />
                      <TableCell>{i.customer_name}</TableCell>
                      <TableCell className="text-muted-foreground max-md:hidden">{dateShort(i.due_at)}</TableCell>
                      <TableCell className="text-right font-semibold max-md:hidden">
                        <Money value={i.amount_due} />
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        <Money value={i.amount_remaining} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function InvoiceCell({ number, title }: { number: string; title?: string | null }) {
  return (
    <TableCell className="max-w-[340px] whitespace-normal">
      <Mono className="font-medium">{number}</Mono>
      {title && (
        <span className="block truncate text-xs text-muted-foreground" title={title}>
          {title}
        </span>
      )}
    </TableCell>
  );
}

function Legend({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={cn("inline-block size-2.5 rounded-[3px]", color)} />
      {children}
    </span>
  );
}

function Coverage({ coverage }: { coverage: any }) {
  if (coverage.warning) return <Alert tone="warning" title="Totals may be incomplete">{coverage.warning}</Alert>;
  return (
    <Alert tone="neutral">
      {coverage.in_progress ? "Period in progress. " : ""}Chain data verified through {coverage.synced_through ? timeAgo(coverage.synced_through) : "-"} across {coverage.wallets_monitored} monitored wallet{coverage.wallets_monitored === 1 ? "" : "s"}.
    </Alert>
  );
}

function Bar({ summary }: { summary: any }) {
  const total = Number(summary.expected) || 1;
  const pct = (v: string) => `${Math.max(0, (Number(v) / total) * 100)}%`;
  return (
    <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`Collected ${summary.collected_on_period_invoices} of ${summary.expected} expected`}>
      <span className="h-full bg-success" style={{ width: pct(summary.collected_on_period_invoices) }} />
      <span className="h-full bg-warning" style={{ width: pct(summary.outstanding) }} />
      <span className="h-full bg-muted-foreground/40" style={{ width: pct(summary.written_off) }} />
    </div>
  );
}

function Row({ label, value, extra }: { label: string; value: number; extra?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2.5">
        {extra}
        <span className="tabular min-w-6 text-right font-semibold">{value}</span>
      </span>
    </div>
  );
}

function Line({ label, value, strong, muted, tone }: { label: string; value: string; strong?: boolean; muted?: boolean; tone?: "warning" }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tabular", strong ? "font-semibold" : "font-medium", tone === "warning" && "text-warning", muted && "text-muted-foreground")}>
        <Money value={value} />
      </span>
    </div>
  );
}
