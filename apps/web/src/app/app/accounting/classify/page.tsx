"use client";

import { CounterpartyInsight } from "@/components/counterparty";
import Link from "next/link";
import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, CheckCircle2 } from "lucide-react";
import { Alert, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, SkeletonRows, Textarea, useToast } from "@/components/app-ui";
import { AccountSelect, FinancialsGate, TxProof, calendarDate, isClassifyAccount, isSpendAccount } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { api, useApi, type ApiError } from "@/lib/api";
import { shortAddress, tokenAmount } from "@/lib/format";

type Target = { kind: "receipt" | "outgoing"; row: any; mode: "classify" | "expense" | "bill" };

function ClassifyView() {
  const { can } = useSession();
  const { data, error, mutate } = useApi<{ receipts: any[]; outgoing: any[] }>("/v1/accounting/unclassified");
  const [target, setTarget] = useState<Target | null>(null);
  const write = can("financials:write");

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Books", href: "/app/accounting" }, { label: "Needs a decision" }]}
        title="Needs a decision"
        description="Money Setra saw onchain but can't explain on its own. It's held in a holding account, never counted as income or spending, until you say what it was."
      />
      {error ? (
        <Card><ErrorState error={error} retry={() => mutate()} /></Card>
      ) : !data ? (
        <Card><SkeletonRows rows={6} cols={4} /></Card>
      ) : data.receipts.length + data.outgoing.length === 0 ? (
        <Card>
          <EmptyState icon={<CheckCircle2 />} title="Everything is accounted for" mascot="success">Every payment received and every transfer sent is tied to an invoice, bill, expense, refund or classification.</EmptyState>
        </Card>
      ) : (
        <>
          <Card title="Received, not identified" description="Payments not tied to an invoice. Apply one to an invoice from its payment page, or classify it (an owner contribution, a loan, other income).">
            {data.receipts.length === 0 ? (
              <p className="px-6 py-5 text-sm text-muted-foreground max-md:px-4">Nothing waiting.</p>
            ) : (
              <ul className="divide-y">
                {data.receipts.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-4 px-6 py-3.5 max-md:px-4">
                    <ArrowDownLeft className="size-4 shrink-0 text-success" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold tabular">{tokenAmount(r.amount, r.asset)}</p>
                      <p className="text-sm text-muted-foreground">
                        From <span className="font-mono">{shortAddress(r.from_address)}</span> · {calendarDate(r.received_at.slice(0, 10))} · <TxProof hash={r.transaction_hash} />
                      </p>
                      <CounterpartyInsight paymentId={r.id} compact />
                    </div>
                    <div className="flex gap-2">
                      <Link href={r.link} className="inline-flex h-8 items-center rounded-md px-3 text-sm font-medium hover:bg-accent">Apply to invoice</Link>
                      {write && <Button size="sm" onClick={() => setTarget({ kind: "receipt", row: r, mode: "classify" })}>Classify</Button>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Sent, not classified" description="Stablecoin that left your wallets. Record it as an expense or a bill payment, or classify it (an owner draw, a loan repayment).">
            {data.outgoing.length === 0 ? (
              <p className="px-6 py-5 text-sm text-muted-foreground max-md:px-4">Nothing waiting.</p>
            ) : (
              <ul className="divide-y">
                {data.outgoing.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-4 px-6 py-3.5 max-md:px-4">
                    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold tabular">{tokenAmount(t.amount, t.asset)}</p>
                      <p className="text-sm text-muted-foreground">
                        To {t.vendor ? <span className="font-medium text-foreground">{t.vendor.name}</span> : <span className="font-mono">{shortAddress(t.to_address)}</span>} from {t.wallet.name} · {calendarDate(t.sent_at.slice(0, 10))} · <TxProof hash={t.transaction_hash} />
                      </p>
                      {!t.vendor && <CounterpartyInsight outgoingId={t.id} compact />}
                    </div>
                    {write && (
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setTarget({ kind: "outgoing", row: t, mode: "bill" })}>Pay a bill</Button>
                        <Button size="sm" variant="ghost" onClick={() => setTarget({ kind: "outgoing", row: t, mode: "classify" })}>Classify</Button>
                        <Button size="sm" onClick={() => setTarget({ kind: "outgoing", row: t, mode: "expense" })}>Record expense</Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
      {target && <DecisionModal target={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); mutate(); }} />}
    </div>
  );
}

function DecisionModal({ target, onClose, onDone }: { target: Target; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const [account, setAccount] = useState("");
  const [reason, setReason] = useState("");
  const [title, setTitle] = useState("");
  const [billId, setBillId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const { data: bills } = useApi<{ data: any[] }>(target.mode === "bill" ? `/v1/bills?status=open&limit=100${target.row.vendor ? `&vendor_id=${target.row.vendor.id}` : ""}` : null);
  const amount = target.row.amount as string;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (target.mode === "classify") {
        await api("/v1/accounting/classifications", { method: "POST", body: { [target.kind === "receipt" ? "payment_id" : "outgoing_transfer_id"]: target.row.id, account_id: account, reason } });
        toast("success", "Classified. The holding account is updated.");
      } else if (target.mode === "expense") {
        await api("/v1/expenses", { method: "POST", body: { title, account_id: account || null, vendor_id: target.row.vendor?.id ?? null, outgoing_transfer_id: target.row.id, approve: can("financials:approve") } });
        toast("success", can("financials:approve") ? "Expense recorded." : "Expense saved for approval.");
      } else {
        await api(`/v1/bills/${billId}/pay`, { method: "POST", body: { outgoing_transfer_id: target.row.id } });
        toast("success", "Bill payment recorded.");
      }
      onDone();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const ready = target.mode === "classify" ? !!account && reason.trim().length >= 3 : target.mode === "expense" ? title.trim().length > 0 : !!billId;
  const heading = target.mode === "classify" ? `Classify ${tokenAmount(amount, target.row.asset)}` : target.mode === "expense" ? `Record ${tokenAmount(amount, target.row.asset)} as an expense` : `Pay a bill with ${tokenAmount(amount, target.row.asset)}`;

  return (
    <Modal
      open
      onClose={onClose}
      title={heading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={submit}>{target.mode === "bill" ? "Record payment" : "Save"}</Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        {target.mode === "classify" && (
          <>
            <Field label="What was it?" htmlFor="cls-account" hint={target.kind === "receipt" ? "For example Owner's Equity for money the owner put in." : "For example Owner's Equity for an owner draw."}>
              <AccountSelect id="cls-account" value={account} onChange={setAccount} filter={isClassifyAccount} />
            </Field>
            <Field label="Reason" htmlFor="cls-reason" hint="Kept permanently in the audit trail.">
              <Textarea id="cls-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </>
        )}
        {target.mode === "expense" && (
          <>
            <Field label="What was it for?" htmlFor="exp-title">
              <Input id="exp-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Design contractor, September" autoFocus />
            </Field>
            <Field label="Expense account" htmlFor="exp-account" optional hint={target.row.vendor ? `Defaults to ${target.row.vendor.name}'s usual account.` : "Defaults to General Expenses."}>
              <AccountSelect id="exp-account" value={account} onChange={setAccount} filter={isSpendAccount} />
            </Field>
          </>
        )}
        {target.mode === "bill" &&
          (!bills ? (
            <p className="text-sm text-muted-foreground">Loading open bills…</p>
          ) : bills.data.length === 0 ? (
            <Alert tone="info">
              No approved bills are waiting for payment{target.row.vendor ? ` from ${target.row.vendor.name}` : ""}. <Link href="/app/bills" className="font-medium underline">Record the bill first</Link>.
            </Alert>
          ) : (
            <Field label="Bill" htmlFor="bill-pick" hint="The transfer amount is applied to the bill; it can't exceed what's still owed.">
              <Select id="bill-pick" value={billId} onValueChange={setBillId} placeholder="Choose a bill" options={bills.data.map((b) => ({ value: b.id, label: `${b.vendor.name} · ${b.number} · ${b.amount_remaining} owed` }))} />
            </Field>
          ))}
      </div>
    </Modal>
  );
}

export default function ClassifyPage() {
  return (
    <FinancialsGate>
      <ClassifyView />
    </FinancialsGate>
  );
}
