"use client";

import { PaymentCredit } from "@/components/customer-credits";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, ArrowLeftRight, ArrowRight, BookMarked, CheckCircle2, CircleDot, CornerUpLeft, ExternalLink, FileSignature, GitBranch, Radio, RotateCcw, ShieldCheck, Undo2 } from "lucide-react";
import { ExceptionType, InvoiceStatus, PaymentStatus, RefundPicker } from "@/components/payment-tables";
import { useSession } from "@/components/session";
import { Address, Alert, Badge, BigMoney, Button, ButtonLink, Card, CardBody, Chain, Checks, ChoiceCard, ChoiceGroup, CopyButton, DetailGrid, DetailHero, ErrorState, Field, fieldErrors, HeroMeta, KV, LineItems, Modal, Money, Mono, Muted, PageHeader, PurposeBlock, SectionTitle, Select, SimulatedTag, SkeletonBlock, Spinner, Stack, StatusLine, Textarea, TextLink, Timeline, useToast } from "@/components/app-ui";
import { api, useApi, type ApiError } from "@/lib/api";
import { dateTime, money, shortAddress, timeAgo, tokenAmount } from "@/lib/format";
import { eventLabel } from "@/lib/status";

const HEADLINE: Record<string, string> = {
  confirming: "Payment detected",
  matched: "Payment matched",
  partial: "Partial payment",
  overpaid: "Overpayment",
  needs_review: "Needs review",
  reversed: "Payment reversed",
  dismissed: "Not applied",
  refunded: "Refunded to the sender"
};

