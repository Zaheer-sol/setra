"use client";

import Link from "next/link";
import { useState } from "react";
import { Coins, Fuel, Plus } from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, SkeletonRows, useToast } from "@/components/app-ui";
import { FinancialsGate, TxProof, calendarDate } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, useApi, type ApiError } from "@/lib/api";
import { timeAgo, todayIso } from "@/lib/format";

function RatesView() {
  const { can } = useSession();
  const [adding, setAdding] = useState<string | null>(null);
  const { data: rates, error, mutate } = useApi<{ data: any[] }>("/v1/accounting/fx-rates");
  const { data: fees } = useApi<{ data: any[] }>("/v1/accounting/network-fees");
  const waiting = (fees?.data ?? []).filter((f) => !f.journal_entry);

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Books", href: "/app/accounting" }, { label: "Exchange rates & gas" }]}
        title="Exchange rates & gas"
        description="Setra never guesses a price. To value something that isn't a US-dollar stablecoin (gas paid in MON, a euro stablecoin), it uses a rate you enter or one published by a named source, and records which rate it used on every entry."
        actions={can("financials:manage") && <Button variant="primary" icon={<Plus />} onClick={() => setAdding("MON")}>Add a rate</Button>}
      />
      {waiting.length > 0 && (
        <Alert tone="warning" title={`${waiting.length} network fee${waiting.length === 1 ? " is" : "s are"} waiting for a rate`}>
          Add a {waiting[0].symbol} rate covering {calendarDate(waiting[waiting.length - 1].paid_at.slice(0, 10), { year: true })}, then run Repair on the Books page.
        </Alert>
      )}
      <Card title="Rates" description="Your rates are used first; published rates fill in. A rate covers up to 31 days after its date.">
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !rates ? (
          <SkeletonRows rows={4} cols={4} />
        ) : rates.data.length === 0 ? (
          <EmptyState icon={<Coins />} title="No rates yet">You only need rates for gas fees and non-USD stablecoins. USDC and USDT0 are valued at their dollar peg.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Pair</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="max-md:hidden">Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">1 {r.base} = </TableCell>
                  <TableCell className="text-muted-foreground">{calendarDate(r.rate_date, { year: true })}</TableCell>
                  <TableCell className="tabular text-right">{r.rate.replace(/\.?0+$/, "")} {r.quote}</TableCell>
                  <TableCell className="max-md:hidden">{r.published ? <Badge tone="info" dot={false}>{r.source.toUpperCase()}</Badge> : <span className="text-sm text-muted-foreground">You{r.created_by_label ? ` (${r.created_by_label})` : ""}{r.note ? ` · ${r.note}` : ""}</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <Card title="Network fees" description="Gas your wallets paid to send stablecoin. Posted to Network Fees once there's a rate for the day.">
        {!fees ? (
          <SkeletonRows rows={4} cols={4} />
        ) : fees.data.length === 0 ? (
          <EmptyState icon={<Fuel />} title="No network fees recorded">When a monitored wallet sends stablecoin, Setra looks up the gas it paid.</EmptyState>
        ) : (
          <ul className="divide-y">
            {fees.data.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-3 px-6 py-3 max-md:px-4">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium tabular">{f.fee} {f.symbol}</span>
                  <span className="text-sm text-muted-foreground">{f.wallet.name} · {timeAgo(f.paid_at)} · <TxProof hash={f.transaction_hash} /></span>
                </span>
                {f.journal_entry ? (
                  <Link href={`/app/accounting/journal/${f.journal_entry.id}`} className="font-mono text-sm text-primary hover:underline">{f.journal_entry.number}</Link>
                ) : (
                  <Badge tone="warning">Needs a rate</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {adding && <RateModal base={adding} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); mutate(); }} />}
    </div>
  );
}

function RateModal({ base: initial, onClose, onSaved }: { base: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ base: initial, rate_date: todayIso(), rate: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/v1/accounting/fx-rates", { method: "POST", body: { base: form.base, quote: "USD", rate_date: form.rate_date, rate: form.rate.trim(), note: form.note || null } });
      toast("success", "Rate saved.");
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Add a rate" description="How many US dollars one unit was worth on that date. Use a source you'd show your accountant." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!form.base || !/^\d+(\.\d+)?$/.test(form.rate.trim())} onClick={submit}>Save rate</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Currency or token" htmlFor="r-base"><Input id="r-base" value={form.base} onChange={(e) => setForm((f) => ({ ...f, base: e.target.value.toUpperCase().slice(0, 10) }))} placeholder="MON" /></Field>
          <Field label="Date" htmlFor="r-date"><Input id="r-date" type="date" value={form.rate_date} max={todayIso()} onChange={(e) => setForm((f) => ({ ...f, rate_date: e.target.value }))} /></Field>
          <Field label="1 unit in USD" htmlFor="r-rate"><Input id="r-rate" inputMode="decimal" className="tabular" value={form.rate} onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value.replace(/[^\d.]/g, "") }))} placeholder="0.0420" /></Field>
        </div>
        <Field label="Source" htmlFor="r-note" optional hint="For example “CoinGecko daily close” or “Kraken fill”.">
          <Input id="r-note" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
        </Field>
      </div>
    </Modal>
  );
}

export default function RatesPage() {
  return (
    <FinancialsGate>
      <RatesView />
    </FinancialsGate>
  );
}
