"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Plus, Receipt, Search } from "lucide-react";
import { InvoicesTable } from "@/components/payment-tables";
import { useSession } from "@/components/session";
import { ButtonLink, Card, EmptyState, ErrorState, NavTabs, PageHeader, Pager, SearchInput, SkeletonRows, Toolbar, useCursorPager } from "@/components/app-ui";
import { qs, useApi } from "@/lib/api";

const TABS = [
  { key: "", label: "All" },
  { key: "open", label: "Awaiting payment" },
  { key: "partially_paid", label: "Partially paid" },
  { key: "paid", label: "Paid" },
  { key: "overpaid", label: "Overpaid" },
  { key: "expired", label: "Expired" },
  { key: "cancelled", label: "Cancelled" }
];

function InvoicesView() {
  const params = useSearchParams();
  const status = params.get("status") ?? "";
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const pager = useCursorPager();
  const { reset } = pager;
  const { can } = useSession();
  useEffect(() => reset(), [status, query, reset]);
  const { data, error, mutate } = useApi<{ data: any[]; has_more: boolean; next_cursor: string | null }>(`/v1/invoices${qs({ status, search: query, limit: 25, starting_after: pager.cursor })}`, { refreshInterval: 8000, keepPreviousData: true });

  return (
    <div>
      <PageHeader
        title="Invoices"
        description="Payment requests you create in Setra, and orders sent by your store or backend. Customers pay stablecoins directly to your wallet."
        actions={
          can("invoices:write") && (
            <ButtonLink href="/app/invoices/new" variant="primary" icon={<Plus />}>
              New invoice
            </ButtonLink>
          )
        }
      />
      <Card>
        <NavTabs label="Invoice status" items={TABS.map((t) => ({ href: `/app/invoices${t.key ? `?status=${t.key}` : ""}`, label: t.label, active: status === t.key }))} />
        <Toolbar
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search.trim());
          }}
        >
          <SearchInput placeholder="Invoice number, description or customer" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search invoices" />
        </Toolbar>
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data ? (
          <SkeletonRows rows={8} cols={6} />
        ) : (
          <>
            <InvoicesTable
              rows={data.data}
              empty={
                query || status ? (
                  <EmptyState icon={<Search />} title="No invoices match" mascot="curious">
                    Try another search or status.
                  </EmptyState>
                ) : (
                  <EmptyState
                    icon={<Receipt />}
                    title="Create your first invoice" mascot="welcome"
                    actions={
                      <ButtonLink href="/app/invoices/new" variant="primary" size="sm" icon={<Plus />}>
                        New invoice
                      </ButtonLink>
                    }
                  >
                    Each invoice gets a hosted payment page. Monad and USDC are selected by default.
                  </EmptyState>
                )
              }
            />
            <Pager hasMore={data.has_more} canPrev={pager.canPrev} onNext={() => pager.next(data.next_cursor)} onPrev={pager.prev} count={data.data.length} />
          </>
        )}
      </Card>
    </div>
  );
}

export default function InvoicesPage() {
  return (
    <Suspense>
      <InvoicesView />
    </Suspense>
  );
}
