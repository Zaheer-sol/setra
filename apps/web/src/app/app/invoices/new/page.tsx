"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ListPlus, Plus, Wallet, X } from "lucide-react";
import { useSession } from "@/components/session";
import { Alert, Button, ButtonLink, Card, CardBody, Chain, EmptyState, Field, fieldErrors, Input, LineItems, Modal, MoneyInput, PageHeader, Select, SkeletonBlock, Textarea, TextLink, useToast } from "@/components/app-ui";
import { Separator } from "@/components/ui/separator";
import { api, newIdempotencyKey, useApi, type ApiError } from "@/lib/api";
import { fromUnits, money, toUnits } from "@/lib/format";

interface LineItemDraft {
  key: number;
  description: string;
  quantity: string;
  unit_amount: string;
}

interface WalletOpt {
  id: string;
  name: string;
  address: string;
  network: string;
  network_name: string;
  assets: Array<{ symbol: string }>;
}

function NewInvoiceForm() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { isTest } = useSession();
  const { data: customers, mutate: refreshCustomers } = useApi<{ data: Array<{ id: string; name: string; email: string | null }> }>("/v1/customers?limit=100");
  const { data: wallets } = useApi<{ data: WalletOpt[] }>("/v1/wallets");
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [form, setForm] = useState({
    customer_id: params.get("customer") ?? "",
    title: "",
    purpose: "",
    amount: "",
    number: "",
    network: "monad",
    asset: "USDC",
    wallet_id: "",
    due_at: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
    expires_in: "30"
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [addCustomer, setAddCustomer] = useState(false);
  const errs = fieldErrors(error);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const eligible = useMemo(() => (wallets?.data ?? []).filter((w) => w.network === form.network && w.assets.some((a) => a.symbol === form.asset)), [wallets, form.network, form.asset]);
  useEffect(() => {
    if (!form.wallet_id && eligible[0]) setForm((f) => ({ ...f, wallet_id: eligible[0]!.id }));
  }, [eligible, form.wallet_id]);
  const networks = [...new Map((wallets?.data ?? []).map((w) => [w.network, w.network_name])).entries()];
  const assets = [...new Set((wallets?.data ?? []).filter((w) => w.network === form.network).flatMap((w) => w.assets.map((a) => a.symbol)))];
  const [items, setItems] = useState<LineItemDraft[]>([]);
  const itemized = items.length > 0;
  // Exact totals (6-decimal integers), never floating point.
  const itemRows = items.map((i) => {
    const unit = toUnits(i.unit_amount);
    const qty = /^[1-9]\d{0,6}$/.test(i.quantity) ? BigInt(i.quantity) : null;
    return { ...i, valid: !!i.description.trim() && unit !== null && unit > 0n && qty !== null, amount: unit !== null && qty !== null ? unit * qty : null };
  });
  const itemsTotal = itemRows.reduce((sum, r) => sum + (r.amount ?? 0n), 0n);
  const itemsValid = itemRows.every((r) => r.valid);
  const manualUnits = toUnits(form.amount);
  const amountValid = itemized ? itemsValid && itemsTotal > 0n : manualUnits !== null && manualUnits > 0n;
  const totalDisplay = itemized ? fromUnits(itemsTotal) : amountValid ? form.amount : null;
  const setItem = (key: number, patch: Partial<LineItemDraft>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const addItem = () => setItems((list) => [...list, { key: Date.now() + list.length, description: "", quantity: "1", unit_amount: list.length === 0 && form.amount ? form.amount : "" }]);

  if (!customers || !wallets) return <SkeletonBlock height={480} />;
  if (!wallets.data.length) {
    return (
      <Card>
        <EmptyState
          icon={<Wallet />}
          title="Add a receiving wallet first" mascot="focused"
          actions={
            <ButtonLink href="/app/wallets?add=1" variant="primary" size="sm">
              Add receiving wallet
            </ButtonLink>
          }
        >
          Invoices are paid directly to a wallet you control. Add one; Setra only needs the public address.
        </EmptyState>
      </Card>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const due = form.due_at ? new Date(`${form.due_at}T23:59:59`) : null;
      const expires = form.expires_in !== "never" ? new Date(Date.now() + Number(form.expires_in) * 86400000) : null;
      const invoice = await api<{ id: string; number: string }>("/v1/invoices", {
        method: "POST",
        idempotencyKey,
        body: {
          customer_id: form.customer_id,
          title: form.title.trim(),
          purpose: form.purpose.trim() || undefined,
          ...(itemized
            ? { line_items: itemRows.map((r) => ({ description: r.description.trim(), quantity: Number(r.quantity), unit_amount: r.unit_amount })) }
            : { amount: form.amount }),
          number: form.number || undefined,
          network: form.network,
          asset: form.asset,
          wallet_id: form.wallet_id || undefined,
          due_at: due?.toISOString(),
          expires_at: expires && due && expires < due ? due.toISOString() : expires?.toISOString()
        }
      });
      toast("success", `${invoice.number} created. Share the payment link with your customer.`);
      router.push(`/app/invoices/${invoice.id}`);
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  };

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px] [&>*]:min-w-0">
      <Card>
        <form className="grid gap-5 px-6 py-5 max-md:px-4" onSubmit={submit}>
          {error && !error.details && <Alert tone="danger">{error.message}</Alert>}
          <Field label="Customer" htmlFor="customer" error={errs.customer_id}>
            <div className="flex items-center gap-2">
              <Select id="customer" value={form.customer_id} onValueChange={(customer_id) => setForm((f) => ({ ...f, customer_id }))} required invalid={!!errs.customer_id} placeholder="Choose a customer…" options={customers.data.map((c) => ({
                value: c.id,
                label: `${c.name}${c.email ? `, ${c.email}` : ""}`
              }))} />
              <Button type="button" icon={<Plus />} onClick={() => setAddCustomer(true)}>
                New
              </Button>
            </div>
          </Field>
          <Field label="What is this payment for?" htmlFor="title" error={errs.title} hint="Your customer sees this before paying, and it stays attached to the payment.">
            <Input id="title" value={form.title} onChange={set("title")} placeholder="September Infrastructure Services" maxLength={140} required invalid={!!errs.title} />
          </Field>
          <Field label="Details" htmlFor="purpose" optional error={errs.purpose} hint="A line of context under the title.">
            <Textarea id="purpose" rows={2} value={form.purpose} onChange={set("purpose")} placeholder="Cloud architecture, deployment and monitoring" maxLength={500} />
          </Field>
          {itemized && (
            <div className="grid gap-2 rounded-2xl bg-muted/70 p-3.5" role="group" aria-label="Line items">
              <div className="grid grid-cols-[minmax(0,1fr)_64px_132px_96px_28px] gap-2 text-xs font-semibold text-muted-foreground max-sm:hidden" aria-hidden="true">
                <span>Item</span>
                <span>Qty</span>
                <span>Unit price</span>
                <span className="text-right">Amount</span>
                <span />
              </div>
              {itemRows.map((r, idx) => (
                <div
                  className="grid grid-cols-[minmax(0,1fr)_64px_132px_96px_28px] items-center gap-2 max-sm:grid-cols-[64px_minmax(0,1fr)_28px] max-sm:border-b max-sm:pb-2 max-sm:[grid-template-areas:'desc_desc_remove'_'qty_unit_unit'_'amt_amt_amt'] max-sm:[&>:nth-child(1)]:[grid-area:desc] max-sm:[&>:nth-child(2)]:[grid-area:qty] max-sm:[&>:nth-child(3)]:[grid-area:unit] max-sm:[&>:nth-child(4)]:[grid-area:amt] max-sm:[&>:nth-child(5)]:[grid-area:remove]"
                  key={r.key}
                >
                  <Input aria-label={`Item ${idx + 1} description`} value={r.description} onChange={(e) => setItem(r.key, { description: e.target.value })} placeholder="Cloud architecture" maxLength={200} />
                  <Input aria-label={`Item ${idx + 1} quantity`} className="tabular" inputMode="numeric" value={r.quantity} onChange={(e) => setItem(r.key, { quantity: e.target.value.replace(/\D/g, "") })} invalid={r.quantity !== "" && !/^[1-9]\d{0,6}$/.test(r.quantity)} />
                  <MoneyInput aria-label={`Item ${idx + 1} unit price`} value={r.unit_amount} placeholder="1,200.00" onChange={(v) => setItem(r.key, { unit_amount: v })} invalid={r.unit_amount !== "" && toUnits(r.unit_amount) === null} />
                  <span className="tabular text-right text-sm text-foreground/80">{r.amount !== null ? money(fromUnits(r.amount)) : "-"}</span>
                  <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" aria-label={`Remove item ${idx + 1}`} onClick={() => setItems((list) => list.filter((i) => i.key !== r.key))} icon={<X aria-hidden="true" />} />
                </div>
              ))}
              <div className="flex justify-between border-t pt-2 text-sm">
                <span>Total</span>
                <strong className="tabular">{money(fromUnits(itemsTotal))}</strong>
              </div>
              {errs.line_items && <p className="text-xs text-destructive">{errs.line_items}</p>}
            </div>
          )}
          <div>
            <Button type="button" size="sm" variant="ghost" icon={<ListPlus />} onClick={addItem}>
              {itemized ? "Add item" : "Itemize this payment"}
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Amount" htmlFor="amount" error={errs.amount} hint={itemized ? "The total of the line items." : "Settles 1:1 in the selected stablecoin."}>
              <MoneyInput
                id="amount"
                large
                suffix="USD"
                placeholder="2,000.00"
                value={itemized ? fromUnits(itemsTotal) : form.amount}
                readOnly={itemized}
                onChange={(v) => setForm((f) => ({ ...f, amount: v }))}
                required={!itemized}
                invalid={!!errs.amount || (!itemized && form.amount !== "" && !amountValid)}
              />
            </Field>
            <Field label="Invoice number" htmlFor="number" optional hint="Leave blank to number automatically." error={errs.number}>
              <Input id="number" className="font-mono text-[0.92em]" value={form.number} onChange={set("number")} placeholder="INV-2052" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Network" htmlFor="network">
              <Select id="network" value={form.network} onValueChange={(network) => setForm((f) => ({ ...f, network, wallet_id: "" }))} options={networks.map(([value, label]) => ({ value, label }))} />
            </Field>
            <Field label="Stablecoin" htmlFor="asset">
              <Select id="asset" value={form.asset} onValueChange={(asset) => setForm((f) => ({ ...f, asset, wallet_id: "" }))} options={assets.map((a) => ({ value: a, label: a }))} />
            </Field>
          </div>
          <Field label="Receiving wallet" htmlFor="wallet" error={errs.wallet_id} hint="Funds settle directly here. Setra never holds them.">
            {eligible.length ? (
              <Select id="wallet" value={form.wallet_id} onValueChange={(wallet_id) => setForm((f) => ({ ...f, wallet_id }))} options={eligible.map((w) => ({
                value: w.id,
                label: `${w.name}, ${w.address.slice(0, 6)}…${w.address.slice(-4)}`
              }))} />
            ) : (
              <Alert tone="warning">
                No wallet accepts {form.asset} on this network. <TextLink href="/app/wallets?add=1">Add one</TextLink>.
              </Alert>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Due date" htmlFor="due" optional>
              <Input id="due" type="date" value={form.due_at} onChange={set("due_at")} />
            </Field>
            <Field label="Payment link expires" htmlFor="expires" hint="Payments after expiry are flagged for review, not auto-applied.">
              <Select id="expires" value={form.expires_in} onValueChange={(expires_in) => setForm((f) => ({ ...f, expires_in }))} options={[
                { value: "7", label: "In 7 days" },
                { value: "30", label: "In 30 days" },
                { value: "90", label: "In 90 days" },
                { value: "never", label: "Never" }
              ]} />
            </Field>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <ButtonLink href="/app/invoices" variant="ghost">
              Cancel
            </ButtonLink>
            <Button type="submit" variant="primary" loading={busy} disabled={!eligible.length || !amountValid || !form.customer_id || !form.title.trim()}>
              Create invoice
            </Button>
          </div>
        </form>
      </Card>
      <div className="grid gap-6 [&>*]:min-w-0">
        <Card title="Preview" description="What your customer will see">
          <CardBody>
            <div className="text-sm text-muted-foreground">Billed to {customers.data.find((c) => c.id === form.customer_id)?.name ?? "your customer"}</div>
            <div className="mt-1.5 mb-0.5 text-[1.0625rem] font-semibold tracking-[-0.02em] break-words">{form.title.trim() || <span className="font-normal text-muted-foreground">What is this payment for?</span>}</div>
            {form.purpose.trim() && <div className="text-sm text-muted-foreground">{form.purpose.trim()}</div>}
            {itemized && <LineItems items={itemRows.map((r) => ({ description: r.description.trim() || "Item", quantity: Number(r.quantity) || 1, amount: r.amount !== null ? fromUnits(r.amount) : "0" }))} />}
            <div className="tabular mt-2.5 mb-0.5 text-[2rem] font-semibold tracking-[-0.03em]">{totalDisplay ? money(totalDisplay) : "$0.00"}</div>
            <Separator className="my-4" />
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Pay with</span>
                <strong className="font-semibold">{form.asset}</strong>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Network</span>
                <Chain network={form.network} name={networks.find(([k]) => k === form.network)?.[1]} />
              </div>
            </div>
          </CardBody>
        </Card>
        <Alert tone="neutral">
          {isTest
            ? "Test mode: this invoice lives on Monad testnet. Pay it with testnet USDC or simulate a payment. No real funds move."
            : "Live mode: this invoice is payable in real USDC on Monad mainnet, directly to your wallet."}
        </Alert>
      </div>
      <QuickCustomer
        open={addCustomer}
        onClose={() => setAddCustomer(false)}
        onCreated={async (id) => {
          await refreshCustomers();
          setForm((f) => ({ ...f, customer_id: id }));
          setAddCustomer(false);
        }}
      />
    </div>
  );
}

function QuickCustomer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New customer"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const c = await api<{ id: string }>("/v1/customers", { method: "POST", body: { name, email: email || undefined } });
                setName("");
                setEmail("");
                onCreated(c.id);
              } catch (e) {
                setError(e as ApiError);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create customer
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        <Field label="Name" htmlFor="qc-name">
          <Input id="qc-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Billing email" htmlFor="qc-email" optional>
          <Input id="qc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <p className="text-xs text-muted-foreground">Add their wallet addresses on the customer page so partial payments can be matched automatically.</p>
      </div>
    </Modal>
  );
}

export default function NewInvoicePage() {
  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader breadcrumbs={[{ label: "Invoices", href: "/app/invoices" }, { label: "New invoice" }]} title="New invoice" description="Request a stablecoin payment. Your customer gets a hosted page to pay from any wallet." />
      <Suspense>
        <NewInvoiceForm />
      </Suspense>
    </div>
  );
}
