"use client";

import { Attachments } from "@/components/attachments";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { CheckCheck, X } from "lucide-react";
import { Badge, BigMoney, Button, Card, ErrorState, KV, PageHeader, SkeletonBlock, TextLink } from "@/components/app-ui";
import { EXPENSE_LABEL, EXPENSE_TONE, EntryStatus, FinancialsGate, ReasonModal, TxProof, calendarDate, useAction } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { api, useApi } from "@/lib/api";

function ExpenseView() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data: x, error, mutate } = useApi<any>(`/v1/expenses/${id}`);
  const { busy, run } = useAction();
  const [rejecting, setRejecting] = useState(false);
  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!x) return <SkeletonBlock height={360} />;

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Expenses", href: "/app/expenses" }, { label: x.title }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {x.title}
            <Badge tone={EXPENSE_TONE[x.status]}>{EXPENSE_LABEL[x.status]}</Badge>
          </span>
        }
        description={x.vendor ? <>Paid to <TextLink href={`/app/vendors/${x.vendor.id}`}>{x.vendor.name}</TextLink></> : undefined}
        actions={
          x.status === "pending" &&
          can("financials:approve") && (
            <>
              <Button variant="ghost" icon={<X />} onClick={() => setRejecting(true)}>Reject</Button>
              <Button variant="primary" icon={<CheckCheck />} loading={busy === "approve"} onClick={() => run("approve", `/v1/expenses/${id}/approve`, {}, "Expense recorded in the books.", () => mutate())}>
                Approve
              </Button>
            </>
          )
        }
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px] [&>*]:min-w-0">
        <div className="grid gap-6 [&>*]:min-w-0">
        <Card title="In the books">
          {x.journal_entries.length === 0 ? (
            <p className="px-6 py-5 text-sm text-muted-foreground max-md:px-4">{x.status === "rejected" ? `Rejected: ${x.rejected_reason}` : "Not posted yet. An expense reaches the ledger when it's approved."}</p>
          ) : (
            <ul className="divide-y">
              {x.journal_entries.map((e: any) => (
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
          <Attachments objectType="expense" objectId={x.id} />
        </div>
        <Card padded>
          <BigMoney value={x.amount} />
          <div className="mt-4">
            <KV
              items={[
                ["Date", calendarDate(x.expense_date, { year: true })],
                ["Account", <Link key="a" href={`/app/accounting/accounts/${x.account.id}`} className="hover:underline">{x.account.code} {x.account.name}</Link>],
                ["Paid", x.method === "onchain" ? <span key="m" className="flex items-center gap-2">Onchain <TxProof hash={x.outgoing_transfer?.transaction_hash} /></span> : "Off-chain"],
                x.reference && ["Reference", x.reference],
                x.notes && ["Notes", x.notes],
                x.created_by && ["Recorded by", x.created_by],
                x.approved_by && ["Approved by", x.approved_by]
              ]}
            />
          </div>
        </Card>
      </div>
      <ReasonModal
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Reject this expense?"
        description="It won't be posted. It stays on record as rejected."
        confirmLabel="Reject expense"
        danger
        onConfirm={async (reason) => {
          await api(`/v1/expenses/${id}/reject`, { method: "POST", body: { reason } });
          mutate();
        }}
      />
    </div>
  );
}

export default function ExpensePage() {
  return (
    <FinancialsGate>
      <ExpenseView />
    </FinancialsGate>
  );
}