export default function PaymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isTest, can } = useSession();
  const toast = useToast();
  const { data: p, error, mutate } = useApi<any>(`/v1/payments/${id}`, { refreshInterval: (d) => (d?.status === "confirming" ? 1500 : 10000) });
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"correct" | "refund" | null>(null);

  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!p) return <Stack><SkeletonBlock height={40} /><SkeletonBlock height={180} /><SkeletonBlock height={320} /></Stack>;

  const openException = p.exceptions.find((e: any) => e.status === "open");
  const intent = p.payment_intent;
  const test = async (action: "confirm" | "reorg") => {
    setBusy(action);
    try {
      await api(`/v1/test/payments/${id}/${action}`, { method: "POST" });
      await mutate();
      toast("success", action === "confirm" ? "Payment finalized." : "Block invalidated. Compensating history recorded.");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack>
      <PageHeader breadcrumbs={[{ label: "Payments", href: "/app/payments" }, { label: p.business_object?.number ? `${p.business_object.number} payment` : "Payment" }]} />
      <h1 className="sr-only">{`Payment of ${tokenAmount(p.amount, p.asset.symbol)} from ${p.customer?.name ?? "an unknown sender"}`}</h1>

      <DetailHero
        actions={
          <>
            {p.explorer_url && (
              <ButtonLink href={p.explorer_url} target="_blank" rel="noreferrer noopener" icon={<ExternalLink aria-hidden="true" />}>
                View on explorer
              </ButtonLink>
            )}
            {can("financials:read") && (
              <ButtonLink href={`/app/accounting/ledger?payment_id=${p.id}&preset=all`} icon={<BookMarked aria-hidden="true" />}>
                In the books
              </ButtonLink>
            )}
            {p.correctable && can("exceptions:resolve") && (
              <Button icon={<ArrowLeftRight />} onClick={() => setDialog("correct")}>
                Correct
              </Button>
            )}
            {p.refunds_summary.refundable !== "0.00" && can("exceptions:resolve") && (
              <Button icon={<CornerUpLeft />} onClick={() => setDialog("refund")}>
                Record refund
              </Button>
            )}
            {isTest && p.simulated && can("simulate") && p.status === "confirming" && (
              <Button variant="primary" loading={busy === "confirm"} onClick={() => test("confirm")} icon={<CheckCircle2 />}>
                Finalize now
              </Button>
            )}
            {isTest && p.simulated && can("simulate") && p.status !== "reversed" && (
              <Button variant="danger" loading={busy === "reorg"} onClick={() => test("reorg")} icon={<GitBranch />}>
                Simulate reorg
              </Button>
            )}
          </>
        }
        below={
          (p.status === "confirming" || openException) && (
            <>
              {p.status === "confirming" && (
                <div className="flex gap-3 rounded-xl bg-info/10 px-4 py-3 text-sm" role="status">
                  <Spinner className="mt-0.5 text-info" />
                  <div className="grid gap-0.5">
                    <strong className="font-semibold">Confirming on {p.network_name}</strong>
                    <span className="text-foreground/80">Seen in block {Number(p.block_number).toLocaleString()}. Setra applies it once the block is final (on Monad, about a second). No balance changes until then.</span>
                  </div>
                </div>
              )}
              {openException && (
                <Alert
                  tone={openException.type === "reversal" || openException.type === "wrong_token" ? "danger" : "warning"}
                  title={openException.summary}
                  actions={
                    <ButtonLink href={`/app/exceptions/${openException.id}`} variant="primary" size="sm">
                      Review and resolve <ArrowRight aria-hidden="true" />
                    </ButtonLink>
                  }
                >
                  {openException.detail}
                </Alert>
              )}
            </>
          )
        }
      >
        <StatusLine eyebrow={HEADLINE[p.status] ?? p.status}>
          <PaymentStatus status={p.status} />
          {p.simulated && <SimulatedTag />}
        </StatusLine>
        <BigMoney value={p.amount} asset={p.asset.symbol ?? "Unknown token"} />
        <div className="mt-2.5 text-[0.9375rem] font-semibold">{p.customer ? <TextLink href={`/app/customers/${p.customer.id}`}>{p.customer.name}</TextLink> : <span className="text-muted-foreground">Unknown sender</span>}</div>
        <PurposeBlock className="hero-purpose mt-2.5" label={p.purpose_status === "provisional" ? "For (confirming)" : "For"} title={p.business_object && (p.business_object.title ?? `Invoice ${p.business_object.number}`)} unknown={!p.business_object} />
        <HeroMeta>
          {p.business_object && (
            <span>
              Invoice{" "}
              <TextLink mono href={`/app/invoices/${p.business_object.id}`}>
                {p.business_object.number}
              </TextLink>
            </span>
          )}
          <Chain network={p.network} name={p.network_name} />
          <span title={dateTime(p.paid_at)}>{timeAgo(p.paid_at)}</span>
        </HeroMeta>
      </DetailHero>

      <DetailGrid>
        <Stack>
          <PurposeCard p={p} />

          {p.decision && (
            <Card
              title={p.decision.outcome === "needs_review" ? "Why this payment wasn't matched" : "Why this payment was matched"}
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
              {p.decision.candidates?.length > 0 && p.decision.outcome === "needs_review" && (
                <div className="border-t px-6 py-3 max-md:px-4">
                  <SectionTitle className="mb-2">Possible matches</SectionTitle>
                  <ul className="grid gap-3">
                    {p.decision.candidates.map((c: any) => (
                      <li key={c.invoiceId} className="flex flex-wrap items-center justify-between gap-3">
                        <span>
                          <TextLink mono href={`/app/invoices/${c.invoiceId}`}>
                            {c.number}
                          </TextLink>{" "}
                          <span className="text-muted-foreground">· {c.customerName}</span>
                        </span>
                        <Muted as="span">{c.reasons.join(" · ")}</Muted>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          )}

          <Card title="Payment">
            <CardBody className="py-1">
              <KV
                items={[
                  ["From", <Address key="f" value={p.sender} full />],
                  ["To", <span key="t" className="flex flex-wrap items-center gap-2"><TextLink href={`/app/wallets/${p.wallet.id}`}>{p.wallet.name}</TextLink><Address value={p.recipient} /></span>],
                  ["Network", <Chain key="n" network={p.network} name={p.network_name} />],
                  ["Asset", <span key="a" className="flex items-center gap-2">{p.asset.symbol ?? "Unknown token"} <Address value={p.asset.address} /></span>],
                  ["Amount", <span key="am" className="tabular">{tokenAmount(p.amount, p.asset.symbol)} <span className="font-mono text-[11px] text-muted-foreground">({p.amount_base_units} base units)</span></span>],
                  ["Transaction", p.simulated ? <span key="tx" className="flex items-center gap-2"><SimulatedTag /> <span className="text-muted-foreground">No onchain transaction</span></span> : <Address key="tx" value={p.transaction_hash} href={p.explorer_url} />],
                  ["Received", dateTime(p.paid_at)]
                ]}
              />
            </CardBody>
          </Card>

          <Card title="Blockchain evidence" description="What the blockchain actually reported. Source evidence is immutable.">
            <CardBody className="py-1">
              <KV
                items={[
                  ["Source", p.evidence.source_type === "payment_intent_event" ? "SetraPaymentIntent · PaymentIntentPaid" : p.evidence.source_type === "simulated" ? "Simulated observation (test mode)" : "ERC-20 Transfer log"],
                  ...(p.simulated
                    ? [["Block", <span key="b" className="text-muted-foreground">No block (simulated in test mode)</span>] as [React.ReactNode, React.ReactNode]]
                    : [
                        ["Block", <span key="b" className="tabular">{Number(p.evidence.block_number).toLocaleString()}</span>] as [React.ReactNode, React.ReactNode],
                        ["Block hash", <Address key="bh" value={p.evidence.block_hash} />] as [React.ReactNode, React.ReactNode],
                        ["Transaction hash", <Address key="th" value={p.evidence.transaction_hash} href={p.explorer_url} />] as [React.ReactNode, React.ReactNode],
                        ["Log index", <span key="li" className="tabular">{p.evidence.log_index}</span>] as [React.ReactNode, React.ReactNode]
                      ]),
                  ["Block time", dateTime(p.evidence.block_timestamp)],
                  [
                    "Confirmation",
                    <Badge key="c" tone={p.evidence.confirmation_state === "finalized" ? "success" : p.evidence.confirmation_state === "dropped" ? "danger" : "info"}>
                      {p.evidence.confirmation_state === "finalized" ? "Finalized" : p.evidence.confirmation_state === "dropped" ? "No longer canonical" : "Observed"}
                    </Badge>
                  ],
                  ["Observation", <span key="o" className="flex items-center gap-1 font-mono text-xs">{p.evidence.id}<CopyButton value={p.evidence.id} /></span>],
                  p.decision && ["Rule version", <Mono key="rv">{p.decision.rule_version}</Mono>]
                ]}
              />
              {p.supporting_evidence.length > 0 && (
                <p className="py-2.5 text-sm text-muted-foreground">
                  Supporting evidence: the ERC-20 Transfer in the same transaction (log {p.supporting_evidence[0].log_index}) moved exactly {p.amount} {p.asset.symbol} from the payer to your wallet.
                </p>
              )}
            </CardBody>
          </Card>

          {!p.simulated && p.detection && <DetectionCard d={p.detection} network={p.network_name} />}

          {intent && (
            <Card title="Payment intent" description="The transaction carried a machine-readable reference to this invoice.">
              <CardBody className="py-1">
                <KV
                  items={[
                    ["Intent", <Address key="i" value={intent.intent_id} />],
                    ["Contract", <span key="c" className="flex items-center gap-2">Setra Payment Intent <Address value={intent.contract_address} /></span>],
                    ["Contract event", <Mono key="e">PaymentIntentPaid</Mono>],
                    ["Status", <span key="s" className="capitalize">{intent.status}</span>],
                    ["Setra reference", <Mono key="r">{intent.id}</Mono>]
                  ]}
                />
              </CardBody>
            </Card>
          )}
        </Stack>

        <Stack>
          <Card title="What it paid for">
            <CardBody className="py-1">
              <KV
                items={[
                  ["Customer", p.customer ? <TextLink key="c" href={`/app/customers/${p.customer.id}`}>{p.customer.name}</TextLink> : <span key="c" className="text-muted-foreground">Not identified</span>],
                  ["Invoice", p.invoice_detail ? <TextLink key="i" mono href={`/app/invoices/${p.invoice_detail.id}`}>{p.invoice_detail.number}</TextLink> : <span key="i" className="text-muted-foreground">Not applied</span>],
                  p.invoice_detail && ["Amount due", <Money key="d" value={p.invoice_detail.amount_due} />],
                  p.invoice_detail && ["Remaining", <Money key="r" value={p.invoice_detail.amount_remaining} />],
                  p.invoice_detail && ["Invoice status", <InvoiceStatus key="s" status={p.invoice_detail.status} />]
                ]}
              />
            </CardBody>
          </Card>

          <PaymentCredit paymentId={p.id} asset={p.asset?.symbol} onChange={() => mutate()} />

          {p.refunds.length > 0 && (
            <Card title="Refunds" description={`${money(p.refunds_summary.refunded)} sent back${p.refunds_summary.refundable !== "0.00" ? `, ${money(p.refunds_summary.refundable)} still refundable` : ""}.`}>
              <CardBody className="py-1">
                <KV
                  items={p.refunds.map((r: any) => [
                    <Money key={`a${r.id}`} value={r.amount} />,
                    <span key={r.id} className="grid gap-0.5">
                      <Address value={r.transaction_hash} href={r.explorer_url} />
                      <span className="text-sm text-muted-foreground">
                        To {r.to === p.sender ? "the payer" : shortAddress(r.to)} · {timeAgo(r.sent_at)} · “{r.reason}”
                      </span>
                    </span>
                  ])}
                />
              </CardBody>
            </Card>
          )}

          {p.exceptions.length > 0 && (
            <Card title="Exceptions">
              <ul>
                {p.exceptions.map((e: any) => (
                  <li key={e.id} className="border-t first:border-t-0">
                    <Link href={`/app/exceptions/${e.id}`} className="flex items-center justify-between gap-4 px-6 py-3.5 transition-colors hover:bg-muted/40 max-md:px-4">
                      <ExceptionType type={e.type} />
                      <Muted as="span">{e.status === "open" ? "Open" : "Resolved"}</Muted>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="History">
            <CardBody>
              <History p={p} />
            </CardBody>
          </Card>
        </Stack>
      </DetailGrid>
      {dialog === "correct" && <CorrectDialog p={p} onClose={() => setDialog(null)} onDone={async () => { setDialog(null); await mutate(); toast("success", "Corrected. The history keeps both applications."); }} />}
      {dialog === "refund" && <RefundDialog p={p} onClose={() => setDialog(null)} onDone={async () => { setDialog(null); await mutate(); toast("success", "Refund recorded with its transaction as proof."); }} />}
    </Stack>
  );
}

/** Move an applied payment to another invoice, or take it back to review. */
function CorrectDialog({ p, onClose, onDone }: { p: any; onClose: () => void; onDone: () => void }) {
  const { data: open } = useApi<{ data: any[] }>("/v1/invoices?status=open&limit=100");
  const { data: partial } = useApi<{ data: any[] }>("/v1/invoices?status=partially_paid&limit=100");
  const [action, setAction] = useState<"reassign" | "unassign">("reassign");
  const [invoiceId, setInvoiceId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const errs = fieldErrors(error);
  const targets = [...(open?.data ?? []), ...(partial?.data ?? [])].filter((i) => i.id !== p.business_object?.id && i.asset?.symbol === p.asset.symbol);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/payments/${p.id}/corrections`, { method: "POST", body: { action, invoice_id: action === "reassign" ? invoiceId : undefined, reason } });
      onDone();
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Correct this payment"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={reason.trim().length < 3 || (action === "reassign" && !invoiceId)} onClick={submit}>
            {action === "reassign" ? "Move payment" : "Take off invoice"}
          </Button>
        </>
      }
    >
      <Stack gap={4}>
        {error && !error.details && <Alert tone="danger">{error.message}</Alert>}
        <p className="text-sm text-muted-foreground">
          Applied to <strong>{p.business_object.number}</strong>{p.business_object.title ? `, ${p.business_object.title}` : ""}. Nothing is erased: the original application stays in the history, a compensating entry reverses it, and {p.business_object.number} is reopened if it was paid by this payment.
        </p>
        <ChoiceGroup label="Correction" value={action} onChange={(v) => setAction(v as "reassign" | "unassign")}>
          <ChoiceCard id="corr-reassign" value="reassign" selected={action === "reassign"} title="Move to another invoice" description="It was meant for a different payment request." />
          <ChoiceCard id="corr-unassign" value="unassign" selected={action === "unassign"} title="Take it off the invoice" description="Back to review, with purpose unknown, to assign, refund or set aside." />
        </ChoiceGroup>
        {action === "reassign" && (
          <Field label="Invoice" htmlFor="corr-invoice" error={errs.invoice_id}>
            <Select
              id="corr-invoice"
              value={invoiceId}
              onValueChange={setInvoiceId}
              placeholder="Choose an invoice…"
              options={targets.map((i) => ({ value: i.id, label: `${i.number}${i.title ? `, ${i.title}` : ""} · ${i.customer.name} · $${i.amount_remaining} remaining` }))}
            />
          </Field>
        )}
        <Field label="Reason" htmlFor="corr-reason" hint="Recorded permanently with your name." error={errs.reason}>
          <Textarea id="corr-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer confirmed this was for INV-…" />
        </Field>
      </Stack>
    </Modal>
  );
}

/** Link the outgoing transfer that sent this payment's money back. */
function RefundDialog({ p, onClose, onDone }: { p: any; onClose: () => void; onDone: () => void }) {
  const { data } = useApi<{ data: any[]; refundable: string }>(`/v1/payments/${p.id}/refund-candidates`);
  const [transferId, setTransferId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const errs = fieldErrors(error);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/payments/${p.id}/refunds`, { method: "POST", body: { outgoing_transfer_id: transferId, reason } });
      onDone();
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Record a refund"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!transferId || reason.trim().length < 3} onClick={submit}>Record refund</Button>
        </>
      }
    >
      <Stack gap={4}>
        {error && !error.details && <Alert tone="danger">{error.message}</Alert>}
        <p className="text-sm text-muted-foreground">
          Up to <strong>{money(p.refunds_summary.refundable)}</strong> of this payment can be refunded{p.status === "overpaid" ? " (the overpaid amount)" : ""}. Choose the transfer from your wallet that sent it back.
        </p>
        {!data ? <SkeletonBlock height={80} /> : <RefundPicker candidates={data.data} value={transferId} onChange={setTransferId} payer={p.sender} />}
        {errs.outgoing_transfer_id && <p className="text-xs text-destructive">{errs.outgoing_transfer_id}</p>}
        <Field label="Reason" htmlFor="refund-reason" hint="Recorded permanently with your name." error={errs.reason}>
          <Textarea id="refund-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer paid twice; returned the duplicate" />
        </Field>
      </Stack>
    </Modal>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  execution_events: "Execution events",
  rpc: "RPC",
  simulated: "Simulation (test mode)"
};

const duration = (ms: number | null) => (ms === null ? null : ms < 1000 ? `${Math.max(ms, 0)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);

/** Technical detail: how the payment was detected, with measured timings only. */
function DetectionCard({ d, network }: { d: any; network: string }) {
  const t = d.timings_ms;
  const steps: Array<[string, string | null]> = [
    ["Executed on " + network, d.executed_at ? dateTime(d.executed_at) : null],
    ["Detected", duration(t.execution_to_detection) && `${duration(t.execution_to_detection)} after execution`],
    ["Customer and purpose identified", d.business_match_same_transaction ? "At detection (same database transaction)" : duration(t.detection_to_business_match) && `${duration(t.detection_to_business_match)} after detection`],
    ["Confirmed (finalized)", duration(t.detection_to_confirmation) && `${duration(t.detection_to_confirmation)} after detection`]
  ];
  return (
    <Card title="Detection" description="How Setra first saw this payment. Timings are measured, not estimated.">
      <CardBody className="py-1">
        <KV
          items={[
            ["Detected by", <span key="s">{d.source === "simulated" ? SOURCE_LABEL.simulated : `${network} ${SOURCE_LABEL[d.source] ?? d.source}`}</span>],
            ...steps.filter(([, v]) => v).map(([k, v]) => [k, <span key={k} className="tabular">{v}</span>] as [React.ReactNode, React.ReactNode]),
            t.execution_events_lead_over_rpc !== null && ["Execution events lead over RPC", <span key="lead" className="tabular">{duration(t.execution_events_lead_over_rpc)}</span>],
            d.sightings.length > 0 && ["Seen by", <span key="seen">{d.sightings.map((x: any) => `${SOURCE_LABEL[x.source] ?? x.source} (${x.stage === "tip" ? "provisional" : "finalized"})`).join(", ")}</span>]
          ]}
        />
      </CardBody>
    </Card>
  );
}

const CONTEXT_SOURCE: Record<string, string> = {
  automatic_match: "Matched automatically by deterministic rules",
  payment_intent: "Identified by the onchain payment intent reference",
  manual_resolution: "Assigned by an operator"
};

/** What the money is for. Only authoritative data; an unmatched payment says so plainly. */
function PurposeCard({ p }: { p: any }) {
  const inv = p.invoice_detail;
  if (!p.business_object || !inv) {
    return (
      <Card title="What this payment is for">
        <CardBody>
          <p className="text-[0.9375rem] text-muted-foreground italic">Purpose unknown</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {p.status === "confirming"
              ? "No invoice has been identified yet. Setra will decide once the block is final."
              : "No invoice matched this payment deterministically, so Setra hasn't attached one. Resolving the review item establishes it, and the history keeps both steps."}
          </p>
        </CardBody>
      </Card>
    );
  }
  const manual = p.context_history.find((h: any) => h.kind === "resolution" && h.outcome === "assign");
  const moved = [...(p.corrections ?? [])].reverse().find((k: any) => k.action === "reassign");
  return (
    <Card
      title="What this payment is for"
      actions={
        <ButtonLink href={`/app/invoices/${inv.id}`} variant="ghost" size="sm">
          {inv.number} <ArrowRight aria-hidden="true" />
        </ButtonLink>
      }
    >
      <CardBody>
        <div className="text-[1.0625rem] font-semibold tracking-[-0.02em]">{inv.title ?? `Invoice ${inv.number}`}</div>
        {inv.purpose && <p className="mt-1 text-muted-foreground">{inv.purpose}</p>}
        {inv.line_items.length > 0 && <LineItems items={inv.line_items} total={inv.amount_due} />}
        <p className="mt-3 text-xs text-muted-foreground">
          {p.purpose_status === "provisional"
            ? "Provisional: this payment matches the invoice above and is confirming on chain. Nothing is applied until the block is final."
            : moved
              ? `Moved here from ${moved.from_invoice.number} by ${moved.actor.label ?? moved.actor.type}: “${moved.reason}”`
              : manual
              ? `Initially unknown. Assigned by ${manual.actor}: “${manual.summary}”`
              : (CONTEXT_SOURCE[p.context_source] ?? "")}
        </p>
      </CardBody>
    </Card>
  );
}

function History({ p }: { p: any }) {
  const items: Array<{ at: string; title: string; meta: string; tone: string; icon: React.ReactNode; href?: string }> = [];
  for (const c of p.confirmation_history) {
    items.push({
      at: c.at,
      title: c.to === "observed" ? "Observed at chain tip" : c.to === "finalized" ? "Finalized" : "No longer canonical",
      meta: c.reason,
      tone: c.to === "dropped" ? "danger" : c.to === "finalized" ? "success" : "info",
      icon: c.to === "dropped" ? <Undo2 /> : c.to === "finalized" ? <ShieldCheck /> : <Radio />
    });
  }
  for (const e of p.financial_events) {
    items.push({
      at: e.created_at,
      title: eventLabel[e.type] ?? e.type,
      meta: `Rules ${e.rule_version}`,
      tone: e.type === "PAYMENT_REVERSED" ? "danger" : e.type === "UNKNOWN_PAYMENT" ? "warning" : e.type === "PAYMENT_OBSERVED" ? "info" : "success",
      icon: e.type === "PAYMENT_REVERSED" ? <RotateCcw /> : e.type === "UNKNOWN_PAYMENT" ? <AlertTriangle /> : <CircleDot />,
      href: `/app/developers/events/${e.id}`
    });
  }
  for (const k of p.corrections ?? []) {
    items.push({
      at: k.created_at,
      title: k.action === "reassign" ? `Moved from ${k.from_invoice.number} to ${k.to_invoice.number}` : `Taken off ${k.from_invoice.number}`,
      meta: `${k.actor.label ?? k.actor.type}, “${k.reason}”`,
      tone: "warning",
      icon: <ArrowLeftRight />
    });
  }
  for (const r of p.refunds ?? []) {
    items.push({ at: r.created_at, title: `Refund recorded: ${money(r.amount)}`, meta: `${r.actor.label ?? r.actor.type}, “${r.reason}”`, tone: "info", icon: <CornerUpLeft /> });
  }
  for (const r of p.resolutions) {
    items.push({ at: r.created_at, title: `Resolved: ${r.action.replace("_", " ")}`, meta: `${r.actor.label ?? r.actor.type}, “${r.reason}”`, tone: "success", icon: <FileSignature /> });
  }
  items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return <Timeline items={items.map((i) => ({ title: i.title, meta: i.meta, time: timeAgo(i.at), timeTitle: dateTime(i.at), tone: i.tone, icon: i.icon, href: i.href }))} />;
}

void shortAddress;
