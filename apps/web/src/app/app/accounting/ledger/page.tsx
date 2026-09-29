"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { BookOpen, X } from "lucide-react";
import { Button, Card, EmptyState, ErrorState, PageHeader, SearchInput, SkeletonRows, Toolbar } from "@/components/app-ui";
import { AccountSelect, ExportLink, FinancialsGate, LedgerLines, RangePicker, useRange } from "@/components/ledger-components";
import { qs, useApi } from "@/lib/api";
import { money } from "@/lib/format";

function LedgerView() {
  const params = useSearchParams();
  const router = useRouter();
  const { preset, from, to } = useRange();
  const accountId = params.get("account_id") ?? "";
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [page, setPage] = useState(0);
  const filters = { account_id: accountId, customer_id: params.get("customer_id"), vendor_id: params.get("vendor_id"), payment_id: params.get("payment_id"), invoice_id: params.get("invoice_id"), search: params.get("search"), ...(preset === "all" ? {} : { from, to }) };
  useEffect(() => setPage(0), [JSON.stringify(filters)]);
  const path = `/v1/accounting/ledger${qs(filters)}`;
  const { data, error, mutate } = useApi<any>(`${path}${path.includes("?") ? "&" : "?"}limit=100&offset=${page * 100}`, { keepPreviousData: true });
  const setParam = (k: string, v: string | null) => {
    const u = new URLSearchParams(params.toString());
    if (v) u.set(k, v);
    else u.delete(k);
    router.replace(`/app/accounting/ledger?${u.toString()}`, { scroll: false });
  };
  const scoped = ["customer_id", "vendor_id", "payment_id", "invoice_id"].filter((k) => params.get(k));

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Books", href: "/app/accounting" }, { label: "General ledger" }]}
        title="General ledger"
        description="Every posted line, from every entry. Choose an account to see its running balance."
        actions={<ExportLink path={path} />}
      />
      <Card>
        <Toolbar role="search" onSubmit={(e) => { e.preventDefault(); setParam("search", search.trim() || null); }}>
          <div className="w-[280px] max-sm:w-full">
            <AccountSelect value={accountId} onChange={(v) => setParam("account_id", v || null)} placeholder="All accounts" size="sm" />
          </div>
          <RangePicker />
          <SearchInput placeholder="Description, memo or entry number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search ledger" />
          {(accountId || scoped.length > 0) && (
            <Button size="sm" variant="ghost" icon={<X />} onClick={() => router.replace("/app/accounting/ledger")}>
              Clear
            </Button>
          )}
        </Toolbar>
        {scoped.length > 0 && <p className="border-b px-6 py-2 text-sm text-muted-foreground max-md:px-4">Showing lines linked to one {scoped[0]!.replace("_id", "")}.</p>}
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data ? (
          <SkeletonRows rows={12} cols={5} />
        ) : data.lines.length === 0 ? (
          <EmptyState icon={<BookOpen />} title="No lines match" mascot="curious">Try another account or a wider date range.</EmptyState>
        ) : (
          <>
            {data.opening_balance !== null && <div className="tabular flex justify-between border-b px-6 py-2.5 text-sm text-muted-foreground max-md:px-4"><span>Opening balance</span><span>{money(data.opening_balance)}</span></div>}
            <LedgerLines lines={data.lines} running={!!accountId} showAccount={!accountId} />
            {data.closing_balance !== null && <div className="tabular flex justify-between border-t bg-muted/40 px-6 py-3 font-semibold max-md:px-4"><span>{data.has_more ? "Balance at end of this page" : "Closing balance"}</span><span>{money(data.closing_balance)}</span></div>}
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

export default function LedgerPage() {
  return (
    <FinancialsGate>
      <Suspense>
        <LedgerView />
      </Suspense>
    </FinancialsGate>
  );
}
