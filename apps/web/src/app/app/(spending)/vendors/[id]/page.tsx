"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { FileText, Plus } from "lucide-react";
import { Address, Badge, BigMoney, Button, ButtonLink, Card, EmptyState, ErrorState, KV, Money, PageHeader, SkeletonBlock } from "@/components/app-ui";
import { BILL_LABEL, BILL_TONE, EXPENSE_LABEL, EXPENSE_TONE, FinancialsGate, calendarDate } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { BillModal } from "@/components/payables-components";
import { useApi } from "@/lib/api";

function VendorView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useSession();
  const [billing, setBilling] = useState(false);
  const { data: v, error, mutate } = useApi<any>(`/v1/vendors/${id}`);
  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!v) return <SkeletonBlock height={400} />;

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Vendors", href: "/app/vendors" }, { label: v.name }]}
        title={v.name}
        description={v.email ?? undefined}
        actions={
          <>
            <ButtonLink href={`/app/accounting/ledger?vendor_id=${v.id}&preset=all`}>Ledger</ButtonLink>
            {can("financials:write") && <Button variant="primary" icon={<Plus />} onClick={() => setBilling(true)}>Record bill</Button>}
          </>
        }
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px] [&>*]:min-w-0">
        <div className="grid gap-6 [&>*]:min-w-0">
          <Card title="Bills">
            {v.bills.length === 0 ? (
              <EmptyState icon={<FileText />} title="No bills yet">Record a bill when {v.name} invoices you.</EmptyState>
            ) : (
              <ul className="divide-y">
                {v.bills.map((b: any) => (
                  <li key={b.id}>
                    <Link href={`/app/bills/${b.id}`} className="flex items-center gap-4 px-6 py-3 transition-colors hover:bg-accent/50 max-md:px-4">
                      <span className="w-24 shrink-0 font-mono text-sm">{b.number}</span>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-1 font-medium">{b.title}</span>
                        <span className="text-xs text-muted-foreground">{calendarDate(b.bill_date)}{b.due_date ? ` · due ${calendarDate(b.due_date)}` : ""}</span>
                      </span>
                      <Badge tone={b.overdue ? "danger" : BILL_TONE[b.status]}>{b.overdue ? "Overdue" : BILL_LABEL[b.status]}</Badge>
                      <span className="w-28 text-right font-semibold"><Money value={b.status === "paid" || b.status === "void" ? b.amount : b.amount_remaining} /></span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {v.expenses.length > 0 && (
            <Card title="Expenses">
              <ul className="divide-y">
                {v.expenses.map((x: any) => (
                  <li key={x.id}>
                    <Link href={`/app/expenses/${x.id}`} className="flex items-center gap-4 px-6 py-3 transition-colors hover:bg-accent/50 max-md:px-4">
                      <span className="w-20 shrink-0 text-sm text-muted-foreground">{calendarDate(x.expense_date)}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{x.title}</span>
                      <Badge tone={EXPENSE_TONE[x.status]}>{EXPENSE_LABEL[x.status]}</Badge>
                      <span className="w-28 text-right font-semibold"><Money value={x.amount} /></span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <div className="grid gap-6 [&>*]:min-w-0">
          <Card padded>
            <p className="text-sm font-medium text-muted-foreground">You owe {v.name}</p>
            <BigMoney value={v.owed} className="mt-1" />
            <div className="mt-4">
              <KV
                items={[
                  ["Usual account", v.default_account ? <Link key="a" href={`/app/accounting/accounts/${v.default_account.id}`} className="hover:underline">{v.default_account.code} {v.default_account.name}</Link> : "General Expenses"],
                  v.external_ref && ["Your reference", v.external_ref],
                  v.notes && ["Notes", v.notes]
                ]}
              />
            </div>
          </Card>
          <Card title="Wallets" description="Transfers to these addresses show this vendor's name.">
            {v.wallet_addresses.length === 0 ? (
              <p className="px-6 py-4 text-sm text-muted-foreground max-md:px-4">None linked.</p>
            ) : (
              <ul className="divide-y">
                {v.wallet_addresses.map((a: any) => (
                  <li key={a.id} className="px-6 py-3 max-md:px-4">
                    <Address value={a.address} />
                    {a.label && <span className="block text-xs text-muted-foreground">{a.label}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      <BillModal open={billing} onClose={() => setBilling(false)} vendorId={v.id} onCreated={(bid) => router.push(`/app/bills/${bid}`)} />
    </div>
  );
}

export default function VendorPage() {
  return (
    <FinancialsGate>
      <VendorView />
    </FinancialsGate>
  );
}
