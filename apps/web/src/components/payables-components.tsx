"use client";

import { useState } from "react";
import { Alert, Button, Card, ChoiceCard, ChoiceGroup, Field, fieldErrors, Input, Modal, MoneyInput, Select, Textarea, useToast } from "@/components/app-ui";
import { AccountSelect, isPayFromAccount, isSpendAccount } from "@/components/ledger-components";
import { AddressCheck } from "@/components/counterparty";
import { useSession } from "@/components/session";
import { api, newIdempotencyKey, useApi, type ApiError } from "@/lib/api";
import { calendarDate, money, shortAddress, todayIso, tokenAmount } from "@/lib/format";

/** Vendors, bills and expenses: the create and pay flows shared by several pages. */

export function useVendors() {
  return useApi<{ data: Array<{ id: string; name: string }> }>("/v1/vendors?limit=100");
}

export function VendorModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (v: { id: string; name: string }) => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: "", email: "", account: "", address: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const errs = fieldErrors(error);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const v = await api<{ id: string; name: string }>("/v1/vendors", {
        method: "POST",
        body: { name: form.name, email: form.email || null, default_account_id: form.account || null, wallet_addresses: form.address ? [{ address: form.address.trim(), network: "monad" }] : [] }
      });
      toast("success", `${v.name} added.`);
      setForm({ name: "", email: "", account: "", address: "" });
      onCreated(v);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New vendor" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={submit}>Add vendor</Button></>}>
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {error && !error.details && <Alert tone="danger">{error.message}</Alert>}
        <Field label="Name" htmlFor="v-name" error={errs.name}>
          <Input id="v-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Northwind Hosting" autoFocus />
        </Field>
        <Field label="Billing email" htmlFor="v-email" optional error={errs.email}>
          <Input id="v-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
        </Field>
        <Field label="Usual expense account" htmlFor="v-account" optional hint="Bills and expenses from this vendor default to it.">
          <AccountSelect id="v-account" value={form.account} onChange={(v) => setForm((f) => ({ ...f, account: v }))} filter={isSpendAccount} />
        </Field>
        <Field label="Vendor wallet address" htmlFor="v-addr" optional hint="Transfers to this address will show the vendor's name." error={errs["wallet_addresses.0.address"]}>
          <Input id="v-addr" className="font-mono" value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} placeholder="0x…" spellCheck={false} />
        </Field>
        <AddressCheck address={form.address} />
      </form>
    </Modal>
  );
}

