"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Landmark, Sparkles, Upload } from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, NavTabs, PageHeader, Select, SkeletonRows, useToast } from "@/components/app-ui";
import { AccountSelect, FinancialsGate, ReasonModal, calendarDate, useAccounts, type LedgerAccount } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { api, qs, useApi, type ApiError } from "@/lib/api";
import { money, todayIso } from "@/lib/format";
import { cn } from "@/lib/utils";

const isBankAccount = (a: LedgerAccount) => !a.wallet_id && !a.archived && (a.subtype === "cash" || (a.type === "liability" && !a.system_key));

function BankView() {
  const params = useSearchParams();
  const router = useRouter();
  const { can } = useSession();
  const toast = useToast();
  const { data: accounts } = useAccounts();
  const banks = useMemo(() => (accounts?.data ?? []).filter(isBankAccount), [accounts]);
  const accountId = params.get("account") ?? banks[0]?.id ?? "";
  const status = params.get("status") ?? "unmatched";
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState<any>(null);
  const [excluding, setExcluding] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { data, error, mutate } = useApi<{ data: any[] }>(accountId ? `/v1/accounting/bank/${accountId}/lines${qs({ status })}` : null);
  const setParam = (k: string, v: string) => {
    const u = new URLSearchParams(params.toString());
    u.set(k, v);
    router.replace(`/app/accounting/bank?${u.toString()}`, { scroll: false });
  };
  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await fn();
      toast("success", success);
      mutate();
    } catch (e) {
      toast("error", (e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Books", href: "/app/accounting" }, { label: "Bank reconciliation" }]}
        title="Bank reconciliation"
        description="Wallets are reconciled against the chain automatically. For bank and card accounts, import the statement, match each line to the ledger, and check the balances agree."
        actions={
          accountId && can("financials:write") ? (
            <>
              <Button icon={<Sparkles />} loading={busy === "auto"} onClick={() => act("auto", () => api(`/v1/accounting/bank/${accountId}/auto-match`, { method: "POST" }).then((r: any) => r), "Matched every line with exactly one candidate.")}>
                Auto-match
              </Button>
              <Button variant="primary" icon={<Upload />} onClick={() => setImporting(true)}>
                Import statement
              </Button>
            </>
          ) : undefined
        }
      />
      {accounts && banks.length === 0 ? (
        <Card>
          <EmptyState icon={<Landmark />} title="No bank or card accounts">Add one in the chart of accounts (an asset account of type cash, like “Business Checking”), then import its statement here.</EmptyState>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-[320px] max-sm:w-full">
              <Select value={accountId} onValueChange={(v) => setParam("account", v)} options={banks.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))} placeholder="Choose an account" aria-label="Account" />
            </div>
          </div>
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px] [&>*]:min-w-0">
            <Card>
              <NavTabs
                label="Statement lines"
                items={["unmatched", "matched", "excluded"].map((s) => ({ href: `/app/accounting/bank?${new URLSearchParams({ account: accountId, status: s })}`, label: s[0]!.toUpperCase() + s.slice(1), active: status === s }))}
              />
              {error ? (
                <ErrorState error={error} retry={() => mutate()} />
              ) : !data ? (
                <SkeletonRows rows={6} cols={4} />
              ) : data.data.length === 0 ? (
                <EmptyState icon={status === "unmatched" ? <CheckCircle2 /> : <Landmark />} title={status === "unmatched" ? "Nothing to match" : `No ${status} lines`} mascot={status === "unmatched" ? "success" : undefined}>
                  {status === "unmatched" ? "Every imported statement line is matched or excluded." : "Lines appear here as you work through the statement."}
                </EmptyState>
              ) : (
                <ul className="divide-y">
                  {data.data.map((l) => (
                    <li key={l.id} className="grid gap-2 px-6 py-3.5 max-md:px-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="font-medium">{l.description}</p>
                          <p className="text-sm text-muted-foreground">
                            {calendarDate(l.date)}
                            {l.reference && ` · ${l.reference}`}
                            {l.matched && ` · matched to ${l.matched.entry_number}`}
                            {l.excluded_reason && ` · excluded: ${l.excluded_reason}`}
                          </p>
                        </div>
                        <span className={cn("tabular shrink-0 font-semibold", l.amount.startsWith("-") ? "" : "text-success")}>{money(l.amount, { sign: true })}</span>
                      </div>
                      {status === "unmatched" && can("financials:write") && (
                        <div className="flex flex-wrap items-center gap-2">
                          {l.suggestions.map((sug: any) => (
                            <Button key={sug.journal_line_id} size="sm" loading={busy === `${l.id}-${sug.journal_line_id}`} onClick={() => act(`${l.id}-${sug.journal_line_id}`, () => api(`/v1/accounting/bank/lines/${l.id}/match`, { method: "POST", body: { journal_line_id: sug.journal_line_id } }), "Matched.")}>
                              Match {sug.number} · {calendarDate(sug.date)}
                            </Button>
                          ))}
                          {l.suggestions.length === 0 && <span className="text-xs text-muted-foreground">No ledger line with this amount nearby.</span>}
                          {can("financials:approve") && <Button size="sm" variant="ghost" onClick={() => setCreating(l)}>Create entry</Button>}
                          <Button size="sm" variant="ghost" onClick={() => setExcluding(l)}>Exclude</Button>
                        </div>
                      )}
                      {status !== "unmatched" && can("financials:write") && (
                        <div>
                          <Button size="sm" variant="ghost" loading={busy === l.id} onClick={() => act(l.id, () => api(`/v1/accounting/bank/lines/${l.id}/unmatch`, { method: "POST" }), "Back to unmatched.")}>
                            Undo
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {accountId && <ReconcilePanel accountId={accountId} refreshKey={data} />}
          </div>
        </>
      )}
      {importing && accountId && <ImportModal accountId={accountId} onClose={() => setImporting(false)} onDone={() => { setImporting(false); mutate(); }} />}
      {creating && <CreateEntryModal line={creating} onClose={() => setCreating(null)} onDone={() => { setCreating(null); mutate(); }} />}
      <ReasonModal
        open={!!excluding}
        onClose={() => setExcluding(null)}
        title="Exclude this line?"
        description="Use it for lines that don't belong in the books (a duplicate row, a pending authorization). It stays on record with your reason."
        confirmLabel="Exclude line"
        onConfirm={async (reason) => {
          await api(`/v1/accounting/bank/lines/${excluding.id}/exclude`, { method: "POST", body: { reason } });
          mutate();
        }}
      />
    </div>
  );
}

function ReconcilePanel({ accountId, refreshKey }: { accountId: string; refreshKey: unknown }) {
  const { can } = useSession();
  const toast = useToast();
  const [date, setDate] = useState(todayIso());
  const [balance, setBalance] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: st, mutate } = useApi<any>(`/v1/accounting/bank/${accountId}/reconciliation${qs({ date, statement_balance: balance.trim() || undefined })}`, { keepPreviousData: true });
  useEffect(() => {
    mutate();
  }, [refreshKey, mutate]);
  const complete = async () => {
    setBusy(true);
    try {
      await api(`/v1/accounting/bank/${accountId}/reconciliation`, { method: "POST", body: { statement_date: date, statement_balance: balance.trim() } });
      toast("success", `Reconciled through ${calendarDate(date, { year: true })}.`);
      mutate();
    } catch (e) {
      toast("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Reconcile" description="Enter the closing balance from your statement.">
      <div className="grid gap-4 px-6 py-5 max-md:px-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Statement date" htmlFor="rec-date">
            <Input id="rec-date" type="date" value={date} max={todayIso()} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </Field>
          <Field label="Statement balance" htmlFor="rec-bal">
            <Input id="rec-bal" inputMode="decimal" className="tabular" placeholder="0.00" value={balance} onChange={(e) => setBalance(e.target.value.replace(/[^\d.,-]/g, ""))} />
          </Field>
        </div>
        {st && (
          <dl className="tabular grid gap-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-muted-foreground">Ledger balance</dt><dd>{money(st.ledger_balance)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">Less items not on the statement ({st.uncleared.length})</dt><dd>{money(st.uncleared_total)}</dd></div>
            <div className="flex justify-between border-t pt-1.5 font-medium"><dt>Should match the statement</dt><dd>{money(st.adjusted_balance)}</dd></div>
            {st.difference !== null && (
              <div className={cn("flex justify-between font-semibold", st.difference === "0.00" ? "text-success" : "text-warning")}>
                <dt>Difference</dt>
                <dd>{money(st.difference)}</dd>
              </div>
            )}
          </dl>
        )}
        {st?.unmatched_statement_lines > 0 && <Alert tone="warning">{st.unmatched_statement_lines} statement line{st.unmatched_statement_lines === 1 ? "" : "s"} on or before this date still need matching.</Alert>}
        {st?.uncleared.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Items in the ledger but not on the statement</summary>
            <ul className="mt-2 grid gap-1">
              {st.uncleared.map((u: any) => (
                <li key={u.journal_line_id} className="tabular flex justify-between gap-3">
                  <span className="truncate">{u.number} · {u.description}</span>
                  <span>{money(u.amount)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {can("financials:approve") && (
          <Button variant="primary" disabled={!st?.can_complete} loading={busy} onClick={complete}>
            Complete reconciliation
          </Button>
        )}
        {st?.reconciled_through && <Badge tone="success">Reconciled through {calendarDate(st.reconciled_through, { year: true })}</Badge>}
      </div>
    </Card>
  );
}

function ImportModal({ accountId, onClose, onDone }: { accountId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [mapping, setMapping] = useState({ date: "", description: "", amount: "", money_in: "", money_out: "", reference: "" });
  const [dateFormat, setDateFormat] = useState("YYYY-MM-DD");
  const [split, setSplit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<any>(null);
  const headers = useMemo(() => (file ? (file.text.split(/\r?\n/)[0] ?? "").split(",").map((h) => h.replace(/^"|"$/g, "").trim()).filter(Boolean) : []), [file]);
  useEffect(() => {
    const find = (re: RegExp) => headers.find((h) => re.test(h)) ?? "";
    setMapping({ date: find(/date/i), description: find(/desc|detail|narr|memo|payee/i), amount: find(/^amount$|amount/i), money_in: find(/credit|in$|deposit|paid in/i), money_out: find(/debit|out$|withdraw|paid out/i), reference: find(/ref/i) });
  }, [headers]);
  const opts = [{ value: "", label: "None" }, ...headers.map((h) => ({ value: h, label: h }))];
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const m = split ? { date: mapping.date, description: mapping.description, money_in: mapping.money_in || undefined, money_out: mapping.money_out || undefined, reference: mapping.reference || undefined } : { date: mapping.date, description: mapping.description, amount: mapping.amount, reference: mapping.reference || undefined };
      const r = await api<any>(`/v1/accounting/bank/${accountId}/import`, { method: "POST", body: { filename: file.name, csv: file.text, mapping: m, date_format: dateFormat } });
      setResult(r);
      toast("success", `Imported ${r.imported} line${r.imported === 1 ? "" : "s"}${r.skipped ? `; ${r.skipped} already imported` : ""}.`);
      if (!r.errors.length) onDone();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title="Import a bank statement"
      description="Export the statement from your bank as CSV. Importing the same file twice never creates duplicates."
      footer={
        <>
          <Button variant="ghost" onClick={result ? onDone : onClose}>{result ? "Done" : "Cancel"}</Button>
          <Button variant="primary" loading={busy} disabled={!file || !mapping.date || !mapping.description || (split ? !mapping.money_in && !mapping.money_out : !mapping.amount)} onClick={submit}>Import</Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        {result?.errors?.length > 0 && (
          <Alert tone="warning" title={`${result.errors.length} row${result.errors.length === 1 ? "" : "s"} skipped`}>
            <ul className="text-sm">{result.errors.slice(0, 5).map((e: any) => <li key={e.row}>Row {e.row}: {e.message}</li>)}</ul>
          </Alert>
        )}
        <Field label="CSV file" htmlFor="bank-file">
          <Input
            id="bank-file"
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setFile({ name: f.name, text: await f.text() });
            }}
          />
        </Field>
        {file && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date column" htmlFor="m-date"><Select id="m-date" value={mapping.date} onValueChange={(v) => setMapping((m) => ({ ...m, date: v }))} options={opts} /></Field>
              <Field label="Date format" htmlFor="m-fmt"><Select id="m-fmt" value={dateFormat} onValueChange={setDateFormat} options={["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "DD.MM.YYYY"].map((v) => ({ value: v, label: v }))} /></Field>
              <Field label="Description column" htmlFor="m-desc"><Select id="m-desc" value={mapping.description} onValueChange={(v) => setMapping((m) => ({ ...m, description: v }))} options={opts} /></Field>
              <Field label="Reference column" htmlFor="m-ref" optional><Select id="m-ref" value={mapping.reference} onValueChange={(v) => setMapping((m) => ({ ...m, reference: v }))} options={opts} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} className="accent-[var(--primary)]" />
              Money in and money out are separate columns
            </label>
            {split ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Money in column" htmlFor="m-in"><Select id="m-in" value={mapping.money_in} onValueChange={(v) => setMapping((m) => ({ ...m, money_in: v }))} options={opts} /></Field>
                <Field label="Money out column" htmlFor="m-out"><Select id="m-out" value={mapping.money_out} onValueChange={(v) => setMapping((m) => ({ ...m, money_out: v }))} options={opts} /></Field>
              </div>
            ) : (
              <Field label="Amount column" htmlFor="m-amt" hint="Positive for money in, negative (or in brackets) for money out."><Select id="m-amt" value={mapping.amount} onValueChange={(v) => setMapping((m) => ({ ...m, amount: v }))} options={opts} /></Field>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function CreateEntryModal({ line, onClose, onDone }: { line: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/accounting/bank/lines/${line.id}/create-entry`, { method: "POST", body: { account_id: account } });
      toast("success", "Entry posted and matched.");
      onDone();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Record this in the books" description={`${line.description} · ${money(line.amount, { sign: true })} on ${calendarDate(line.date)}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!account} onClick={submit}>Post and match</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        <Field label={line.amount.startsWith("-") ? "What was it for?" : "Where did it come from?"} htmlFor="ce-account" hint="For example Payment & Bank Fees for a monthly fee, or Owner's Equity for money the owner put in.">
          <AccountSelect id="ce-account" value={account} onChange={setAccount} filter={(a) => !a.wallet_id && !["accounts_receivable", "accounts_payable", "payments_to_identify", "transfers_to_classify"].includes(a.system_key ?? "")} />
        </Field>
      </div>
    </Modal>
  );
}

export default function BankPage() {
  return (
    <FinancialsGate>
      <Suspense>
        <BankView />
      </Suspense>
    </FinancialsGate>
  );
}
