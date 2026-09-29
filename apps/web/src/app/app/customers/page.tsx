"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Plus, Search, Users } from "lucide-react";
import { useSession } from "@/components/session";
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, fieldErrors, Input, Modal, Money, PageHeader, Pager, SearchInput, SkeletonRows, Toolbar, useCursorPager, useToast } from "@/components/app-ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, qs, useApi, type ApiError } from "@/lib/api";
import { shortAddress } from "@/lib/format";

function CustomersView() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useSession();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(params.get("add") === "1");
  const pager = useCursorPager();
  const { reset } = pager;
  useEffect(() => reset(), [query, reset]);
  const { data, error, mutate } = useApi<{ data: any[]; has_more: boolean; next_cursor: string | null }>(`/v1/customers${qs({ search: query, limit: 25, starting_after: pager.cursor })}`, { keepPreviousData: true });

  return (
    <div>
      <PageHeader
        title="Customers"
        description="The businesses and people who pay you. Linking their wallets lets Setra recognize their payments, including partial ones."
        actions={can("customers:write") && <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>New customer</Button>}
      />
      <Card>
        <Toolbar role="search" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}>
          <SearchInput placeholder="Name, email, reference or wallet address" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search customers" />
        </Toolbar>
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data ? (
          <SkeletonRows rows={6} cols={5} />
        ) : data.data.length === 0 ? (
          query ? (
            <EmptyState icon={<Search />} title="No customers match" mascot="curious">Try another name, email or address.</EmptyState>
          ) : (
            <EmptyState icon={<Users />} title="Add your first customer" mascot="welcome" actions={<Button size="sm" variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>New customer</Button>}>
              Customers own invoices. Add their wallet addresses so Setra can match their payments with certainty.
            </EmptyState>
          )
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Customer</TableHead>
                  <TableHead className="max-md:hidden">Known wallets</TableHead>
                  <TableHead className="text-right max-md:hidden">Open invoices</TableHead>
                  <TableHead className="text-right max-md:hidden">Outstanding</TableHead>
                  <TableHead className="text-right">Total received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((c) => (
                  <TableRow key={c.id} className="cursor-pointer" tabIndex={0} onClick={() => router.push(`/app/customers/${c.id}`)} onKeyDown={(e) => e.key === "Enter" && router.push(`/app/customers/${c.id}`)}>
                    <TableCell>
                      <span className="font-medium">{c.name}</span>
                      <span className="block text-xs text-muted-foreground">{c.email ?? "No email"}</span>
                    </TableCell>
                    <TableCell className="max-md:hidden">
                      {c.wallet_addresses.length ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {shortAddress(c.wallet_addresses[0].address)}
                          {c.wallet_addresses.length > 1 && ` +${c.wallet_addresses.length - 1}`}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">None linked</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right max-md:hidden">
                      {c.stats.open_invoices}
                      {c.stats.open_exceptions > 0 && <Badge tone="warning" className="ml-2">{c.stats.open_exceptions} to review</Badge>}
                    </TableCell>
                    <TableCell className="text-right font-semibold max-md:hidden">
                      <Money value={c.stats.outstanding} muted={c.stats.outstanding === "0.00"} />
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      <Money value={c.stats.total_received} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager hasMore={data.has_more} canPrev={pager.canPrev} onNext={() => pager.next(data.next_cursor)} onPrev={pager.prev} count={data.data.length} />
          </>
        )}
      </Card>
      <NewCustomerModal open={adding} onClose={() => setAdding(false)} onCreated={(id) => router.push(`/app/customers/${id}`)} />
    </div>
  );
}

function NewCustomerModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: "", email: "", external_ref: "", address: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const errs = fieldErrors(error);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api<{ id: string; name: string }>("/v1/customers", {
        method: "POST",
        body: { name: form.name, email: form.email || undefined, external_ref: form.external_ref || undefined, wallet_addresses: form.address ? [{ address: form.address.trim(), network: "monad" }] : [] }
      });
      toast("success", `${c.name} added.`);
      onCreated(c.id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New customer"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={submit}>Create customer</Button>
        </>
      }
    >
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {error && !error.details && <Alert tone="danger">{error.message}</Alert>}
        <Field label="Name" htmlFor="c-name" error={errs.name}>
          <Input id="c-name" value={form.name} onChange={set("name")} autoFocus placeholder="Acme Ltd" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Billing email" htmlFor="c-email" optional error={errs.email}>
            <Input id="c-email" type="email" value={form.email} onChange={set("email")} />
          </Field>
          <Field label="Your reference" htmlFor="c-ref" optional hint="An ID from your own systems.">
            <Input id="c-ref" value={form.external_ref} onChange={set("external_ref")} />
          </Field>
        </div>
        <Field label="Customer wallet address" htmlFor="c-addr" optional hint="The address they pay from on Monad. You can add more later." error={errs["wallet_addresses.0.address"]}>
          <Input id="c-addr" className="font-mono" value={form.address} onChange={set("address")} placeholder="0x…" spellCheck={false} />
        </Field>
      </form>
    </Modal>
  );
}

export default function CustomersPage() {
  return (
    <Suspense>
      <CustomersView />
    </Suspense>
  );
}
