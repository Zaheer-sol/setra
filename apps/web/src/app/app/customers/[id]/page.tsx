"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { InvoicesTable, PaymentsTable } from "@/components/payment-tables";
import { useSession } from "@/components/session";
import { Address, Alert, Button, ButtonLink, Card, CardBody, Chain, CopyButton, DetailGrid, ErrorState, Field, fieldErrors, Input, KV, Metric, Metrics, Modal, PageHeader, SkeletonBlock, SkeletonRows, Stack, useToast } from "@/components/app-ui";
import { api, useApi, type ApiError } from "@/lib/api";
import { dateShort } from "@/lib/format";

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const toast = useToast();
  const { data: c, error, mutate } = useApi<any>(`/v1/customers/${id}`);
  const { data: invoices } = useApi<{ data: any[] }>(`/v1/invoices?customer_id=${id}&limit=50`);
  const { data: payments } = useApi<{ data: any[] }>(`/v1/payments?customer_id=${id}&limit=25`);
  const [adding, setAdding] = useState(false);

  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!c) return <Stack><SkeletonBlock height={140} /><SkeletonBlock height={280} /></Stack>;

  const removeAddress = async (addressId: string) => {
    try {
      await api(`/v1/customers/${id}/wallet-addresses/${addressId}`, { method: "DELETE" });
      await mutate();
      toast("success", "Wallet unlinked. Past payments keep their history.");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  return (
    <Stack>
      <PageHeader
        breadcrumbs={[{ label: "Customers", href: "/app/customers" }, { label: c.name }]}
        title={c.name}
        description={c.email ?? undefined}
        actions={can("invoices:write") && <ButtonLink href={`/app/invoices/new?customer=${c.id}`} variant="primary" icon={<Plus />}>New invoice</ButtonLink>}
      />
      <Metrics className="xl:grid-cols-4">
        <Metric label="Total received" value={c.stats.total_received} money />
        <Metric label="Outstanding" value={c.stats.outstanding} money />
        <Metric label="Open invoices" value={String(c.stats.open_invoices)} foot={`${c.stats.paid_invoices} paid`} />
        <Metric label="Needs review" value={String(c.stats.open_exceptions)} warn={c.stats.open_exceptions > 0} />
      </Metrics>
      <DetailGrid>
        <Stack>
          <Card title="What they've paid for" description="Every payment from this customer, and the invoice it settled.">
            {!payments ? <SkeletonRows rows={3} /> : <PaymentsTable rows={payments.data} compact />}
          </Card>
          <Card title="Invoices">{!invoices ? <SkeletonRows rows={3} /> : <InvoicesTable rows={invoices.data} />}</Card>
        </Stack>
        <Stack>
          <Card
            title="Known wallets"
            description="Payments from these addresses are attributed to this customer."
            actions={can("customers:write") && <Button size="sm" icon={<Plus />} onClick={() => setAdding(true)}>Add</Button>}
          >
            {c.wallet_addresses.length === 0 ? (
              <CardBody>
                <Alert tone="info" title="No wallets linked yet">
                  Without a known wallet, Setra only auto-matches this customer&rsquo;s payments when the exact amount identifies one invoice. Partial payments will need review.
                </Alert>
              </CardBody>
            ) : (
              <ul>
                {c.wallet_addresses.map((a: any) => (
                  <li key={a.id} className="flex items-center justify-between gap-4 border-t px-6 py-3.5 first:border-t-0 max-md:px-4">
                    <div className="min-w-0">
                      <Address value={a.address} />
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Chain network={a.network} name={a.network_name} />
                        {a.label && <span>· {a.label}</span>}
                        {a.source === "resolution" && <span>· learned from a resolved payment</span>}
                      </div>
                    </div>
                    {can("customers:write") && <Button size="sm" variant="ghost" aria-label="Unlink wallet" icon={<Trash2 />} onClick={() => removeAddress(a.id)} />}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Details">
            <CardBody className="py-1">
              <KV
                items={[
                  ["Customer ID", <span key="id" className="flex items-center gap-1 font-mono text-xs">{c.id}<CopyButton value={c.id} /></span>],
                  ["Email", c.email],
                  ["Your reference", c.external_ref],
                  ["Created", dateShort(c.created_at)]
                ]}
              />
            </CardBody>
          </Card>
        </Stack>
      </DetailGrid>
      <AddAddressModal open={adding} onClose={() => setAdding(false)} customerId={c.id} onDone={() => { setAdding(false); mutate(); }} />
    </Stack>
  );
}

function AddAddressModal({ open, onClose, customerId, onDone }: { open: boolean; onClose: () => void; customerId: string; onDone: () => void }) {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const errs = fieldErrors(error);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link a customer wallet"
      description="Use the address the customer pays from. Setra will attribute its payments to this customer."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!address.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api(`/v1/customers/${customerId}/wallet-addresses`, { method: "POST", body: { address: address.trim(), network: "monad", label: label || undefined } });
                setAddress("");
                setLabel("");
                onDone();
              } catch (e) {
                setError(e as ApiError);
              } finally {
                setBusy(false);
              }
            }}
          >
            Link wallet
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && !error.details && <Alert tone="danger">{error.message}</Alert>}
        <Field label="Wallet address" htmlFor="ca-addr" error={errs.address}>
          <Input id="ca-addr" className="font-mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" autoFocus spellCheck={false} />
        </Field>
        <Field label="Label" htmlFor="ca-label" optional>
          <Input id="ca-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Treasury" />
        </Field>
      </div>
    </Modal>
  );
}
