"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Lock, Plus, Wallet } from "lucide-react";
import { Alert, Button, Card, ErrorState, Field, fieldErrors, Input, Modal, PageHeader, Segmented, Select, SkeletonRows, Textarea, useToast } from "@/components/app-ui";
import { FinancialsGate, TYPE_LABEL, TYPE_ORDER, type LedgerAccount } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { api, useApi, type ApiError } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

const TYPE_HINT: Record<LedgerAccount["type"], string> = {
  asset: "What the business owns: wallets, bank accounts, money owed to it.",
  liability: "What the business owes: vendors, customer credits, money not yet identified.",
  equity: "The owners' stake and accumulated earnings.",
  revenue: "Income from sales. Refunds reduce it.",
  cogs: "Direct costs of what you sell.",
  expense: "The cost of running the business."
};

function AccountsView() {
  const router = useRouter();
  const { can } = useSession();
  const [show, setShow] = useState<"active" | "all">("active");
  const [adding, setAdding] = useState(false);
  const { data, error, mutate } = useApi<{ data: LedgerAccount[] }>(`/v1/accounting/accounts?include_archived=${show === "all"}`);

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Books", href: "/app/accounting" }, { label: "Chart of accounts" }]}
        title="Chart of accounts"
        description="Every account in your ledger. Setra posts to the locked accounts automatically; add your own for the way you track income and spending."
        actions={
          <>
            <Segmented label="Show" value={show} onChange={setShow} options={[{ value: "active", label: "Active" }, { value: "all", label: "Include archived" }]} />
            {can("financials:manage") && (
              <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
                New account
              </Button>
            )}
          </>
        }
      />
      {error ? (
        <Card>
          <ErrorState error={error} retry={() => mutate()} />
        </Card>
      ) : !data ? (
        <Card>
          <SkeletonRows rows={10} cols={3} />
        </Card>
      ) : (
        TYPE_ORDER.map((t) => {
          const rows = data.data.filter((a) => a.type === t);
          if (!rows.length) return null;
          return (
            <Card key={t} title={TYPE_LABEL[t]} description={TYPE_HINT[t]}>
              <ul className="divide-y">
                {rows.map((a) => (
                  <li key={a.id}>
                    <Link href={`/app/accounting/accounts/${a.id}`} className={cn("flex items-center gap-4 px-6 py-3 transition-colors hover:bg-accent/50 max-md:px-4", a.archived && "opacity-60")}>
                      <span className="w-12 shrink-0 font-mono text-sm text-muted-foreground">{a.code}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 font-medium">
                          {a.name}
                          {a.wallet_id ? <Wallet className="size-3.5 text-muted-foreground" aria-label="Mirrors a wallet" /> : a.system ? <Lock className="size-3 text-muted-foreground" aria-label="Posted to automatically" /> : null}
                          {a.archived && <span className="text-xs font-normal text-muted-foreground">Archived</span>}
                        </span>
                        {a.description && <span className="line-clamp-1 text-sm text-muted-foreground">{a.description}</span>}
                      </span>
                      <span className={cn("tabular shrink-0 text-right font-semibold", a.balance === "0.00" && "font-normal text-muted-foreground", a.balance.startsWith("-") && "text-destructive")}>{money(a.balance)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })
      )}
      <NewAccountModal
        open={adding}
        onClose={() => setAdding(false)}
        existing={data?.data ?? []}
        onCreated={(id) => {
          mutate();
          router.push(`/app/accounting/accounts/${id}`);
        }}
      />
    </div>
  );
}

function NewAccountModal({ open, onClose, onCreated, existing }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; existing: LedgerAccount[] }) {
  const toast = useToast();
  const [form, setForm] = useState({ type: "expense" as LedgerAccount["type"], code: "", name: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const errs = fieldErrors(error);
  const suggest = (type: LedgerAccount["type"]) => {
    const base = { asset: 1300, liability: 2100, equity: 3100, revenue: 4100, cogs: 5100, expense: 6100 }[type];
    const used = new Set(existing.map((a) => a.code));
    for (let c = base; c < base + 800; c += 10) if (!used.has(String(c))) return String(c);
    return "";
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const a = await api<{ id: string; name: string }>("/v1/accounting/accounts", { method: "POST", body: { type: form.type, code: form.code || suggest(form.type), name: form.name, description: form.description || null } });
      toast("success", `${a.name} added to the chart.`);
      setForm({ type: "expense", code: "", name: "", description: "" });
      onCreated(a.id);
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
      title="New account"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={submit}>Add account</Button>
        </>
      }
    >
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {error && !error.details && <Alert tone="danger">{error.message}</Alert>}
        <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
          <Field label="Type" htmlFor="a-type" hint={TYPE_HINT[form.type]}>
            <Select id="a-type" value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as LedgerAccount["type"] }))} options={TYPE_ORDER.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
          </Field>
          <Field label="Code" htmlFor="a-code" error={errs.code}>
            <Input id="a-code" inputMode="numeric" value={form.code} placeholder={suggest(form.type)} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.replace(/\D/g, "").slice(0, 6) }))} className="font-mono" />
          </Field>
        </div>
        <Field label="Name" htmlFor="a-name" error={errs.name}>
          <Input id="a-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Cloud hosting" autoFocus />
        </Field>
        <Field label="Description" htmlFor="a-desc" optional>
          <Textarea id="a-desc" rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>
      </form>
    </Modal>
  );
}

export default function AccountsPage() {
  return (
    <FinancialsGate>
      <AccountsView />
    </FinancialsGate>
  );
}
