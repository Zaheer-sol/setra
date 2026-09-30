"use client";

import { Attachments } from "@/components/attachments";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Ban, CheckCheck, Wallet } from "lucide-react";
import { Badge, BigMoney, Button, Card, ErrorState, KV, PageHeader, SkeletonBlock, TextLink } from "@/components/app-ui";
import { BILL_LABEL, BILL_TONE, EntryStatus, FinancialsGate, ReasonModal, TxProof, calendarDate, useAction } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { PayBillModal } from "@/components/payables-components";
import { api, useApi } from "@/lib/api";
import { money } from "@/lib/format";

function BillView() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: b, error, mutate } = useApi<any>(`/v1/bills/${id}`);
  const { busy, run } = useAction();
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!b) return <SkeletonBlock height={400} />;
  const payable = ["approved", "partially_paid"].includes(b.status);

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Bills", href: "/app/bills" }, { label: `${b.vendor.name} · ${b.number}` }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {b.title}
            <Badge tone={b.overdue ? "danger" : BILL_TONE[b.status]}>{b.overdue ? "Overdue" : BILL_LABEL[b.status]}</Badge>
          </span>
        }
        description={<>Bill <span className="font-mono">{b.number}</span> from <TextLink href={`/app/vendors/${b.vendor.id}`}>{b.vendor.name}</TextLink></>}
        actions={
          <>
            {b.status === "draft" && can("financials:approve") && (
              <Button variant="primary" icon={<CheckCheck />} loading={busy === "approve"} onClick={() => run("approve", `/v1/bills/${id}/approve`, undefined, "Bill approved. It's now a payable.", () => mutate())}>
                Approve
              </Button>
            )}
            {payable && can("financials:approve") && (
              <Button variant="primary" icon={<Wallet />} onClick={() => setPaying(true)}>
                Record payment
              </Button>
            )}
            {["draft", "approved"].includes(b.status) && b.amount_paid === "0.00" && can("financials:approve") && (
              <Button variant="ghost" icon={<Ban />} onClick={() => setVoiding(true)}>
                Void
              </Button>
            )}
          </>
        }
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px] [&>*]:min-w-0">
        <div className="grid gap-6 [&>*]:min-w-0">
          <Card title="Payments">
            {b.payments.length === 0 ? (
              <p className="px-6 py-5 text-sm text-muted-foreground max-md:px-4">{b.status === "draft" ? "Approve the bill before paying it." : b.status === "void" ? "This bill was voided." : "No payments yet."}</p>
            ) : (
              <ul className="divide-y">
                {b.payments.map((p: any) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-4 px-6 py-3 max-md:px-4">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{calendarDate(p.paid_on)}</span>
                      <span className="block text-sm text-muted-foreground">
                        {p.method === "onchain" ? <>Onchain · <TxProof hash={p.transaction_hash} /></> : <>From {p.paid_from ? `${p.paid_from.code} ${p.paid_from.name}` : "an off-chain account"}{p.reference ? ` · ${p.reference}` : ""}</>}
                        {p.by && ` · by ${p.by}`}
                      </span>
                    </span>
                    <span className="tabular font-semibold">{money(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Attachments objectType="bill" objectId={b.id} />
          <Card title="In the books" description="The journal entries this bill created.">
            {b.journal_entries.length === 0 ? (
              <p className="px-6 py-5 text-sm text-muted-foreground max-md:px-4">Nothing posted yet. A bill reaches the ledger when it's approved.</p>
            ) : (
              <ul className="divide-y">
                {b.journal_entries.map((e: any) => (
                  <li key={e.id}>
                    <Link href={`/app/accounting/journal/${e.id}`} className="flex items-center gap-4 px-6 py-3 transition-colors hover:bg-accent/50 max-md:px-4">
                      <span className="w-20 shrink-0 font-mono text-sm">{e.number}</span>
                      <span className="min-w-0 flex-1 truncate">{e.description}</span>
                      <EntryStatus status={e.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <Card padded>
          <p className="text-sm font-medium text-muted-foreground">{b.status === "paid" ? "Paid in full" : "Still owed"}</p>
          <BigMoney value={b.status === "paid" ? b.amount : b.amount_remaining} className="mt-1" />
          <div className="mt-4">
            <KV
              items={[
                ["Amount", <span key="a" className="tabular">{money(b.amount)}</span>],
                b.amount_paid !== "0.00" && ["Paid", <span key="p" className="tabular">{money(b.amount_paid)}</span>],
                ["Account", b.account.code ? <Link key="ac" href={`/app/accounting/accounts/${b.account.id}`} className="hover:underline">{b.account.code} {b.account.name}</Link> : "-"],
                ["Bill date", calendarDate(b.bill_date, { year: true })],
                ["Due", b.due_date ? calendarDate(b.due_date, { year: true }) : "No due date"],
                b.approved_by && ["Approved by", b.approved_by],
                b.void_reason && ["Voided because", b.void_reason]
              ]}
            />
          </div>
        </Card>
      </div>
      <PayBillModal open={paying} onClose={() => setPaying(false)} bill={b} onPaid={() => mutate()} />
      <ReasonModal
        open={voiding}
        onClose={() => setVoiding(false)}
        title={`Void bill ${b.number}?`}
        description={b.status === "approved" ? "The payable is reversed with a new entry. The bill stays on record as void." : "The bill stays on record as void."}
        confirmLabel="Void bill"
        danger
        onConfirm={async (reason) => {
          await api(`/v1/bills/${id}/void`, { method: "POST", body: { reason } });
          mutate();
        }}
      />
    </div>
  );
}

export default function BillPage() {
  return (
    <FinancialsGate>
      <BillView />
    </FinancialsGate>
  );
}
