"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { ExceptionType, PaymentStatus, RefundPicker } from "@/components/payment-tables";
import { useSession } from "@/components/session";
import { Address, Alert, Badge, BigMoney, Button, ButtonLink, Card, CardBody, Chain, Checks, ChoiceCard, ChoiceGroup, ErrorState, Field, fieldErrors, KV, Money, Mono, PageHeader, Select, SimulatedTag, SkeletonBlock, Stack, StatusLine, Textarea, TextLink, useToast } from "@/components/app-ui";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Card as UICard } from "@/components/ui/card";
import { api, useApi, type ApiError } from "@/lib/api";
import { dateTime, money, timeAgo } from "@/lib/format";

const ACTION_COPY: Record<string, { title: string; desc: string }> = {
  assign: { title: "Assign to an invoice", desc: "Apply this payment to the invoice it belongs to. Balances and webhooks update immediately." },
  dismiss: { title: "Not a customer payment", desc: "Record it as not applied, for example a treasury transfer or funds you returned." },
  acknowledge: { title: "Acknowledge", desc: "Confirm you've handled this outside Setra (refund issued, kept as credit, or waiting for the balance)." },
  write_off: { title: "Write off the remainder", desc: "Mark the invoice as paid and record the unpaid difference as written off." },
  refund: { title: "Refunded", desc: "Link the transfer from your wallet that sent the money back. The refund is recorded with its transaction as proof." }
};

