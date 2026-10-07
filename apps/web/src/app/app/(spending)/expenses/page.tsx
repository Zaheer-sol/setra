"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { CreditCard, Plus, Search } from "lucide-react";
import { Badge, Button, Card, EmptyState, ErrorState, Metric, Metrics, Money, NavTabs, PageHeader, SearchInput, SkeletonRows, Toolbar } from "@/components/app-ui";
import { EXPENSE_LABEL, EXPENSE_TONE, FinancialsGate, calendarDate } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { ExpenseModal } from "@/components/payables-components";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { qs, useApi } from "@/lib/api";

function ExpensesView() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useSession();
  const status = params.get("status") ?? "";
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(params.get("new") === "1");
  const { data, error, mutate } = useApi<{ data: any[]; has_more: boolean; summary: { this_month: string; awaiting_approval: number } }>(`/v1/expenses${qs({ status, search: query, limit: 100 })}`, { keepPreviousData: true });
  const tab = (s: string, label: string) => ({ href: `/app/expenses${s ? `?status=${s}` : ""}`, label, active: status === s });

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        title="Expenses"
        description="Record subscriptions, fees and one-off purchases that are not vendor bills. Link a monitored transfer or record the account used to pay."
        actions={can("financials:write") && <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>Record expense</Button>}
      />
      {data && (
        <Metrics className="lg:grid-cols-2 xl:grid-cols-2">
          <Metric label="Recorded this month" value={data.summary.this_month} money href="/app/reports/profit-and-loss" />
          <Metric label="Awaiting approval" value={String(data.summary.awaiting_approval)} href="/app/expenses?status=pending" />
        </Metrics>
      )}
      <Card>
        <NavTabs label="Expense status" items={[tab("", "All"), tab("pending", "Awaiting approval"), tab("approved", "Recorded"), tab("rejected", "Rejected")]} />
        <Toolbar role="search" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}>
          <SearchInput placeholder="Description or vendor" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search expenses" />
        </Toolbar>
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data ? (
          <SkeletonRows rows={6} cols={5} />
        ) : data.data.length === 0 ? (
          query || status ? (
            <EmptyState icon={<Search />} title="No expenses match" mascot="curious">Try another filter.</EmptyState>
          ) : (
            <EmptyState icon={<CreditCard />} title="No expenses yet" mascot="welcome" actions={can("financials:write") && <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>Record expense</Button>}>
              Expenses you record land in the right account and show up on your profit and loss.
            </EmptyState>
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[92px]">Date</TableHead>
                <TableHead>Expense</TableHead>
                <TableHead className="max-md:hidden">Account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((x) => (
                <TableRow key={x.id} className="cursor-pointer" tabIndex={0} onClick={() => router.push(`/app/expenses/${x.id}`)} onKeyDown={(e) => e.key === "Enter" && router.push(`/app/expenses/${x.id}`)}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{calendarDate(x.expense_date)}</TableCell>
                  <TableCell>
                    <span className="line-clamp-1 font-medium">{x.title}</span>
                    <span className="block text-xs text-muted-foreground">{[x.vendor?.name, x.method === "onchain" ? "Paid onchain" : "Paid off-chain"].filter(Boolean).join(" · ")}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground max-md:hidden">{x.account.code} {x.account.name}</TableCell>
                  <TableCell><Badge tone={EXPENSE_TONE[x.status]}>{EXPENSE_LABEL[x.status]}</Badge></TableCell>
                  <TableCell className="text-right font-semibold"><Money value={x.amount} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <ExpenseModal open={adding} onClose={() => setAdding(false)} onCreated={(id) => router.push(`/app/expenses/${id}`)} />
    </div>
  );
}

export default function ExpensesPage() {
  return (
    <FinancialsGate>
      <Suspense>
        <ExpensesView />
      </Suspense>
    </FinancialsGate>
  );
}
