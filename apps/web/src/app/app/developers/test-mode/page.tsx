"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, FlaskConical } from "lucide-react";
import { useSession } from "@/components/session";
import { Alert, Button, Card, ChoiceCard, ChoiceGroup, Field, Input, PageHeader, Select, TextLink, useToast } from "@/components/app-ui";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { api, useApi, type ApiError } from "@/lib/api";

const SCENARIOS = [
  { key: "exact", title: "Exact payment", desc: "The full remaining amount. Matches deterministically and marks the invoice paid.", needsInvoice: true },
  { key: "partial", title: "Partial payment", desc: "75% of the remaining amount. Applied only when the sender is a known customer wallet; otherwise it needs review.", needsInvoice: true },
  { key: "overpaid", title: "Overpayment", desc: "125% of the remaining amount from the customer's wallet. Paid, with an overpayment exception.", needsInvoice: true },
  { key: "duplicate", title: "Duplicate", desc: "The invoice amount again from the customer's wallet, after it's paid.", needsInvoice: true },
  { key: "unknown", title: "Unknown payment", desc: "$740 from a wallet Setra has never seen. Lands in Needs review with candidates.", needsInvoice: false },
  { key: "wrong_token", title: "Wrong token", desc: "A token the wallet doesn't accept. Recorded and flagged; it never settles an invoice.", needsInvoice: false }
];

export default function TestModePage() {
  const router = useRouter();
  const toast = useToast();
  const { isTest } = useSession();
  const { data: invoices } = useApi<{ data: any[] }>("/v1/invoices?limit=100");
  const [scenario, setScenario] = useState("exact");
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [finalize, setFinalize] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const chosen = SCENARIOS.find((s) => s.key === scenario)!;

  if (!isTest) {
    return (
      <div className="grid gap-6 [&>*]:min-w-0">
        <PageHeader title="Test payments" />
        <Alert tone="info" title="Switch to test mode">Simulated payments exist only in test mode. Use the Test mode switch in the sidebar.</Alert>
      </div>
    );
  }

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Developers", href: "/app/developers" }, { label: "Test payments" }]}
        title="Test payments"
        description="Send simulated payments through the exact pipeline real Monad payments use: matching, exceptions, events and webhooks. Nothing moves onchain."
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px] [&>*]:min-w-0">
        <Card title="Scenario">
          <form
            className="px-6 py-5 max-md:px-4 grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const p = await api<{ id: string }>("/v1/test/payments", { method: "POST", body: { scenario, invoice_id: invoiceId || undefined, amount: amount || undefined, finalize } });
                toast("success", finalize ? "Simulated payment settled." : "Simulated payment detected. Finalize it from the payment page.");
                router.push(`/app/payments/${p.id}`);
              } catch (err) {
                setError(err as ApiError);
                setBusy(false);
              }
            }}
          >
            {error && <Alert tone="danger">{error.message}</Alert>}
            <ChoiceGroup label="Scenario" value={scenario} onChange={setScenario} className="sm:grid-cols-2">
              {SCENARIOS.map((s) => (
                <ChoiceCard key={s.key} id={`scenario-${s.key}`} value={s.key} selected={scenario === s.key} title={s.title} description={s.desc} />
              ))}
            </ChoiceGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Invoice" htmlFor="t-invoice" optional={!chosen.needsInvoice}>
                <Select id="t-invoice" value={invoiceId} onValueChange={setInvoiceId} required={chosen.needsInvoice} options={[
                  { value: "", label: chosen.needsInvoice ? "Choose an invoice…" : "None" },
                  ...(invoices?.data
                    .filter((i) => (scenario === "duplicate" ? ["paid", "overpaid"].includes(i.status) : ["open", "partially_paid"].includes(i.status)))
                    .map((i) => ({ value: i.id, label: `${i.number} · ${i.customer.name} · $${i.amount_remaining}` })) ?? [])
                ]} />
              </Field>
              <Field label="Amount override" htmlFor="t-amount" optional hint="Decimal USD, e.g. 1500.00">
                <Input id="t-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="Automatic" />
              </Field>
            </div>
            <div className="flex items-start gap-2.5">
              <Checkbox id="finalize" checked={finalize} onCheckedChange={(v) => setFinalize(v === true)} className="mt-0.5" />
              <Label htmlFor="finalize" className="grid gap-0.5 leading-normal font-normal">
                Finalize immediately
                <span className="text-xs text-muted-foreground">Untick to see the “Payment detected → confirming” state first.</span>
              </Label>
            </div>
            <Button type="submit" variant="primary" loading={busy} icon={<FlaskConical />}>
              Send simulated payment
            </Button>
          </form>
        </Card>
        <div className="grid gap-6 [&>*]:min-w-0">
          <Card title="Real testnet payments" padded>
            <p className="text-sm text-muted-foreground">
              Test mode also watches Monad testnet for real. Pay an invoice from its hosted page with testnet USDC (Circle faucet) and Setra detects it the same way it will on mainnet.
            </p>
            <TextLink href="/app/invoices" className="mt-2.5 inline-flex items-center gap-1.5 text-sm">
              Open an invoice <ArrowRight className="size-3.5" />
            </TextLink>
          </Card>
          <Card title="Reorgs" padded>
            <p className="text-sm text-muted-foreground">
              Open any simulated payment and choose <strong>Simulate reorg</strong> to invalidate its block. Setra records compensating history, reopens the invoice and sends <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.86em]">payment.reversed</code>.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
