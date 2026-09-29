"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowDownLeft, Inbox, Receipt } from "lucide-react";
import { dateShort, timeAgo } from "@/lib/format";
import { exceptionLabel, exceptionTone, invoiceLabel, invoiceTone, paymentLabel, paymentTone } from "@/lib/status";
import { cn } from "@/lib/utils";
import { RadioGroup } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Address, Badge, Chain, ChoiceCard, EmptyState, Money, Mono, SimulatedTag } from "./app-ui";
import { AnimatePresence, motion } from "./motion";

/** A status that changes in place (e.g. Confirming → Paid) swaps with a small spring, so the moment registers. */
function Swap({ id, children }: { id: string; children: ReactNode }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={id} className="inline-flex" initial={{ opacity: 0, scale: 0.7, y: 4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.85 }} transition={{ type: "spring", stiffness: 420, damping: 24 }}>
        {children}
      </motion.span>
    </AnimatePresence>
  );
}

export function PaymentStatus({ status }: { status: string }) {
  return (
    <Swap id={status}>
      <Badge tone={paymentTone[status] ?? "neutral"} pulse={status === "confirming"}>
        {paymentLabel(status)}
      </Badge>
    </Swap>
  );
}

export function InvoiceStatus({ status, confirming }: { status: string; confirming?: string | null }) {
  if (confirming && confirming !== "0.00" && (status === "open" || status === "partially_paid")) {
    return (
      <Swap id="detected">
        <Badge tone="info" pulse>
          Payment detected
        </Badge>
      </Swap>
    );
  }
  return (
    <Swap id={status}>
      <Badge tone={invoiceTone[status] ?? "neutral"}>{invoiceLabel(status)}</Badge>
    </Swap>
  );
}

export function ExceptionType({ type }: { type: string }) {
  return <Badge tone={exceptionTone[type] ?? "warning"}>{exceptionLabel(type)}</Badge>;
}

export interface PaymentRow {
  id: string;
  status: string;
  amount: string;
  asset: { symbol: string | null };
  network: string;
  network_name: string;
  customer: { id: string; name?: string } | null;
  invoice: { id: string; number?: string } | null;
  business_object?: { id: string; number: string | null; title: string | null } | null;
  purpose_status?: "known" | "provisional" | "unknown";
  sender: string;
  transaction_hash: string;
  paid_at: string;
  simulated: boolean;
}

