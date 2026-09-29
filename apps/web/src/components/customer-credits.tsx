"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Button, Card, Field, Input, Modal, Select, useToast } from "@/components/app-ui";
import { ReasonModal } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { api, newIdempotencyKey, useApi, type ApiError } from "@/lib/api";
import { money, timeAgo } from "@/lib/format";

/** Unused overpayment on a payment, applied as credit to the customer's other open invoices. */
export function PaymentCredit({ paymentId, asset, onChange }: { paymentId: string; asset?: string | null; onChange?: () => void }) {
  const { can } = useSession();
  const { data, mutate } = useApi<any>(`/v1/payments/${paymentId}/credit`);
  const [applying, setApplying] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);
  if (!data || (data.available === "0.00" && data.applications.length === 0)) return null;
  const refresh = () => {
    mutate();
    onChange?.();
  };
  return (
    <Card
      title="Customer credit"
      description={data.available !== "0.00" ? `${money(data.available)} of this payment was more than ${data.from_invoice?.number} needed. Refund it, or apply it to another invoice from this customer.` : "This payment's overpayment was applied to other invoices."}
      actions={data.available !== "0.00" && data.eligible_invoices.length > 0 && can("exceptions:resolve") ? <Button size="sm" variant="primary" onClick={() => setApplying(true)}>Apply credit</Button> : undefined}
    >
      {data.applications.length > 0 ? (
        <ul className="divide-y">
          {data.applications.map((a: any) => (
            <li key={a.id} className="flex items-center gap-3 px-6 py-3 max-md:px-4">
              <span className="min-w-0 flex-1 text-sm">
                <span className="tabular font-semibold">{money(a.amount)}</span> applied to{" "}
                <Link href={`/app/invoices/${a.invoice.id}`} className="font-mono text-primary hover:underline">{a.invoice.number}</Link>
                <span className="text-muted-foreground"> · {a.by ?? "Setra"} · {timeAgo(a.created_at)}</span>
              </span>
              {can("exceptions:resolve") && <Button size="sm" variant="ghost" onClick={() => setUndoing(a.id)}>Undo</Button>}
            </li>
          ))}
        </ul>
      ) : (
        data.eligible_invoices.length === 0 && <p className="px-6 py-4 text-sm text-muted-foreground max-md:px-4">This customer has no other open invoices in {asset ?? "this stablecoin"}.</p>
      )}
      {applying && <ApplyCreditModal paymentId={paymentId} data={data} onClose={() => setApplying(false)} onDone={() => { setApplying(false); refresh(); }} />}
      <ReasonModal
        open={!!undoing}
        onClose={() => setUndoing(null)}
        title="Undo this credit application?"
        description="The invoice it paid reopens and the credit returns to this payment. The original record is kept."
        confirmLabel="Undo"
        onConfirm={async (reason) => {
          await api(`/v1/credit-applications/${undoing}/undo`, { method: "POST", body: { reason } });
          refresh();
        }}
      />
    </Card>
  );
}

function ApplyCreditModal({ paymentId, data, onClose, onDone }: { paymentId: string; data: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [invoiceId, setInvoiceId] = useState(data.eligible_invoices[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [key] = useState(newIdempotencyKey);
  const target = data.eligible_invoices.find((i: any) => i.id === invoiceId);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<any>(`/v1/payments/${paymentId}/apply-credit`, { method: "POST", idempotencyKey: key, body: { invoice_id: invoiceId, amount: amount.trim() || undefined } });
      toast("success", `${money(r.amount)} applied to ${target?.number}.`);
      onDone();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Apply credit" description={`${money(data.available)} available.`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!invoiceId} onClick={submit}>Apply credit</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        <Field label="Invoice" htmlFor="ac-invoice">
          <Select id="ac-invoice" value={invoiceId} onValueChange={setInvoiceId} options={data.eligible_invoices.map((i: any) => ({ value: i.id, label: `${i.number} · ${i.title} · ${money(i.owed)} owed` }))} />
        </Field>
        <Field label="Amount" htmlFor="ac-amount" optional hint="Leave blank to apply as much as possible.">
          <Input id="ac-amount" inputMode="decimal" className="tabular" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder={target ? (Number(target.owed) < Number(data.available) ? target.owed : data.available) : "0.00"} />
        </Field>
      </div>
    </Modal>
  );
}

/** Credit notes on an invoice, and issuing one. */
export function InvoiceCreditNotes({ invoice, onChange }: { invoice: any; onChange?: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const { data, mutate } = useApi<{ data: any[] }>(`/v1/invoices/${invoice.id}/credit-notes`);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ amount: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [key] = useState(newIdempotencyKey);
  const creditable = ["open", "partially_paid", "expired"].includes(invoice.status) && can("invoices:write");
  if (!data || (data.data.length === 0 && !creditable)) return null;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const n = await api<any>(`/v1/invoices/${invoice.id}/credit-notes`, { method: "POST", idempotencyKey: key, body: { amount: form.amount.trim(), reason: form.reason.trim() } });
      toast("success", `Credit note ${n.number} issued.`);
      setOpen(false);
      setForm({ amount: "", reason: "" });
      mutate();
      onChange?.();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Credit notes" description={invoice.amount_credited !== "0.00" ? `Originally ${money(invoice.original_amount)}; ${money(invoice.amount_credited)} credited.` : "Lower what the customer owes: a discount, a return, a billing mistake."} actions={creditable ? <Button size="sm" onClick={() => setOpen(true)}>Issue credit note</Button> : undefined}>
      {data.data.length > 0 ? (
        <ul className="divide-y">
          {data.data.map((n) => (
            <li key={n.id} className="flex items-center gap-3 px-6 py-3 text-sm max-md:px-4">
              <span className="font-mono">{n.number}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{n.reason}</span>
              <span className="tabular font-semibold">{money(n.amount)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-6 py-4 text-sm text-muted-foreground max-md:px-4">None issued.</p>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={`Credit note on ${invoice.number}`} description={`Up to ${money(invoice.amount_remaining)} (what's still owed). To credit the whole invoice, cancel it instead.`} footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!(Number(form.amount) > 0) || form.reason.trim().length < 3} onClick={submit}>Issue credit note</Button></>}>
        <div className="grid gap-4">
          {error && <Alert tone="danger">{error.message}</Alert>}
          <Field label="Amount" htmlFor="cn-amount"><Input id="cn-amount" inputMode="decimal" className="tabular" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value.replace(/[^\d.]/g, "") }))} placeholder="0.00" /></Field>
          <Field label="Reason" htmlFor="cn-reason" hint="Shown on the credit note and kept in the audit trail."><Input id="cn-reason" value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="10% loyalty discount" /></Field>
        </div>
      </Modal>
    </Card>
  );
}
