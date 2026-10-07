"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { FileText, Plus, Search } from "lucide-react";
import { Badge, Button, Card, EmptyState, ErrorState, Metric, Metrics, Money, NavTabs, PageHeader, SearchInput, SkeletonRows, Toolbar } from "@/components/app-ui";
import { BILL_LABEL, BILL_TONE, FinancialsGate, calendarDate } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { BillModal, RecurringBills } from "@/components/payables-components";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { qs, useApi } from "@/lib/api";

function BillsView() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useSession();
  const status = params.get("status") ?? "open";
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(params.get("new") === "1");
  const { data, error, mutate } = useApi<{ data: any[]; has_more: boolean; summary: { open: string; overdue: string; awaiting_approval: number } }>(`/v1/bills${qs({ status: status === "all" ? "" : status, search: query, limit: 100 })}`, { keepPreviousData: true });
  const tab = (s: string, label: string) => ({ href: `/app/bills?status=${s}`, label, active: status === s });

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        title="Bills"
        description="What your business owes vendors. Approve a bill to create the payable, then link an onchain transfer or record another payment method."
        actions={can("financials:write") && <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>Record bill</Button>}
      />
      {data && (
        <Metrics className="lg:grid-cols-3 xl:grid-cols-3">
          <Metric label="To pay" value={data.summary.open} money href="/app/bills?status=open" />
          <Metric label="Overdue" value={data.summary.overdue} money warn={data.summary.overdue !== "0.00"} href="/app/bills?status=overdue" />
          <Metric label="Awaiting approval" value={String(data.summary.awaiting_approval)} href="/app/bills?status=draft" />
        </Metrics>
      )}
      <Card>
        <NavTabs label="Bill status" items={[tab("open", "To pay"), tab("overdue", "Overdue"), tab("draft", "Awaiting approval"), tab("paid", "Paid"), tab("all", "All")]} />
        <Toolbar role="search" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}>
          <SearchInput placeholder="Vendor, bill number or description" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search bills" />
        </Toolbar>
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data ? (
          <SkeletonRows rows={6} cols={5} />
        ) : data.data.length === 0 ? (
          query ? (
            <EmptyState icon={<Search />} title="No bills match" mascot="curious">Try another search.</EmptyState>
          ) : (
            <EmptyState icon={<FileText />} title={status === "open" ? "Nothing to pay" : "No bills here"} mascot={status === "open" ? "success" : undefined}>
              {status === "open" ? "Every approved bill is paid." : "Bills you record appear here."}
            </EmptyState>
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Vendor</TableHead>
                <TableHead className="max-md:hidden">Bill</TableHead>
                <TableHead className="max-sm:hidden">Due</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((b) => (
                <TableRow key={b.id} className="cursor-pointer" tabIndex={0} onClick={() => router.push(`/app/bills/${b.id}`)} onKeyDown={(e) => e.key === "Enter" && router.push(`/app/bills/${b.id}`)}>
                  <TableCell>
                    <span className="font-medium">{b.vendor.name}</span>
                    <span className="block text-xs text-muted-foreground md:hidden">{b.number}</span>
                  </TableCell>
                  <TableCell className="max-md:hidden">
                    <span className="font-mono text-sm">{b.number}</span>
                    <span className="block line-clamp-1 text-xs text-muted-foreground">{b.title}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground max-sm:hidden">{b.due_date ? calendarDate(b.due_date) : "-"}</TableCell>
                  <TableCell><Badge tone={b.overdue ? "danger" : BILL_TONE[b.status]}>{b.overdue ? "Overdue" : BILL_LABEL[b.status]}</Badge></TableCell>
                  <TableCell className="text-right font-semibold">
                    <Money value={["paid", "void", "draft"].includes(b.status) ? b.amount : b.amount_remaining} />
                    {b.status === "partially_paid" && <span className="block text-xs font-normal text-muted-foreground">of {b.amount}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <RecurringBills />
      <BillModal open={adding} onClose={() => setAdding(false)} onCreated={(id) => router.push(`/app/bills/${id}`)} />
    </div>
  );
}

export default function BillsPage() {
  return (
    <FinancialsGate>
      <Suspense>
        <BillsView />
      </Suspense>
    </FinancialsGate>
  );
}
