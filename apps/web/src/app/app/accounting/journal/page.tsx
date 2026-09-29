"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { NotebookPen, Plus, Search } from "lucide-react";
import { Badge, ButtonLink, Card, EmptyState, ErrorState, NavTabs, PageHeader, SearchInput, Select, SkeletonRows, Toolbar } from "@/components/app-ui";
import { EntryStatus, FinancialsGate, calendarDate } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { Button } from "@/components/app-ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { qs, useApi } from "@/lib/api";
import { money } from "@/lib/format";

const SOURCES = [
  { value: "", label: "All sources" },
  { value: "manual", label: "Manual entries" },
  { value: "payment", label: "Payments" },
  { value: "invoice", label: "Invoices" },
  { value: "bill", label: "Bills" },
  { value: "bill_payment", label: "Bill payments" },
  { value: "expense", label: "Expenses" },
  { value: "outgoing_transfer", label: "Outgoing transfers" },
  { value: "refund", label: "Refunds" },
  { value: "classification", label: "Classifications" },
  { value: "resolution", label: "Write-offs" }
];

function JournalView() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useSession();
  const status = params.get("status") ?? "";
  const [source, setSource] = useState(params.get("source_type") ?? "");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [status, source, query]);
  const { data, error, mutate } = useApi<{ data: any[]; has_more: boolean }>(`/v1/accounting/journal-entries${qs({ status, source_type: source, search: query, limit: 50, offset: page * 50 })}`, { keepPreviousData: true });
  const tab = (s: string, label: string) => ({ href: `/app/accounting/journal${s ? `?status=${s}` : ""}`, label, active: status === s });

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Books", href: "/app/accounting" }, { label: "Journal" }]}
        title="Journal"
        description="Every entry in the books, in order. Most are posted automatically from payments, invoices, bills and expenses. Posted entries never change; corrections are new entries."
        actions={can("financials:write") && <ButtonLink href="/app/accounting/journal/new" variant="primary" icon={<Plus />}>New entry</ButtonLink>}
      />
      <Card>
        <NavTabs label="Entry status" items={[tab("", "All"), tab("posted", "Posted"), tab("draft", "Drafts"), tab("approved", "Approved"), tab("void", "Discarded")]} />
        <Toolbar role="search" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}>
          <SearchInput placeholder="Entry number, description or memo" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search entries" />
          <Select size="sm" className="w-auto" value={source} onValueChange={setSource} options={SOURCES} aria-label="Source" />
        </Toolbar>
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data ? (
          <SkeletonRows rows={10} cols={5} />
        ) : data.data.length === 0 ? (
          query || source || status ? (
            <EmptyState icon={<Search />} title="No entries match" mascot="curious">Try a different filter.</EmptyState>
          ) : (
            <EmptyState icon={<NotebookPen />} title="No entries yet" mascot="welcome">Entries appear here as soon as you issue an invoice or receive a payment.</EmptyState>
          )
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[100px]">Entry</TableHead>
                  <TableHead className="w-[92px]">Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="max-md:hidden">Source</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right max-sm:hidden">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((e) => (
                  <TableRow key={e.id} className="cursor-pointer" tabIndex={0} onClick={() => router.push(`/app/accounting/journal/${e.id}`)} onKeyDown={(ev) => ev.key === "Enter" && router.push(`/app/accounting/journal/${e.id}`)}>
                    <TableCell className="font-mono text-sm">{e.number}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{calendarDate(e.date)}</TableCell>
                    <TableCell className="max-w-[440px]">
                      <span className="line-clamp-1 font-medium">{e.description}</span>
                      {e.reverses_entry_id && <span className="text-xs text-muted-foreground">Reversal</span>}
                    </TableCell>
                    <TableCell className="max-md:hidden">
                      <Badge tone={e.automatic ? "neutral" : "accent"} dot={false}>{e.automatic ? e.source.label : "Manual"}</Badge>
                    </TableCell>
                    <TableCell className="tabular text-right font-semibold">{money(e.total)}</TableCell>
                    <TableCell className="text-right max-sm:hidden">
                      <EntryStatus status={e.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {(page > 0 || data.has_more) && (
              <div className="flex justify-end gap-2 border-t px-6 py-3 max-md:px-4">
                <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button size="sm" variant="ghost" disabled={!data.has_more} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

export default function JournalPage() {
  return (
    <FinancialsGate>
      <Suspense>
        <JournalView />
      </Suspense>
    </FinancialsGate>
  );
}
