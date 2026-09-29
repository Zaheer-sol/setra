"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ArrowDownLeft, Download, Search, X } from "lucide-react";
import { PaymentsTable } from "@/components/payment-tables";
import { useSession } from "@/components/session";
import { Button, ButtonLink, Card, EmptyState, ErrorState, Input, NavTabs, PageHeader, Pager, SearchInput, Select, SkeletonRows, Toolbar, useCursorPager } from "@/components/app-ui";
import { qs, useApi } from "@/lib/api";

const TABS = [
  { key: "", label: "All" },
  { key: "confirming", label: "Confirming" },
  { key: "settled", label: "Paid" },
  { key: "needs_review", label: "Needs review" },
  { key: "reversed", label: "Reversed" }
];

function PaymentsView() {
  const router = useRouter();
  const params = useSearchParams();
  const { isTest } = useSession();
  const status = params.get("status") ?? "";
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [sort, setSort] = useState(params.get("sort") ?? "newest");
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [to, setTo] = useState(params.get("to") ?? "");
  const [customerId, setCustomerId] = useState(params.get("customer_id") ?? "");
  const pager = useCursorPager();
  const { data: customers } = useApi<{ data: Array<{ id: string; name: string }> }>("/v1/customers?limit=100");
  const filters = {
    status,
    search: params.get("search") ?? "",
    sort,
    customer_id: customerId,
    created_gte: from ? new Date(`${from}T00:00:00`).toISOString() : "",
    created_lte: to ? new Date(`${to}T23:59:59`).toISOString() : ""
  };
  const { data, error, mutate, isLoading } = useApi<{ data: any[]; has_more: boolean; next_cursor: string | null }>(`/v1/payments${qs({ ...filters, limit: 25, starting_after: pager.cursor })}`, {
    refreshInterval: 5000,
    keepPreviousData: true
  });
  const { reset } = pager;
  useEffect(() => reset(), [status, filters.search, sort, customerId, from, to, reset]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`/app/payments${next.toString() ? `?${next}` : ""}`);
  };
  const anyFilter = Boolean(filters.search || customerId || from || to);

  return (
    <div>
      <PageHeader
        title="Payments"
        description="Every stablecoin payment that reached your wallets, what Setra concluded, and why."
        actions={
          <Button variant="secondary" icon={<Download aria-hidden="true" />} onClick={() => (window.location.href = `/api/v1/exports/payments.csv${qs(filters)}`)}>
            Export CSV
          </Button>
        }
      />
      <Card>
        <NavTabs label="Payment status" items={TABS.map((t) => ({ href: `/app/payments${t.key ? `?status=${t.key}` : ""}`, label: t.label, active: status === t.key }))} />
        <Toolbar
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setParam("search", search.trim());
          }}
        >
          <SearchInput placeholder="Customer, invoice, sender or tx hash" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search payments" />
          <Select size="sm" className="w-auto min-w-40" value={customerId} onValueChange={setCustomerId} aria-label="Customer" options={[{ value: "", label: "All customers" }, ...(customers?.data.map((c) => ({ value: c.id, label: c.name })) ?? [])]} />
          <Input className="h-8 w-auto text-sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          <Input className="h-8 w-auto text-sm" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
          <Select
            size="sm"
            className="w-auto"
            value={sort}
            onValueChange={setSort}
            aria-label="Sort"
            options={[
              { value: "newest", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
              { value: "amount_desc", label: "Largest amount" },
              { value: "amount_asc", label: "Smallest amount" }
            ]}
          />
          {anyFilter && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon={<X />}
              onClick={() => {
                setSearch("");
                setCustomerId("");
                setFrom("");
                setTo("");
                setParam("search", "");
              }}
            >
              Clear
            </Button>
          )}
        </Toolbar>
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data || (isLoading && !data) ? (
          <SkeletonRows rows={8} cols={6} />
        ) : (
          <>
            <PaymentsTable
              rows={data.data}
              empty={
                anyFilter || status ? (
                  <EmptyState icon={<Search />} title="No payments match" mascot="curious">
                    Try a different search or clear the filters.
                  </EmptyState>
                ) : (
                  <EmptyState
                    icon={<ArrowDownLeft />}
                    title="No payments yet"
                    mascot="welcome"
                    actions={
                      <>
                        <ButtonLink href="/app/invoices/new" variant="primary" size="sm">
                          Create an invoice
                        </ButtonLink>
                        {isTest && (
                          <ButtonLink href="/app/developers/test-mode" size="sm">
                            Simulate a payment
                          </ButtonLink>
                        )}
                      </>
                    }
                  >
                    Payments appear here within about a second of reaching one of your monitored wallets on Monad.
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

export default function PaymentsPage() {
  return (
    <Suspense>
      <PaymentsView />
    </Suspense>
  );
}