export default function ExceptionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: e, error, mutate } = useApi<any>(`/v1/exceptions/${id}`);
  const { can } = useSession();
  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!e) return <Stack><SkeletonBlock height={160} /><SkeletonBlock height={300} /></Stack>;
  const p = e.payment;

  return (
    <Stack>
      <PageHeader breadcrumbs={[{ label: "Needs review", href: "/app/exceptions" }, { label: e.summary }]} />
      <UICard className="gap-0 py-0">
        <div className="flex flex-wrap items-start justify-between gap-6 p-6 max-md:px-4 max-md:py-5">
          <div className="max-w-[640px] min-w-0">
            <StatusLine>
              <ExceptionType type={e.type} />
              <Badge tone={e.status === "open" ? "warning" : "success"}>{e.status === "open" ? "Open" : "Resolved"}</Badge>
              {p.simulated && <SimulatedTag />}
            </StatusLine>
            <h1 className="text-[1.75rem] leading-tight font-bold tracking-[-0.025em]">{e.summary}</h1>
            <p className="mt-2 text-[0.9375rem] text-muted-foreground">{e.detail}</p>
          </div>
          <div className="text-right">
            <BigMoney value={e.amount} asset={e.asset?.symbol ?? p.asset.symbol} />
            <p className="mt-1.5 text-muted-foreground">Received {timeAgo(p.paid_at)}</p>
          </div>
        </div>
        {e.duplicate_of?.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3 px-6 pb-5 max-md:px-4">
            {e.duplicate_of.map((d: any) => (
              <div key={d.payment_id} className="dup-side grid min-w-0 gap-1 rounded-2xl bg-muted px-[18px] py-4">
                <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">Original payment {d.simulated && <SimulatedTag />}</span>
                <strong className="font-semibold">{d.invoice.customer_name}</strong>
                <span className="text-[0.9375rem] font-semibold tracking-[-0.015em]">{d.invoice.title ?? `Invoice ${d.invoice.number}`}</span>
                <span className="text-muted-foreground">
                  <TextLink mono href={`/app/invoices/${d.invoice.id}`}>{d.invoice.number}</TextLink> · <Money value={d.amount} /> {p.asset.symbol} ·{" "}
                  <TextLink href={`/app/payments/${d.payment_id}`}>paid {timeAgo(d.paid_at)}</TextLink>
                </span>
              </div>
            ))}
            <div className="dup-side grid min-w-0 gap-1 rounded-2xl bg-muted px-[18px] py-4">
              <span className="text-sm font-medium text-muted-foreground">This payment</span>
              <strong className="font-semibold">{p.customer?.name ?? "Unknown sender"}</strong>
              <span className="text-[0.9375rem] text-muted-foreground italic">Not applied</span>
              <span className="text-muted-foreground">
                <Money value={p.amount} /> {p.asset.symbol} · needs review
              </span>
            </div>
          </div>
        )}
        {e.status === "open" && e.recommended_action && (
          <div className="px-6 pb-5 max-md:px-4">
            <Alert tone="neutral" title="Recommended">
              {e.recommended_action}
            </Alert>
          </div>
        )}
      </UICard>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px] [&>*]:min-w-0">
        <Stack>
          <Card
            title="The payment"
            actions={
              <ButtonLink href={`/app/payments/${p.id}`} variant="ghost" size="sm">
                Full evidence <ArrowRight aria-hidden="true" />
              </ButtonLink>
            }
          >
            <CardBody className="py-1">
              <KV
                items={[
                  ["Status", <PaymentStatus key="s" status={p.status} />],
                  [
                    "For",
                    p.business_object ? (
                      <TextLink key="for" href={`/app/invoices/${p.business_object.id}`}>{p.business_object.title ?? p.business_object.number}</TextLink>
                    ) : (
                      <span key="for" className="text-muted-foreground italic">Purpose unknown</span>
                    )
                  ],
                  ["From", <Address key="f" value={p.sender} full />],
                  ["To", <span key="t" className="flex flex-wrap items-center gap-2">{p.wallet.name} <Address value={p.recipient} /></span>],
                  ["Network", <Chain key="n" network={p.network} name={p.network_name} />],
                  ["Asset", p.asset.symbol ?? <span key="a" className="flex items-center gap-1.5">Unknown token <Address value={p.asset.address} /></span>],
                  ["Received", dateTime(p.paid_at)],
                  ["Transaction", p.simulated ? <span key="tx" className="text-muted-foreground">Simulated, no onchain transaction</span> : <Address key="tx" value={p.transaction_hash} href={p.explorer_url} />]
                ]}
              />
            </CardBody>
          </Card>

          {p.decision && (
            <Card
              title="What Setra checked"
              description={p.decision.explanation}
              actions={
                <Badge tone="neutral" dot={false} className="rounded-md font-mono">
                  {p.decision.rule_version}
                </Badge>
              }
            >
              <CardBody className="py-2">
                <Checks checks={p.decision.checks} />
              </CardBody>
            </Card>
          )}

          {e.candidates.length > 0 && (
            <Card title="Possible matches" description="Invoices that could plausibly own this payment, and why.">
              <ul>
                {e.candidates.map((c: any) => (
                  <li key={c.invoice_id} className="flex items-center justify-between gap-4 border-t px-6 py-3.5 first:border-t-0 max-md:px-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <TextLink mono href={`/app/invoices/${c.invoice_id}`}>
                          {c.number}
                        </TextLink>
                        <span className="text-muted-foreground">{c.customer_name}</span>
                      </div>
                      {c.title && <div className="mt-0.5 font-medium">{c.title}</div>}
                      <div className="mt-0.5 text-sm text-muted-foreground">{c.reasons.join(" · ")}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs text-muted-foreground">Remaining</div>
                      <Money value={c.amount_remaining} />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </Stack>

        <Stack>
          {e.status === "open" ? (
            can("exceptions:resolve") ? (
              <ResolveForm exception={e} onDone={() => mutate()} />
            ) : (
              <Card padded title="Resolve">
                <p className="text-muted-foreground">Your role can view exceptions but not resolve them. Ask an owner, admin or operator.</p>
              </Card>
            )
          ) : (
            <ResolutionSummary resolution={e.resolution} />
          )}
        </Stack>
      </div>
    </Stack>
  );
}

function ResolveForm({ exception: e, onDone }: { exception: any; onDone: () => void }) {
  const toast = useToast();
  const [action, setAction] = useState<string>(e.allowed_actions[0]);
  const [invoiceId, setInvoiceId] = useState<string>(e.candidates[0]?.invoice_id ?? "");
  const [transferId, setTransferId] = useState<string>(e.refund_candidates?.[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [remember, setRemember] = useState(e.type === "unknown_payment" || e.type === "ambiguous_match");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => setError(null), [action]);
  const errs = fieldErrors(error);
  const candidateIds = new Set(e.candidates.map((c: any) => c.invoice_id));
  const others = e.assignable_invoices.filter((i: any) => !candidateIds.has(i.id));

  return (
    <Card title="Resolve" description="Your decision, reason and name are recorded permanently.">
      <form
        className="grid gap-4 px-6 py-5 max-md:px-4"
        onSubmit={async (ev) => {
          ev.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api(`/v1/exceptions/${e.id}/resolve`, {
              method: "POST",
              body: { action, invoice_id: action === "assign" ? invoiceId : undefined, outgoing_transfer_id: action === "refund" ? transferId : undefined, reason, remember_sender: action === "assign" && remember }
            });
            toast("success", "Resolved. The payment record and history are updated.");
            onDone();
          } catch (err) {
            setError(err as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && !error.details && <Alert tone="danger">{error.message}</Alert>}
        <ChoiceGroup label="Resolution" value={action} onChange={setAction}>
          {e.allowed_actions.map((a: string) => (
            <ChoiceCard key={a} id={`action-${a}`} value={a} selected={action === a} title={ACTION_COPY[a]?.title ?? a} description={ACTION_COPY[a]?.desc} />
          ))}
        </ChoiceGroup>
        {action === "assign" && (
          <>
            <Field label="Invoice" htmlFor="invoice" error={errs.invoice_id}>
              <Select
                id="invoice"
                value={invoiceId}
                onValueChange={setInvoiceId}
                required
                placeholder="Choose an invoice…"
                options={[
                  { group: "Possible matches", options: e.candidates.map((c: any) => ({ value: c.invoice_id, label: `${c.number}${c.title ? `, ${c.title}` : ""} · ${c.customer_name} · ${money(c.amount_remaining)} remaining` })) },
                  { group: "Other open invoices", options: others.map((i: any) => ({ value: i.id, label: `${i.number}${i.title ? `, ${i.title}` : ""} · ${i.customer_name} · ${money(i.amount_remaining)} remaining` })) }
                ]}
              />
            </Field>
            {!e.customer && (
              <div className="flex items-start gap-2.5">
                <Checkbox id="remember" checked={remember} onCheckedChange={(v) => setRemember(v === true)} className="mt-0.5" />
                <Label htmlFor="remember" className="grid gap-0.5 leading-normal font-normal">
                  Remember this sender for the invoice&rsquo;s customer
                  <span className="text-xs text-muted-foreground">Future payments from {e.payment.sender.slice(0, 8)}… will be recognized automatically.</span>
                  <span className="text-xs text-muted-foreground">Leave this off if the money came from an exchange: many people pay from the same exchange address.</span>
                </Label>
              </div>
            )}
          </>
        )}
        {action === "refund" && (
          <Field label="Refund transfer" error={errs.outgoing_transfer_id}>
            <RefundPicker candidates={e.refund_candidates ?? []} value={transferId} onChange={setTransferId} payer={e.payment.sender} />
          </Field>
        )}
        <Field label="Reason" htmlFor="reason" hint="Visible in the audit trail. For example: “Customer confirmed by email on Oct 3.”" error={errs.reason}>
          <Textarea id="reason" required minLength={3} value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="Why is this the right decision?" invalid={!!errs.reason} />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={(action === "assign" && !invoiceId) || (action === "refund" && !transferId)}>
          {action === "assign" ? "Assign payment" : action === "refund" ? "Record refund" : action === "write_off" ? "Write off remainder" : action === "dismiss" ? "Mark as not applied" : "Acknowledge"}
        </Button>
      </form>
    </Card>
  );
}

function ResolutionSummary({ resolution: r }: { resolution: any }) {
  if (!r) return null;
  return (
    <Card title="Resolution">
      <CardBody className="py-1">
        <KV
          items={[
            ["Decision", <span key="d" className="flex items-center gap-1.5"><CheckCircle2 className="size-[15px] text-success" /> {ACTION_COPY[r.action]?.title ?? r.action}</span>],
            ["By", r.actor.type === "system" ? "Setra (automatic)" : (r.actor.label ?? r.actor.type)],
            ["When", dateTime(r.created_at)],
            ["Reason", <span key="r" className="whitespace-pre-wrap">{r.reason}</span>],
            ["Before", <span key="b" className="text-sm text-muted-foreground">Payment {r.previous_state?.payment_status?.replace("_", " ") ?? "-"}</span>],
            ["After", <span key="a" className="text-sm text-muted-foreground">Payment {r.new_state?.payment_status?.replace("_", " ") ?? "-"}{r.new_state?.invoice ? ` · ${r.new_state.invoice.number} ${r.new_state.invoice.status.replace("_", " ")}` : ""}</span>],
            ["Rule", <Mono key="rv">{r.rule_version}</Mono>]
          ]}
        />
      </CardBody>
    </Card>
  );
}
