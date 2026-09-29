"use client";

import { useParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Archive, ArchiveRestore, BookOpen, Pencil } from "lucide-react";
import { Alert, BigMoney, Button, Card, EmptyState, ErrorState, Field, Input, KV, Modal, PageHeader, SkeletonBlock, SkeletonRows, Textarea, useToast } from "@/components/app-ui";
import { ExportLink, FinancialsGate, LedgerLines, RangePicker, TYPE_LABEL, useRange } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { api, qs, useApi, type ApiError } from "@/lib/api";
import { money } from "@/lib/format";

function AccountView() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const toast = useToast();
  const { preset, from, to } = useRange();
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false);
  const { data: a, error, mutate } = useApi<any>(`/v1/accounting/accounts/${id}`);
  const range = preset === "all" ? {} : { from, to };
  const glPath = `/v1/accounting/ledger${qs({ account_id: id, ...range })}`;
  const { data: gl, error: glError } = useApi<any>(`${glPath}&limit=100&offset=${page * 100}`, { keepPreviousData: true });

  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!a) return <SkeletonBlock height={400} />;

  const archive = async (archived: boolean) => {
    try {
      await api(`/v1/accounting/accounts/${id}`, { method: "PATCH", body: { archived } });
      toast("success", archived ? "Account archived." : "Account restored.");
      mutate();
    } catch (e) {
      toast("error", (e as ApiError).message);
    }
  };

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Books", href: "/app/accounting" }, { label: "Chart of accounts", href: "/app/accounting/accounts" }, { label: `${a.code} ${a.name}` }]}
        title={
          <span>
            <span className="mr-3 font-mono text-[0.7em] font-medium text-muted-foreground">{a.code}</span>
            {a.name}
          </span>
        }
        description={a.description ?? `${TYPE_LABEL[a.type as keyof typeof TYPE_LABEL]} account. Normal balance: ${a.normal_balance}.`}
        actions={
          can("financials:manage") && (
            <>
              <Button icon={<Pencil />} onClick={() => setEditing(true)}>Edit</Button>
              {!a.system && !a.wallet_id && (a.archived ? <Button icon={<ArchiveRestore />} onClick={() => archive(false)}>Restore</Button> : <Button variant="ghost" icon={<Archive />} onClick={() => archive(true)}>Archive</Button>)}
            </>
          )
        }
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px] [&>*]:min-w-0">
        <Card
          title="Activity"
          description={a.system ? "Setra posts to this account automatically. Click a line to see the full entry and where it came from." : "Click a line to see the full entry."}
          actions={
            <>
              <RangePicker />
              <ExportLink path={glPath} />
            </>
          }
        >
          {glError ? (
            <ErrorState error={glError} />
          ) : !gl ? (
            <SkeletonRows rows={8} cols={5} />
          ) : gl.lines.length === 0 ? (
            <EmptyState icon={<BookOpen />} title="No activity in this period">Try a wider date range.</EmptyState>
          ) : (
            <>
              {gl.opening_balance !== null && <div className="tabular flex justify-between border-b px-6 py-2.5 text-sm text-muted-foreground max-md:px-4"><span>Opening balance</span><span>{money(gl.opening_balance)}</span></div>}
              <LedgerLines lines={gl.lines} running showAccount={false} />
              <div className="tabular flex justify-between border-t bg-muted/40 px-6 py-3 font-semibold max-md:px-4">
                <span>{gl.has_more ? "Balance at end of this page" : "Closing balance"}</span>
                <span>{money(gl.closing_balance)}</span>
              </div>
              {(page > 0 || gl.has_more) && (
                <div className="flex justify-end gap-2 border-t px-6 py-3 max-md:px-4">
                  <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                  <Button size="sm" variant="ghost" disabled={!gl.has_more} onClick={() => setPage((p) => p + 1)}>Next</Button>
                </div>
              )}
            </>
          )}
        </Card>
        <div className="grid gap-6 [&>*]:min-w-0">
          <Card padded>
            <p className="text-sm font-medium text-muted-foreground">Balance today</p>
            <BigMoney value={a.balance} className="mt-1" />
            <div className="mt-4">
              <KV
                items={[
                  ["Type", TYPE_LABEL[a.type as keyof typeof TYPE_LABEL]],
                  ["Total debits", <span key="d" className="tabular">{money(a.debits)}</span>],
                  ["Total credits", <span key="c" className="tabular">{money(a.credits)}</span>],
                  a.system && ["Role", "Posted to automatically"],
                  a.archived && ["Status", "Archived"]
                ]}
              />
            </div>
          </Card>
          {a.monthly.length > 0 && (
            <Card title="By month">
              <ul className="divide-y">
                {a.monthly.map((m: any) => (
                  <li key={m.month} className="tabular flex justify-between px-6 py-2.5 text-sm max-md:px-4">
                    <span className="text-muted-foreground">{new Date(Number(m.month.slice(0, 4)), Number(m.month.slice(5)) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" })}</span>
                    <span className={m.net.startsWith("-") ? "text-destructive" : ""}>{money(m.net, { sign: true })}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
      <EditAccountModal open={editing} onClose={() => setEditing(false)} account={a} onSaved={() => mutate()} />
    </div>
  );
}

function EditAccountModal({ open, onClose, account, onSaved }: { open: boolean; onClose: () => void; account: any; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: account.name as string, code: account.code as string, description: (account.description ?? "") as string });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/accounting/accounts/${account.id}`, { method: "PATCH", body: { name: form.name, code: form.code, description: form.description || null } });
      toast("success", "Account updated.");
      onSaved();
      onClose();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Edit account" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        {account.system && <Alert tone="info">Setra posts to this account automatically. You can rename or renumber it; its role stays the same.</Alert>}
        <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
          <Field label="Code" htmlFor="e-code"><Input id="e-code" className="font-mono" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.replace(/\D/g, "").slice(0, 6) }))} /></Field>
          <Field label="Name" htmlFor="e-name"><Input id="e-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
        </div>
        <Field label="Description" htmlFor="e-desc" optional><Textarea id="e-desc" rows={3} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></Field>
      </div>
    </Modal>
  );
}

export default function AccountPage() {
  return (
    <FinancialsGate>
      <Suspense>
        <AccountView />
      </Suspense>
    </FinancialsGate>
  );
}