export function BillModal({ open, onClose, onCreated, vendorId }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; vendorId?: string }) {
  const toast = useToast();
  const { can } = useSession();
  const { data: vendors, mutate: refreshVendors } = useVendors();
  const [addingVendor, setAddingVendor] = useState(false);
  const [form, setForm] = useState({ vendor_id: vendorId ?? "", number: "", title: "", amount: "", account_id: "", bill_date: todayIso(), due_date: "" });
  const [busy, setBusy] = useState<"draft" | "approve" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [key] = useState(newIdempotencyKey);
  const errs = fieldErrors(error);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (approve: boolean) => {
    setBusy(approve ? "approve" : "draft");
    setError(null);
    try {
      const b = await api<{ id: string; number: string }>("/v1/bills", { method: "POST", idempotencyKey: `${key}-${approve}`, body: { ...form, account_id: form.account_id || null, due_date: form.due_date || null, approve } });
      toast("success", approve ? `Bill ${b.number} approved. It's now a payable.` : `Bill ${b.number} saved for approval.`);
      onCreated(b.id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };
  const ready = form.vendor_id && form.number.trim() && form.title.trim() && Number(form.amount) > 0;
  return (
    <>
      <Modal
        open={open && !addingVendor}
        onClose={onClose}
        title="Record a bill"
        description="A bill is money you owe a vendor. Once approved it's a payable until you pay it."
        wide
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button loading={busy === "draft"} disabled={!ready} onClick={() => submit(false)}>Save for approval</Button>
            {can("financials:approve") && <Button variant="primary" loading={busy === "approve"} disabled={!ready} onClick={() => submit(true)}>Approve bill</Button>}
          </>
        }
      >
        <div className="grid gap-4">
          {error && !error.details && <Alert tone="danger">{error.message}</Alert>}
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <Field label="Vendor" htmlFor="b-vendor" error={errs.vendor_id}>
              <div className="flex gap-2">
                <Select id="b-vendor" value={form.vendor_id} onValueChange={set("vendor_id")} placeholder={vendors ? "Choose a vendor" : "Loading…"} options={(vendors?.data ?? []).map((v) => ({ value: v.id, label: v.name }))} />
                <Button variant="ghost" onClick={() => setAddingVendor(true)}>New</Button>
              </div>
            </Field>
            <Field label="Bill number" htmlFor="b-number" error={errs.number}>
              <Input id="b-number" value={form.number} onChange={(e) => set("number")(e.target.value)} placeholder="NW-1042" />
            </Field>
          </div>
          <Field label="What is it for?" htmlFor="b-title" error={errs.title}>
            <Input id="b-title" value={form.title} onChange={(e) => set("title")(e.target.value)} placeholder="September hosting" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Amount" htmlFor="b-amount" error={errs.amount}>
              <MoneyInput id="b-amount" value={form.amount} onChange={set("amount")} suffix="USD" />
            </Field>
            <Field label="Expense account" htmlFor="b-account" optional hint="Defaults to the vendor's usual account.">
              <AccountSelect id="b-account" value={form.account_id} onChange={set("account_id")} filter={isSpendAccount} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bill date" htmlFor="b-date">
              <Input id="b-date" type="date" value={form.bill_date} onChange={(e) => set("bill_date")(e.target.value)} />
            </Field>
            <Field label="Due date" htmlFor="b-due" optional error={errs.due_date}>
              <Input id="b-due" type="date" value={form.due_date} min={form.bill_date} onChange={(e) => set("due_date")(e.target.value)} />
            </Field>
          </div>
        </div>
      </Modal>
      <VendorModal
        open={addingVendor}
        onClose={() => setAddingVendor(false)}
        onCreated={(v) => {
          refreshVendors();
          setForm((f) => ({ ...f, vendor_id: v.id }));
          setAddingVendor(false);
        }}
      />
    </>
  );
}

/** Pay a bill: link the onchain transfer that paid it (preferred), or record an off-chain payment. */
export function PayBillModal({ open, onClose, bill, onPaid }: { open: boolean; onClose: () => void; bill: any; onPaid: () => void }) {
  const toast = useToast();
  const [method, setMethod] = useState<"onchain" | "offchain">("onchain");
  const [transfer, setTransfer] = useState("");
  const [account, setAccount] = useState("");
  const [amount, setAmount] = useState(bill.amount_remaining as string);
  const [paidOn, setPaidOn] = useState(todayIso());
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [key] = useState(newIdempotencyKey);
  const { data: open_ } = useApi<{ outgoing: any[] }>(open ? "/v1/accounting/unclassified" : null);
  const candidates = (open_?.outgoing ?? []).sort((a, b) => Number(b.vendor?.id === bill.vendor.id) - Number(a.vendor?.id === bill.vendor.id));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/bills/${bill.id}/pay`, { method: "POST", idempotencyKey: key, body: method === "onchain" ? { outgoing_transfer_id: transfer } : { paid_from_account_id: account, amount, paid_on: paidOn, reference: reference || null } });
      toast("success", "Payment recorded.");
      onPaid();
      onClose();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Pay ${bill.vendor.name}`}
      description={`${bill.amount_remaining} still owed on bill ${bill.number}.`}
      wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={method === "onchain" ? !transfer : !account || !(Number(amount) > 0)} onClick={submit}>Record payment</Button></>}
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        <ChoiceGroup value={method} onChange={(v) => setMethod(v as "onchain" | "offchain")} label="How was it paid?">
          <ChoiceCard id="pay-onchain" value="onchain" selected={method === "onchain"} title="From a monitored wallet" description="Link the stablecoin transfer Setra saw leave your wallet. It's the proof." />
          <ChoiceCard id="pay-offchain" value="offchain" selected={method === "offchain"} title="Some other way" description="Bank transfer, card, or paid personally by an owner." />
        </ChoiceGroup>
        {method === "onchain" ? (
          !open_ ? (
            <p className="text-sm text-muted-foreground">Loading transfers…</p>
          ) : candidates.length === 0 ? (
            <Alert tone="info">No unclassified outgoing transfers. Once the payment is confirmed onchain it appears here.</Alert>
          ) : (
            <Field label="Transfer" htmlFor="pay-transfer">
              <Select
                id="pay-transfer"
                value={transfer}
                onValueChange={setTransfer}
                placeholder="Choose the transfer"
                options={candidates.map((t) => ({ value: t.id, label: `${tokenAmount(t.amount, t.asset)} to ${t.vendor?.name ?? shortAddress(t.to_address)} · ${new Date(t.sent_at).toLocaleDateString()}` }))}
              />
            </Field>
          )
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Paid from" htmlFor="pay-account">
                <AccountSelect id="pay-account" value={account} onChange={setAccount} filter={isPayFromAccount} />
              </Field>
              <Field label="Amount" htmlFor="pay-amount">
                <MoneyInput id="pay-amount" value={amount} onChange={setAmount} suffix="USD" />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Paid on" htmlFor="pay-date"><Input id="pay-date" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
              <Field label="Reference" htmlFor="pay-ref" optional><Input id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Bank reference" /></Field>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

export function ExpenseModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const { can } = useSession();
  const { data: vendors } = useVendors();
  const [method, setMethod] = useState<"onchain" | "offchain">("offchain");
  const [form, setForm] = useState({ title: "", amount: "", account_id: "", vendor_id: "", expense_date: todayIso(), outgoing_transfer_id: "", paid_from_account_id: "", notes: "" });
  const [busy, setBusy] = useState<"save" | "approve" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [key] = useState(newIdempotencyKey);
  const { data: open_ } = useApi<{ outgoing: any[] }>(open && method === "onchain" ? "/v1/accounting/unclassified" : null);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (approve: boolean) => {
    setBusy(approve ? "approve" : "save");
    setError(null);
    try {
      const body =
        method === "onchain"
          ? { title: form.title, account_id: form.account_id || null, vendor_id: form.vendor_id || null, outgoing_transfer_id: form.outgoing_transfer_id, notes: form.notes || null, approve }
          : { title: form.title, amount: form.amount, account_id: form.account_id || null, vendor_id: form.vendor_id || null, expense_date: form.expense_date, paid_from_account_id: form.paid_from_account_id, notes: form.notes || null, approve };
      const x = await api<{ id: string }>("/v1/expenses", { method: "POST", idempotencyKey: `${key}-${approve}`, body });
      toast("success", approve ? "Expense recorded." : "Expense saved for approval.");
      onCreated(x.id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };
  const ready = form.title.trim() && (method === "onchain" ? !!form.outgoing_transfer_id : Number(form.amount) > 0 && !!form.paid_from_account_id);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record an expense"
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={busy === "save"} disabled={!ready} onClick={() => submit(false)}>Save for approval</Button>
          {can("financials:approve") && <Button variant="primary" loading={busy === "approve"} disabled={!ready} onClick={() => submit(true)}>Record expense</Button>}
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        <Field label="What was it?" htmlFor="x-title">
          <Input id="x-title" value={form.title} onChange={(e) => set("title")(e.target.value)} placeholder="Figma, annual plan" autoFocus />
        </Field>
        <ChoiceGroup value={method} onChange={(v) => setMethod(v as "onchain" | "offchain")} label="How was it paid?">
          <ChoiceCard id="x-onchain" value="onchain" selected={method === "onchain"} title="From a monitored wallet" description="Link the transfer Setra saw. Its amount is the expense." />
          <ChoiceCard id="x-offchain" value="offchain" selected={method === "offchain"} title="Some other way" description="Card, bank, or paid personally by an owner." />
        </ChoiceGroup>
        {method === "onchain" ? (
          <Field label="Transfer" htmlFor="x-transfer">
            <Select
              id="x-transfer"
              value={form.outgoing_transfer_id}
              onValueChange={set("outgoing_transfer_id")}
              placeholder={!open_ ? "Loading transfers…" : open_.outgoing.length ? "Choose the transfer" : "No unclassified transfers"}
              options={(open_?.outgoing ?? []).map((t) => ({ value: t.id, label: `${tokenAmount(t.amount, t.asset)} to ${t.vendor?.name ?? shortAddress(t.to_address)} · ${new Date(t.sent_at).toLocaleDateString()}` }))}
            />
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Amount" htmlFor="x-amount"><MoneyInput id="x-amount" value={form.amount} onChange={set("amount")} suffix="USD" /></Field>
            <Field label="Paid from" htmlFor="x-from"><AccountSelect id="x-from" value={form.paid_from_account_id} onChange={set("paid_from_account_id")} filter={isPayFromAccount} /></Field>
            <Field label="Date" htmlFor="x-date"><Input id="x-date" type="date" value={form.expense_date} onChange={(e) => set("expense_date")(e.target.value)} /></Field>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Expense account" htmlFor="x-account" optional hint="Defaults to the vendor's usual account, or General Expenses.">
            <AccountSelect id="x-account" value={form.account_id} onChange={set("account_id")} filter={isSpendAccount} />
          </Field>
          <Field label="Vendor" htmlFor="x-vendor" optional>
            <Select id="x-vendor" value={form.vendor_id} onValueChange={set("vendor_id")} placeholder="None" options={[{ value: "", label: "None" }, ...(vendors?.data ?? []).map((v) => ({ value: v.id, label: v.name }))]} />
          </Field>
        </div>
        <Field label="Notes" htmlFor="x-notes" optional>
          <Textarea id="x-notes" rows={2} value={form.notes} onChange={(e) => set("notes")(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/** Recurring bill schedules: rent, subscriptions, retainers. Bills are created when due. */
export function RecurringBills() {
  const { can } = useSession();
  const toast = useToast();
  const { data, mutate } = useApi<{ data: any[] }>("/v1/recurring-bills");
  const [creating, setCreating] = useState(false);
  const setStatus = async (id: string, status: string) => {
    try {
      await api(`/v1/recurring-bills/${id}/status`, { method: "POST", body: { status } });
      mutate();
    } catch (e) {
      toast("error", (e as ApiError).message);
    }
  };
  const every: Record<string, string> = { weekly: "Every week", monthly: "Every month", quarterly: "Every quarter", yearly: "Every year" };
  return (
    <Card title="Recurring bills" description="Rent, subscriptions and retainers. Setra creates each bill on schedule." actions={can("financials:write") ? <Button size="sm" onClick={() => setCreating(true)}>New schedule</Button> : undefined}>
      {!data || data.data.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted-foreground max-md:px-4">No schedules yet.</p>
      ) : (
        <ul className="divide-y">
          {data.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-6 py-3 max-md:px-4">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{r.vendor.name} · {r.title}</span>
                <span className="text-sm text-muted-foreground">
                  {every[r.frequency]} · {r.auto_approve ? "approved automatically" : "for approval"} · {r.status === "active" ? `next on ${calendarDate(r.next_date)}` : r.status} · {r.bills_created} created
                </span>
              </span>
              <span className="tabular font-semibold">{money(r.amount)}</span>
              {can("financials:write") && r.status !== "ended" && (
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setStatus(r.id, r.status === "active" ? "paused" : "active")}>{r.status === "active" ? "Pause" : "Resume"}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setStatus(r.id, "ended")}>End</Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {creating && <RecurringModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); mutate(); }} />}
    </Card>
  );
}

function RecurringModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const { data: vendors } = useVendors();
  const [form, setForm] = useState({ vendor_id: "", title: "", amount: "", account_id: "", frequency: "monthly", start_date: todayIso(), end_date: "", due_days: "14", auto_approve: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [key] = useState(newIdempotencyKey);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/v1/recurring-bills", { method: "POST", idempotencyKey: key, body: { ...form, account_id: form.account_id || null, end_date: form.end_date || null, due_days: Number(form.due_days) || 0 } });
      toast("success", "Schedule created. Bills due today or earlier were created now.");
      onCreated();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} wide title="New recurring bill" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!form.vendor_id || !form.title.trim() || !(Number(form.amount) > 0)} onClick={submit}>Create schedule</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Vendor" htmlFor="rb-vendor"><Select id="rb-vendor" value={form.vendor_id} onValueChange={set("vendor_id")} placeholder="Choose a vendor" options={(vendors?.data ?? []).map((v) => ({ value: v.id, label: v.name }))} /></Field>
          <Field label="What is it?" htmlFor="rb-title"><Input id="rb-title" value={form.title} onChange={(e) => set("title")(e.target.value)} placeholder="Office rent" /></Field>
          <Field label="Amount" htmlFor="rb-amount"><MoneyInput id="rb-amount" value={form.amount} onChange={set("amount")} suffix="USD" /></Field>
          <Field label="Expense account" htmlFor="rb-account" optional><AccountSelect id="rb-account" value={form.account_id} onChange={set("account_id")} filter={isSpendAccount} /></Field>
          <Field label="Repeats" htmlFor="rb-freq"><Select id="rb-freq" value={form.frequency} onValueChange={set("frequency")} options={[{ value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "quarterly", label: "Quarterly" }, { value: "yearly", label: "Yearly" }]} /></Field>
          <Field label="Due" htmlFor="rb-due" hint="Days after each bill date."><Input id="rb-due" inputMode="numeric" value={form.due_days} onChange={(e) => set("due_days")(e.target.value.replace(/\D/g, "").slice(0, 3))} /></Field>
          <Field label="First bill" htmlFor="rb-start"><Input id="rb-start" type="date" value={form.start_date} onChange={(e) => set("start_date")(e.target.value)} /></Field>
          <Field label="Last bill" htmlFor="rb-end" optional><Input id="rb-end" type="date" value={form.end_date} min={form.start_date} onChange={(e) => set("end_date")(e.target.value)} /></Field>
        </div>
        {can("financials:approve") && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.auto_approve} onChange={(e) => setForm((f) => ({ ...f, auto_approve: e.target.checked }))} className="accent-[var(--primary)]" />
            Approve each bill automatically (it becomes a payable as soon as it's created)
          </label>
        )}
      </div>
    </Modal>
  );
}
