"use client";

import { InvoiceCreditNotes } from "@/components/customer-credits";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Ban, BookMarked, CircleDot, ExternalLink, FlaskConical, Link2, Receipt, Send } from "lucide-react";
import { ExceptionType, InvoiceStatus, PaymentStatus } from "@/components/payment-tables";
import { useSession } from "@/components/session";
import { Address, Alert, Badge, BigMoney, Button, ButtonLink, Card, CardBody, Chain, CopyButton, DetailGrid, DetailHero, EmptyState, ErrorState, Field, HeroMeta, Input, KV, LineItems, Modal, Money, Mono, Muted, PageHeader, PurposeBlock, SectionTitle, SimulatedTag, SkeletonBlock, Spinner, Stack, StatusLine, Textarea, TextLink, Timeline, useToast } from "@/components/app-ui";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { api, useApi, type ApiError } from "@/lib/api";
import { dateShort, dateTime, ratio, timeAgo, money } from "@/lib/format";
import { eventLabel } from "@/lib/status";

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, isTest } = useSession();
  const toast = useToast();
  const { data: inv, error, mutate } = useApi<any>(`/v1/invoices/${id}`, { refreshInterval: (d) => (d && ["open", "partially_paid"].includes(d.status) ? 2500 : 15000) });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [simulating, setSimulating] = useState<string | null>(null);

  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!inv) return <Stack><SkeletonBlock height={40} /><SkeletonBlock height={200} /><SkeletonBlock height={280} /></Stack>;

  const open = inv.status === "open" || inv.status === "partially_paid";
  const pct = ratio(inv.amount_paid, inv.amount_due);
  const simulate = async (scenario: string) => {
    setSimulating(scenario);
    try {
      await api("/v1/test/payments", { method: "POST", body: { scenario, invoice_id: inv.id } });
      await mutate();
      toast("success", "Simulated payment sent through the pipeline.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSimulating(null);
    }
  };

  return (
    <Stack>
      <PageHeader breadcrumbs={[{ label: "Invoices", href: "/app/invoices" }, { label: inv.number }]} />
      <DetailHero
        actions={
          <>
            {open && can("invoices:write") && (
              <Button variant="primary" icon={<Send />} onClick={() => setSendOpen(true)}>
                Send to customer
              </Button>
            )}
            <ButtonLink href={inv.payment_url} target="_blank" rel="noreferrer" icon={<ExternalLink aria-hidden="true" />}>
              Open payment page
            </ButtonLink>
            {can("financials:read") && (
              <ButtonLink href={`/app/accounting/ledger?invoice_id=${inv.id}&preset=all`} icon={<BookMarked aria-hidden="true" />}>
                In the books
              </ButtonLink>
            )}
            {can("invoices:write") && inv.status === "open" && (
              <Button variant="danger" icon={<Ban />} onClick={() => setCancelOpen(true)}>
                Cancel
              </Button>
            )}
          </>
        }
        below={
          <>
            <Progress
              value={Math.round(Math.min(pct, 1) * 100)}
              aria-label="Amount paid"
              className={cn("h-1.5 bg-muted", inv.status === "overpaid" ? "[&>div]:bg-primary" : inv.status === "partially_paid" ? "[&>div]:bg-warning" : "[&>div]:bg-success")}
            />
            <div className="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
              <span>
                <Money value={inv.amount_paid} /> paid
                {inv.amount_written_off !== "0.00" && (
                  <>
                    {" "}
                    · <Money value={inv.amount_written_off} /> written off
                  </>
                )}
              </span>
              <span>
                {inv.status === "overpaid" ? (
                  <>
                    <Money value={inv.amount_overpaid} sign /> over
                  </>
                ) : (
                  <>
                    <Money value={inv.amount_remaining} /> remaining
                  </>
                )}
              </span>
            </div>
            {inv.amount_confirming !== "0.00" && (
              <div className="flex gap-3 rounded-xl bg-info/10 px-4 py-3 text-sm" role="status">
                <Spinner className="mt-0.5 text-info" />
                <div className="grid gap-0.5">
                  <strong className="font-semibold">
                    Payment detected: <Money value={inv.amount_confirming} /> confirming
                  </strong>
                  <span className="text-foreground/80">Seen on {inv.network_name}. It will be applied as soon as the block is final.</span>
                </div>
              </div>
            )}
          </>
        }
      >
        <StatusLine eyebrow={<Mono>{inv.number}</Mono>}>
          <InvoiceStatus status={inv.status} confirming={inv.amount_confirming} />
        </StatusLine>
        <h1 className="sr-only">
          Invoice {inv.number}
          {inv.title ? `: ${inv.title}` : ""}
        </h1>
        <BigMoney value={inv.amount_due} asset={inv.asset?.symbol} />
        <div className="mt-2.5 text-[0.9375rem] font-semibold">
          <TextLink href={`/app/customers/${inv.customer.id}`}>{inv.customer.name}</TextLink>
        </div>
        <PurposeBlock className="hero-purpose mt-2.5" title={inv.title ?? <span className="font-normal text-muted-foreground italic">No purpose recorded</span>} />
        {inv.purpose && <p className="mt-0.5 text-muted-foreground">{inv.purpose}</p>}
        <HeroMeta>
          <Chain network={inv.network} name={inv.network_name} />
          {inv.due_at && <span>Due {dateShort(inv.due_at)}</span>}
          {inv.last_sent_at && (
            <span title={dateTime(inv.last_sent_at)}>
              Sent to {inv.last_sent_to} {timeAgo(inv.last_sent_at)}
            </span>
          )}
        </HeroMeta>
      </DetailHero>

      <DetailGrid>
        <Stack>
          {inv.line_items.length > 0 && (
            <Card title="Items">
              <CardBody className="pt-0">
                <LineItems className="mt-0 border-t-0" items={inv.line_items.map((li: any) => ({ ...li, description: li.quantity > 1 ? `${li.description} (at ${money(li.unit_amount)})` : li.description }))} total={inv.amount_due} />
              </CardBody>
            </Card>
          )}
          <Card title="Payments" description="Money applied to this invoice, with the transaction behind each.">
            {inv.payments.length === 0 ? (
              <EmptyState icon={<Receipt />} mascot={open ? "resting" : undefined} title={open ? "Waiting for payment" : "No payments"}>
                {open ? "Share the payment link. Setra detects the payment on Monad within about a second and applies it once final." : "No payments were applied to this invoice."}
              </EmptyState>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="max-md:hidden">From</TableHead>
                    <TableHead className="max-md:hidden">Transaction</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inv.payments.map((p: any) => (
                    <TableRow key={p.id} className="cursor-pointer" onClick={() => (window.location.href = `/app/payments/${p.id}`)}>
                      <TableCell className="w-px">
                        <PaymentStatus status={p.status} />
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        <Money value={p.amount} asset={p.asset.symbol} />
                      </TableCell>
                      <TableCell className="max-md:hidden">
                        <Address value={p.sender} copy={false} />
                      </TableCell>
                      <TableCell className="max-md:hidden">{p.simulated ? <SimulatedTag /> : <Address value={p.transaction_hash} href={p.explorer_url} copy={false} />}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{timeAgo(p.paid_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <InvoiceCreditNotes invoice={inv} onChange={() => mutate()} />

          {inv.allocations.length > 0 && (
            <Card title="Reconciliation" description="The allocation ledger. Reversals are recorded as compensating entries, nothing is overwritten.">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Entry</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Recorded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inv.allocations.map((a: any) => (
                    <TableRow key={a.id}>
                      <TableCell>{a.kind === "automatic" ? "Matched automatically" : a.kind === "manual" ? "Assigned by operator" : "Reversal"}</TableCell>
                      <TableCell>
                        <TextLink mono href={`/app/payments/${a.payment_id}`} className="text-xs">
                          {a.payment_id.slice(0, 12)}…
                        </TextLink>
                      </TableCell>
                      <TableCell className={cn("text-right font-semibold", a.kind === "reversal" && "text-destructive")}>
                        <Money value={a.amount} sign={a.kind !== "reversal"} />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">{dateTime(a.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}

          {inv.exceptions.length > 0 && (
            <Card title="Exceptions">
              <ul>
                {inv.exceptions.map((e: any) => (
                  <li key={e.id} className="border-t first:border-t-0">
                    <Link href={`/app/exceptions/${e.id}`} className="flex items-center justify-between gap-4 px-6 py-3.5 transition-colors hover:bg-muted/40 max-md:px-4">
                      <span className="flex flex-wrap items-center gap-2.5">
                        <ExceptionType type={e.type} />
                        <span>{e.summary}</span>
                      </span>
                      <Muted as="span">{e.status === "open" ? "Open" : "Resolved"}</Muted>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </Stack>

        <Stack>
          <Card title="Payment link" description="Send this to your customer. It shows only what they need to pay.">
            <CardBody className="grid gap-3">
              <div className="flex min-w-0 items-center gap-1.5 rounded-[10px] bg-muted py-1.5 pr-2 pl-3">
                <Link2 className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{inv.payment_url}</span>
                <CopyButton value={inv.payment_url} label="Copy payment link" />
              </div>
              {isTest && open && can("simulate") && (
                <div className="mt-1.5 grid gap-3">
                  <SectionTitle className="flex items-center gap-1.5">
                    <FlaskConical className="size-3" aria-hidden="true" /> Test mode
                  </SectionTitle>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" loading={simulating === "exact"} onClick={() => simulate("exact")}>
                      Simulate exact
                    </Button>
                    <Button size="sm" loading={simulating === "partial"} onClick={() => simulate("partial")}>
                      Partial
                    </Button>
                    <Button size="sm" loading={simulating === "overpaid"} onClick={() => simulate("overpaid")}>
                      Overpay
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">Partial and overpayments are matched automatically only when the sender is a known customer wallet, just like real payments.</p>
                </div>
              )}
            </CardBody>
          </Card>
          <Card title="Details">
            <CardBody className="py-1">
              <KV
                items={[
                  ["Customer", <TextLink key="c" href={`/app/customers/${inv.customer.id}`}>{inv.customer.name}</TextLink>],
                  ["Currency", inv.currency],
                  ["Pay with", `${inv.asset?.symbol} on ${inv.network_name}`],
                  ["Wallet", <Address key="w" value={inv.receiving_address} />],
                  ["Issued", dateShort(inv.issued_at)],
                  ["Due", dateShort(inv.due_at)],
                  ["Expires", inv.expires_at ? dateShort(inv.expires_at) : "Never"],
                  inv.paid_at && ["Paid", dateTime(inv.paid_at)],
                  inv.cancelled_at && ["Cancelled", `${dateShort(inv.cancelled_at)}${inv.cancel_reason ? `, ${inv.cancel_reason}` : ""}`],
                  ["ID", <span key="id" className="flex items-center gap-1 font-mono text-xs">{inv.id}<CopyButton value={inv.id} /></span>]
                ]}
              />
            </CardBody>
          </Card>
          {inv.payment_intents.length > 0 && (
            <Card title="Payment intents">
              <CardBody className="grid gap-3">
                {inv.payment_intents.map((pi: any) => (
                  <div key={pi.id} className="flex items-center justify-between gap-3">
                    <Address value={pi.intent_id} />
                    <Badge>{pi.status}</Badge>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}
          <Card title="Activity">
            <CardBody>
              <Timeline
                items={inv.timeline.map((t: any) => ({
                  title: t.kind === "event" ? eventLabel[t.action] ?? t.action : t.action.replace(/_/g, " ").replace(/^\w/, (c: string) => c.toUpperCase()),
                  meta: `${t.kind === "audit" ? t.actor : "Setra"} · ${timeAgo(t.at)}`,
                  tone: t.kind === "event" ? (t.action === "PAYMENT_REVERSED" ? "danger" : t.action === "UNKNOWN_PAYMENT" ? "warning" : "success") : undefined,
                  icon: <CircleDot />
                }))}
              />
            </CardBody>
          </Card>
        </Stack>
      </DetailGrid>

      <CancelModal open={cancelOpen} onClose={() => setCancelOpen(false)} invoice={inv} onDone={() => mutate()} />
      {sendOpen && (
        <SendDialog
          invoice={inv}
          onClose={() => setSendOpen(false)}
          onSent={async (r) => {
            setSendOpen(false);
            await mutate();
            toast(r.delivered ? "success" : "info", r.delivered ? `Payment request sent to ${r.to}.` : `Recorded as sent to ${r.to}. ${r.note}`);
          }}
        />
      )}
    </Stack>
  );
}

function CancelModal({ open, onClose, invoice, onDone }: { open: boolean; onClose: () => void; invoice: any; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Cancel ${invoice.number}?`}
      description="The payment link stops accepting payment. Any payment that still arrives is flagged for review, never applied automatically."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep invoice
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api(`/v1/invoices/${invoice.id}/cancel`, { method: "POST", body: { reason: reason || undefined } });
                toast("success", `${invoice.number} cancelled.`);
                onDone();
                onClose();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Cancel invoice
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
      <Field label="Reason" htmlFor="cancel-reason" optional>
        <Textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Issued twice by mistake" />
      </Field>
    </Modal>
  );
}

/** Email the payment request (title, items, amount and link) to the customer. */
function SendDialog({ invoice, onClose, onSent }: { invoice: any; onClose: () => void; onSent: (result: any) => void }) {
  const [to, setTo] = useState(invoice.customer.email ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Modal
      open
      onClose={onClose}
      title="Send payment request"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!/^\S+@\S+\.\S+$/.test(to.trim())}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                onSent(await api(`/v1/invoices/${invoice.id}/send`, { method: "POST", body: { to: to.trim(), message: message.trim() || undefined } }));
              } catch (e) {
                setError(e as ApiError);
                setBusy(false);
              }
            }}
          >
            Send
          </Button>
        </>
      }
    >
      <Stack gap={4}>
        {error && <Alert tone="danger">{error.message}</Alert>}
        <Field label="To" htmlFor="send-to">
          <Input id="send-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="ap@customer.com" />
        </Field>
        <Field label="Message" htmlFor="send-msg" optional>
          <Textarea id="send-msg" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Thanks for your business." />
        </Field>
        <div className="text-sm text-muted-foreground">
          The email says what the payment is for ({invoice.title ?? invoice.number}), lists the items, the amount due ({money(invoice.amount_remaining)} {invoice.asset?.symbol}) and links to the payment page.
        </div>
      </Stack>
    </Modal>
  );
}
