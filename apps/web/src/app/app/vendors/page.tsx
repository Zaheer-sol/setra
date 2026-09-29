"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Search, Store } from "lucide-react";
import { Button, Card, EmptyState, ErrorState, Money, PageHeader, SearchInput, SkeletonRows, Toolbar } from "@/components/app-ui";
import { FinancialsGate } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { VendorModal } from "@/components/payables-components";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { qs, useApi } from "@/lib/api";

function VendorsView() {
  const router = useRouter();
  const { can } = useSession();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const { data, error, mutate } = useApi<{ data: any[]; has_more: boolean }>(`/v1/vendors${qs({ search: query, limit: 100 })}`, { keepPreviousData: true });

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        title="Vendors"
        description="The businesses and people you pay. Link their wallets so transfers to them are recognized, and track what you owe each one."
        actions={can("financials:write") && <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>New vendor</Button>}
      />
      <Card>
        <Toolbar role="search" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}>
          <SearchInput placeholder="Name or email" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search vendors" />
        </Toolbar>
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data ? (
          <SkeletonRows rows={6} cols={4} />
        ) : data.data.length === 0 ? (
          query ? (
            <EmptyState icon={<Search />} title="No vendors match" mascot="curious">Try another name.</EmptyState>
          ) : (
            <EmptyState icon={<Store />} title="Add your first vendor" mascot="welcome" actions={can("financials:write") && <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>New vendor</Button>}>
              Vendors are who you pay: contractors, software, hosting. Their bills and expenses land in the right accounts automatically.
            </EmptyState>
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Vendor</TableHead>
                <TableHead className="max-md:hidden">Wallets</TableHead>
                <TableHead className="text-right">You owe</TableHead>
                <TableHead className="text-right max-sm:hidden">Paid to date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((v) => (
                <TableRow key={v.id} className="cursor-pointer" tabIndex={0} onClick={() => router.push(`/app/vendors/${v.id}`)} onKeyDown={(e) => e.key === "Enter" && router.push(`/app/vendors/${v.id}`)}>
                  <TableCell>
                    <span className="font-medium">{v.name}</span>
                    <span className="block text-xs text-muted-foreground">{v.email ?? "No email"}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground max-md:hidden">{v.wallet_addresses ? `${v.wallet_addresses} linked` : "None linked"}</TableCell>
                  <TableCell className="text-right font-semibold"><Money value={v.owed} muted={v.owed === "0.00"} /></TableCell>
                  <TableCell className="text-right max-sm:hidden"><Money value={v.paid} muted={v.paid === "0.00"} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <VendorModal open={adding} onClose={() => setAdding(false)} onCreated={(v) => router.push(`/app/vendors/${v.id}`)} />
    </div>
  );
}

export default function VendorsPage() {
  return (
    <FinancialsGate>
      <VendorsView />
    </FinancialsGate>
  );
}
