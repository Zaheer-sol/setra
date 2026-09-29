"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Plus, Wallet } from "lucide-react";
import { SyncBadge } from "@/components/payment-tables";
import { useSession } from "@/components/session";
import { Alert, Button, Card, Chain, EmptyState, ErrorState, Field, fieldErrors, Input, Modal, Money, PageHeader, SkeletonRows, useToast } from "@/components/app-ui";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, newIdempotencyKey, useApi, type ApiError } from "@/lib/api";

function WalletsView() {
  const router = useRouter();
  const params = useSearchParams();
  const { can, isTest } = useSession();
  const [adding, setAdding] = useState(params.get("add") === "1");
  const { data, error, mutate } = useApi<{ data: any[] }>("/v1/wallets", { refreshInterval: 5000 });

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        title="Receiving wallets"
        description="Public addresses Setra watches on Monad. Customers pay these wallets directly; your funds never pass through Setra."
        actions={can("wallets:write") && <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>Add wallet</Button>}
      />
      <Alert tone="neutral" title="Non-custodial by design">
        Setra only needs a public address. It will never ask for a private key, seed phrase or signing permission.
      </Alert>
      <Card>
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data ? (
          <SkeletonRows rows={3} cols={5} />
        ) : data.data.length === 0 ? (
          <EmptyState icon={<Wallet />} title="Add your first wallet" mascot="focused" actions={can("wallets:write") && <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>Add wallet</Button>}>
            Setra will begin monitoring payments as soon as a receiving wallet is connected{isTest ? ", in test mode that's Monad testnet." : "."}
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Wallet</TableHead>
                <TableHead className="max-md:hidden">Network</TableHead>
                <TableHead className="max-md:hidden">Assets</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right max-md:hidden">Payments</TableHead>
                <TableHead className="text-right">Received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((w) => (
                <TableRow key={w.id} className="cursor-pointer" tabIndex={0} onClick={() => router.push(`/app/wallets/${w.id}`)} onKeyDown={(e) => e.key === "Enter" && router.push(`/app/wallets/${w.id}`)}>
                  <TableCell className="max-w-[320px] whitespace-normal">
                    <span className="font-medium">{w.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{w.address}</span>
                  </TableCell>
                  <TableCell className="max-md:hidden">
                    <Chain network={w.network} name={w.network_name} />
                  </TableCell>
                  <TableCell className="max-md:hidden">{w.assets.map((a: any) => a.symbol).join(", ")}</TableCell>
                  <TableCell>
                    <SyncBadge sync={w.sync} />
                  </TableCell>
                  <TableCell className="tabular text-right max-md:hidden">{w.stats.payments}</TableCell>
                  <TableCell className="text-right font-semibold">
                    <Money value={w.stats.total_received} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <AddWalletModal open={adding} onClose={() => setAdding(false)} onCreated={(id) => router.push(`/app/wallets/${id}`)} />
    </div>
  );
}

function AddWalletModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const { isTest } = useSession();
  const [form, setForm] = useState({ name: "Main Wallet", address: "", usdc: true, usdt0: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [key] = useState(newIdempotencyKey);
  const errs = fieldErrors(error);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(form.address.trim());
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const assets = [form.usdc && "USDC", form.usdt0 && !isTest && "USDT0"].filter(Boolean);
      const w = await api<{ id: string }>("/v1/wallets", { method: "POST", idempotencyKey: key, body: { name: form.name, network: "monad", address: form.address.trim(), assets } });
      toast("success", "Wallet added. Monitoring starts within a few seconds.");
      onCreated(w.id);
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add receiving wallet"
      description="Setra monitors your wallet. Your funds remain under your control."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!valid || !form.name.trim() || (!form.usdc && !form.usdt0)} onClick={submit}>Start monitoring</Button>
        </>
      }
    >
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (valid) submit(); }}>
        {error && !error.details && <Alert tone="danger">{error.message}</Alert>}
        <Field label="Name" htmlFor="w-name" error={errs.name}>
          <Input id="w-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label="Network" htmlFor="w-network" hint={isTest ? "Test mode uses Monad testnet (chain 10143)." : "Live mode uses Monad mainnet (chain 143)."}>
          <div id="w-network" className="flex h-9 items-center rounded-lg border border-input bg-muted px-3">
            <Chain network="monad" name={isTest ? "Monad Testnet" : "Monad"} />
          </div>
        </Field>
        <Field label="Public address" htmlFor="w-address" error={errs.address ?? (form.address && !valid ? "Enter a 0x address with 40 hex characters." : null)} hint="Paste the address only. Never share a private key or seed phrase.">
          <Input id="w-address" className="font-mono" value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} placeholder="0x…" autoFocus spellCheck={false} autoComplete="off" />
        </Field>
        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-sm font-medium text-foreground/80">Accepted assets</legend>
          <div className="flex items-center gap-2.5">
            <Checkbox id="asset-usdc" checked={form.usdc} onCheckedChange={(v) => setForm((f) => ({ ...f, usdc: v === true }))} />
            <Label htmlFor="asset-usdc" className="font-normal">USDC</Label>
          </div>
          {!isTest && (
            <div className="flex items-center gap-2.5">
              <Checkbox id="asset-usdt0" checked={form.usdt0} onCheckedChange={(v) => setForm((f) => ({ ...f, usdt0: v === true }))} />
              <Label htmlFor="asset-usdt0" className="font-normal">USDT0</Label>
            </div>
          )}
          <span className="text-xs text-muted-foreground">Other tokens sent to this wallet are recorded and flagged, they never settle an invoice.</span>
        </fieldset>
      </form>
    </Modal>
  );
}

export default function WalletsPage() {
  return (
    <Suspense>
      <WalletsView />
    </Suspense>
  );
}