export function PaymentsTable({ rows, empty, compact = false }: { rows: PaymentRow[]; empty?: ReactNode; compact?: boolean }) {
  const router = useRouter();
  if (!rows.length)
    return (
      <>
        {empty ?? (
          <EmptyState icon={<ArrowDownLeft />} title="No payments yet">
            Payments appear here the moment they reach one of your receiving wallets.
          </EmptyState>
        )}
      </>
    );
  const go = (id: string) => router.push(`/app/payments/${id}`);
  return (
    <>
      <Table className="max-md:hidden">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Customer</TableHead>
            <TableHead scope="col" className="text-right">
              Amount
            </TableHead>
            {!compact && <TableHead scope="col">Network</TableHead>}
            <TableHead scope="col">Invoice</TableHead>
            {!compact && <TableHead scope="col">From</TableHead>}
            <TableHead scope="col" className="text-right">
              Time
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => (
            <TableRow
              key={p.id}
              className="cursor-pointer focus-visible:bg-primary/8 focus-visible:outline-none"
              tabIndex={0}
              onClick={() => go(p.id)}
              onKeyDown={(e) => e.key === "Enter" && go(p.id)}
              aria-label={`Payment of ${p.amount} ${p.asset.symbol ?? ""}`}
            >
              <TableCell className="w-px">
                <PaymentStatus status={p.status} />
              </TableCell>
              <TableCell className="max-w-[340px] min-w-0 whitespace-normal">
                <span className="font-medium">{p.customer?.name ?? <span className="text-muted-foreground">Unknown sender</span>}</span>
                {p.simulated && (
                  <span className="ml-2">
                    <SimulatedTag />
                  </span>
                )}
                <PurposeLine row={p} />
              </TableCell>
              <TableCell className="text-right font-semibold">
                <Money value={p.amount} asset={p.asset.symbol ?? "?"} />
              </TableCell>
              {!compact && (
                <TableCell>
                  <Chain network={p.network} name={p.network_name} />
                </TableCell>
              )}
              <TableCell>{p.business_object?.number ? <Mono>{p.business_object.number}</Mono> : <span className="text-muted-foreground">-</span>}</TableCell>
              {!compact && (
                <TableCell>
                  <Address value={p.sender} copy={false} />
                </TableCell>
              )}
              <TableCell className="text-right text-muted-foreground" title={new Date(p.paid_at).toLocaleString()}>
                {timeAgo(p.paid_at)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul className="md:hidden">
        {rows.map((p) => (
          <MobileRow
            key={p.id}
            href={`/app/payments/${p.id}`}
            title={
              <>
                {p.customer?.name ?? <span className="text-muted-foreground">Unknown sender</span>}
                {p.simulated && (
                  <span className="ml-2">
                    <SimulatedTag />
                  </span>
                )}
              </>
            }
            sub={<PurposeLine row={p} />}
            amount={<Money value={p.amount} asset={p.asset.symbol ?? "?"} />}
            status={<PaymentStatus status={p.status} />}
            time={timeAgo(p.paid_at)}
          />
        ))}
      </ul>
    </>
  );
}

/** Two-line row for phones: who + amount, then status + time. */
function MobileRow({ href, title, sub, amount, status, time }: { href: string; title: ReactNode; sub?: ReactNode; amount: ReactNode; status: ReactNode; time: ReactNode }) {
  return (
    <li className="border-b last:border-b-0">
      <Link href={href} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 active:bg-muted/50">
        <span className="min-w-0">
          <span className="font-medium">{title}</span>
          {sub}
        </span>
        <span className="text-right font-semibold">{amount}</span>
        <span>{status}</span>
        <span className="text-right text-sm text-muted-foreground">{time}</span>
      </Link>
    </li>
  );
}

/** One quiet line saying what a payment is for, or honestly that it isn't known. */
function PurposeLine({ row }: { row: PaymentRow }) {
  const b = row.business_object;
  if (b) {
    return (
      <span className={purposeCls} title={b.title ?? undefined}>
        {b.title ?? `Invoice ${b.number}`}
        {row.purpose_status === "provisional" && <span> · confirming</span>}
      </span>
    );
  }
  if (row.status === "confirming") return <span className={purposeCls}>Identifying…</span>;
  return <span className={cn(purposeCls, "italic")}>Purpose unknown</span>;
}

const purposeCls = "block max-w-full truncate text-xs text-muted-foreground";

export interface InvoiceRow {
  id: string;
  number: string;
  title?: string | null;
  status: string;
  customer: { id: string; name?: string };
  amount_due: string;
  amount_paid: string;
  amount_remaining: string;
  amount_confirming: string;
  asset: { symbol: string } | null;
  network: string;
  network_name: string;
  due_at: string | null;
  created_at: string;
}

export function InvoicesTable({ rows, empty }: { rows: InvoiceRow[]; empty?: ReactNode }) {
  const router = useRouter();
  if (!rows.length)
    return (
      <>
        {empty ?? (
          <EmptyState icon={<Receipt />} title="No invoices">
            Create an invoice to generate a hosted payment page your customer can pay in USDC on Monad.
          </EmptyState>
        )}
      </>
    );
  const go = (id: string) => router.push(`/app/invoices/${id}`);
  const remaining = (i: InvoiceRow) => (i.status === "cancelled" ? <span className="text-muted-foreground">-</span> : <Money value={i.amount_remaining} muted={i.amount_remaining === "0.00"} />);
  return (
    <>
      <Table className="max-md:hidden">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col">Invoice</TableHead>
            <TableHead scope="col">Customer</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col" className="text-right">
              Amount
            </TableHead>
            <TableHead scope="col" className="text-right">
              Remaining
            </TableHead>
            <TableHead scope="col">Network</TableHead>
            <TableHead scope="col" className="text-right">
              Due
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((i) => (
            <TableRow key={i.id} className="cursor-pointer focus-visible:bg-primary/8 focus-visible:outline-none" tabIndex={0} onClick={() => go(i.id)} onKeyDown={(e) => e.key === "Enter" && go(i.id)}>
              <TableCell className="max-w-[340px] min-w-0 whitespace-normal">
                <Mono className="font-medium">{i.number}</Mono>
                {i.title && (
                  <span className={purposeCls} title={i.title}>
                    {i.title}
                  </span>
                )}
              </TableCell>
              <TableCell>{i.customer.name}</TableCell>
              <TableCell className="w-px">
                <InvoiceStatus status={i.status} confirming={i.amount_confirming} />
              </TableCell>
              <TableCell className="text-right font-semibold">
                <Money value={i.amount_due} />
              </TableCell>
              <TableCell className="text-right font-semibold">{remaining(i)}</TableCell>
              <TableCell>
                <Chain network={i.network} name={i.network_name} />
              </TableCell>
              <TableCell className="text-right text-muted-foreground">{dateShort(i.due_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul className="md:hidden">
        {rows.map((i) => (
          <MobileRow
            key={i.id}
            href={`/app/invoices/${i.id}`}
            title={
              <>
                <Mono>{i.number}</Mono> <span className="ml-1 font-normal text-muted-foreground">{i.customer.name}</span>
              </>
            }
            sub={i.title ? <span className={purposeCls}>{i.title}</span> : undefined}
            amount={<Money value={i.amount_due} />}
            status={<InvoiceStatus status={i.status} confirming={i.amount_confirming} />}
            time={dateShort(i.due_at)}
          />
        ))}
      </ul>
    </>
  );
}

export interface ExceptionRow {
  id: string;
  type: string;
  status: string;
  summary: string;
  detail: string;
  amount: string;
  asset: { symbol: string } | null;
  customer: { id: string; name?: string } | null;
  invoice: { id: string; number?: string; title?: string | null } | null;
  created_at: string;
}

export function ExceptionsList({ rows, empty }: { rows: ExceptionRow[]; empty?: ReactNode }) {
  if (!rows.length)
    return (
      <>
        {empty ?? (
          <EmptyState icon={<Inbox />} title="Nothing needs attention" mascot="resting">
            When a payment can&rsquo;t be matched safely (unknown sender, partial, overpaid, wrong token), it lands here with the evidence you need to decide.
          </EmptyState>
        )}
      </>
    );
  return (
    <ul>
      {rows.map((e) => (
        <li key={e.id} className="border-t first:border-t-0">
          <Link href={`/app/exceptions/${e.id}`} className="flex items-center justify-between gap-4 px-6 py-3.5 transition-colors hover:bg-muted/40 max-md:px-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <ExceptionType type={e.type} />
                <span className="font-semibold">{e.summary}</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {e.customer?.name ? `${e.customer.name} · ` : ""}
                {e.invoice?.number ? `${e.invoice.number}${e.invoice.title ? `, ${e.invoice.title}` : ""} · ` : "Purpose unknown · "}
                {timeAgo(e.created_at)}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <div className="font-semibold">
                <Money value={e.amount} />
              </div>
              <div className="text-xs text-muted-foreground">{e.status === "open" ? "Review →" : "Resolved"}</div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function SyncBadge({ sync }: { sync: any }) {
  if (!sync) return null;
  const tone = sync.status === "live" || sync.status === "backfilling" ? "success" : sync.status === "paused" || sync.status === "starting" ? "neutral" : "warning";
  const label = { live: "Monitoring", backfilling: "Monitoring · backfilling", starting: "Starting", delayed: "Delayed", error: "Provider error", paused: "Paused", unavailable: "Unavailable" }[sync.status as string] ?? sync.status;
  return (
    <span title={sync.message}>
      <Badge tone={tone} pulse={sync.status === "live" || sync.status === "backfilling" || sync.status === "starting"}>
        {label}
      </Badge>
    </span>
  );
}


export interface OutgoingTransferRow {
  id: string;
  amount: string;
  asset: string | null;
  to: string;
  transaction_hash: string;
  block_number: string;
  explorer_url: string | null;
  sent_at: string;
}

/**
 * Choose the outgoing transfer that sent a payment's money back. Only transfers Setra has seen in
 * finalized blocks from the receiving wallet appear; the payer's address is marked.
 */
export function RefundPicker({ candidates, value, onChange, payer }: { candidates: OutgoingTransferRow[]; value: string; onChange: (id: string) => void; payer: string }) {
  if (!candidates.length) {
    return <p className="text-sm text-muted-foreground">No outgoing transfer from this wallet yet. Send the refund from your wallet; it appears here once its block is final (about a second on Monad).</p>;
  }
  return (
    <RadioGroup value={value} onValueChange={onChange} aria-label="Refund transfer" className="gap-2.5">
      {candidates.map((c) => (
        <ChoiceCard
          key={c.id}
          id={`refund-${c.id}`}
          value={c.id}
          selected={value === c.id}
          title={
            <>
              <Money value={c.amount} /> {c.asset ?? ""} to {c.to === payer ? "the payer" : <Address value={c.to} copy={false} />}
            </>
          }
          description={
            <>
              {timeAgo(c.sent_at)} · block {Number(c.block_number).toLocaleString()} · <Mono>{c.transaction_hash.slice(0, 10)}…</Mono>
            </>
          }
        />
      ))}
    </RadioGroup>
  );
}
