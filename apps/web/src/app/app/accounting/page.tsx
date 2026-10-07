"use client";

import Link from "next/link";
import { sumDecimalAmounts } from "@setra/schemas";
import { useState } from "react";
import { AlertTriangle, CalendarCheck, CheckCircle2, ChevronRight, CircleDashed, Coins, Download, Landmark, Lock, LockOpen, NotebookPen, RefreshCw, Scale, Wrench } from "lucide-react";
import { Alert, Badge, Button, ButtonLink, Card, ErrorState, Metric, Metrics, PageHeader, SkeletonBlock, SkeletonRows, useToast } from "@/components/app-ui";
import { BooksOnMonad } from "@/components/books-on-monad";
import { FinancialsGate, ReasonModal, presetRange, useAccounts } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { Seti } from "@/components/seti";
import { api, qs, useApi, type ApiError } from "@/lib/api";
import { money, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Health {
  healthy: boolean;
  checked_at: string;
  method: string;
  checks: Array<{ key: string; label: string; status: "ok" | "attention" | "not_checked"; detail: string; expected?: string; actual?: string; link?: string | null }>;
  issues: Array<{ id: string; source_type: string; message: string; created_at: string }>;
}

function BooksView() {
  const { can } = useSession();
  const toast = useToast();
  const { data: accounts } = useAccounts();
  const { data: health, error, mutate } = useApi<Health>("/v1/accounting/health");
  const month = presetRange("month");
  const { data: pl } = useApi<any>(`/v1/accounting/reports/profit-and-loss${qs(month)}`);
  const { data: open } = useApi<any>("/v1/accounting/unclassified");
  const [repairing, setRepairing] = useState(false);
  const [allChecks, setAllChecks] = useState(false);

  const bal = (key: string) => accounts?.data.find((a) => a.system_key === key)?.balance ?? "0.00";
  const cash = accounts ? sumDecimalAmounts(accounts.data.filter((a) => a.subtype === "cash").map((a) => a.balance)) : null;
  const waiting = (open?.receipts.length ?? 0) + (open?.outgoing.length ?? 0);

  const repair = async () => {
    setRepairing(true);
    try {
      const r = await api<{ retried: number; posted: number; still_failing: number }>("/v1/accounting/repair", { method: "POST" });
      toast(r.still_failing ? "error" : "success", r.posted || r.retried ? `Posted ${r.posted} missing entr${r.posted === 1 ? "y" : "ies"}; ${r.still_failing} still failing.` : "Nothing to repair. The books were already complete.");
      mutate();
    } catch (e) {
      toast("error", (e as ApiError).message);
    } finally {
      setRepairing(false);
    }
  };

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        title="Books"
        description="One double-entry ledger for invoices, payments, bills, expenses and corrections. Every balance traces back to its journal entries and source records."
        actions={
          <>
            <ButtonLink href="/app/reports">Reports</ButtonLink>
            {can("financials:write") && (
              <ButtonLink href="/app/accounting/journal/new" variant="primary" icon={<NotebookPen />}>
                Journal entry
              </ButtonLink>
            )}
          </>
        }
      />

      <Metrics label="Key balances" className="xl:grid-cols-5">
        <Metric label="Cash" value={cash ?? "…"} money foot="Wallets and bank accounts" href="/app/reports/balance-sheet" />
        <Metric label="Customers owe you" value={accounts ? bal("accounts_receivable") : "…"} money foot="Accounts receivable" href="/app/reports/receivables" />
        <Metric label="You owe vendors" value={accounts ? bal("accounts_payable") : "…"} money foot="Accounts payable" href="/app/reports/payables" />
        <Metric label="Net income" value={pl?.net_income ?? "…"} money foot="This month" href="/app/reports/profit-and-loss" />
        <Metric label="Waiting for a decision" value={open ? String(waiting) : "…"} foot={waiting ? "Unidentified or unclassified money" : "Everything is classified"} href="/app/accounting/classify" warn={waiting > 0} />
      </Metrics>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px] [&>*]:min-w-0">
        <Card
          title="Do the books agree?"
          description="Setra compares the ledger with invoices, bills, wallets and onchain activity each time this page loads."
          actions={
            <>
              <Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={() => mutate()} aria-label="Check again">
                Check again
              </Button>
              {can("financials:manage") && (
                <Button size="sm" icon={<Wrench />} loading={repairing} onClick={repair}>
                  Repair
                </Button>
              )}
            </>
          }
        >
          {error ? (
            <ErrorState error={error} retry={() => mutate()} />
          ) : !health ? (
            <SkeletonRows rows={6} cols={2} />
          ) : (
            <>
              <div className="flex items-center gap-4 border-b px-6 py-4 max-md:px-4">
                <Seti mood={health.healthy ? "success" : "attention"} size={64} />
                <div>
                  <p className="font-semibold">{health.healthy ? "Everything reconciles." : "A few things need a look."}</p>
                  <p className="text-sm text-muted-foreground">
                    {health.method === "accrual" ? "Accrual" : "Cash"} basis · checked {timeAgo(health.checked_at)}
                  </p>
                </div>
              </div>
              <ul className="divide-y">
                {/* Passing checks are folded away: only what needs a look is shown by default. */}
                {health.checks.filter((c) => allChecks || c.status !== "ok").map((c) => {
                  const Icon = c.status === "ok" ? CheckCircle2 : c.status === "attention" ? AlertTriangle : CircleDashed;
                  const body = (
                    <>
                      <Icon className={cn("mt-0.5 size-[18px] shrink-0", c.status === "ok" ? "text-success" : c.status === "attention" ? "text-warning" : "text-muted-foreground")} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{c.label}</p>
                        <p className="text-sm text-muted-foreground">{c.detail}</p>
                        {c.status === "attention" && c.expected !== undefined && c.actual !== undefined && (
                          <p className="tabular mt-1 text-xs text-muted-foreground">
                            Ledger {money(c.actual)} · expected {money(c.expected)}
                          </p>
                        )}
                      </div>
                      {c.link && <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                    </>
                  );
                  return (
                    <li key={c.key}>
                      {c.link ? (
                        <Link href={c.link} className="flex gap-3 px-6 py-3.5 transition-colors hover:bg-accent/50 max-md:px-4">
                          {body}
                        </Link>
                      ) : (
                        <div className="flex gap-3 px-6 py-3.5 max-md:px-4">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {health.checks.some((c) => c.status === "ok") && (
                <button type="button" onClick={() => setAllChecks((v) => !v)} aria-expanded={allChecks} className="w-full cursor-pointer border-t px-6 py-3 text-left text-sm font-medium text-primary hover:bg-accent/50 max-md:px-4">
                  {allChecks ? "Hide passing checks" : `Show all ${health.checks.length} checks (${health.checks.filter((c) => c.status === "ok").length} passing)`}
                </button>
              )}
              {health.issues.length > 0 && (
                <div className="border-t px-6 py-4 max-md:px-4">
                  <Alert tone="warning" title="Automatic postings that failed">
                    <ul className="mt-1 grid gap-1 text-sm">
                      {health.issues.slice(0, 5).map((i) => (
                        <li key={i.id}>
                          {i.message} <span className="text-muted-foreground">({timeAgo(i.created_at)})</span>
                        </li>
                      ))}
                    </ul>
                  </Alert>
                </div>
              )}
            </>
          )}
        </Card>

        <div className="grid gap-6 [&>*]:min-w-0">
          <ToolsCard />
          <PeriodsCard />
          <MethodCard />
        </div>
      </div>
    </div>
  );
}

function PeriodsCard() {
  const { can } = useSession();
  const toast = useToast();
  const { data, mutate } = useApi<{ data: Array<{ month: string; status: string; ended: boolean; posted_entries: number; draft_entries: number; closed_by: string | null; reopen_reason: string | null }> }>("/v1/accounting/periods");
  const [reopen, setReopen] = useState<string | null>(null);
  const label = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return (
    <Card title="Periods" description="Close a month once it's final. Late activity lands in the next open month.">
      {!data ? (
        <SkeletonBlock height={160} />
      ) : (
        <ul className="divide-y">
          {data.data.slice(0, 8).map((p) => (
            <li key={p.month} className="flex items-center justify-between gap-3 px-6 py-3 max-md:px-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-medium">
                  <Link href={`/app/accounting/periods/${p.month}`} className="hover:underline">{label(p.month)}</Link>
                  {p.status === "closed" ? <Badge tone="neutral" icon={<Lock className="size-3" />} dot={false}>Closed</Badge> : !p.ended ? <Badge tone="info">Current</Badge> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {p.posted_entries} posted{p.draft_entries ? ` · ${p.draft_entries} draft` : ""}
                  {p.reopen_reason && p.status === "open" ? ` · reopened: ${p.reopen_reason}` : ""}
                </p>
                {p.status === "closed" && <BooksOnMonad month={p.month} label={label(p.month)} />}
              </div>
              {can("financials:manage") &&
                (p.status === "closed" ? (
                  <Button size="sm" variant="ghost" icon={<LockOpen />} onClick={() => setReopen(p.month)}>
                    Reopen
                  </Button>
                ) : p.ended ? (
                  <ButtonLink size="sm" icon={<Lock />} href={`/app/accounting/periods/${p.month}`}>
                    Review and close
                  </ButtonLink>
                ) : (
                  <ButtonLink size="sm" variant="ghost" href={`/app/accounting/periods/${p.month}`}>
                    So far
                  </ButtonLink>
                ))}
            </li>
          ))}
        </ul>
      )}
      {can("financials:manage") && <YearEndButton />}
      <ReasonModal
        open={!!reopen}
        onClose={() => setReopen(null)}
        title={reopen ? `Reopen ${label(reopen)}?` : ""}
        description="Reopening allows posting into a month that was final. Use it for a controlled adjustment, then close it again."
        confirmLabel="Reopen period"
        onConfirm={async (reason) => {
          await api("/v1/accounting/periods/reopen", { method: "POST", body: { month: reopen, reason } });
          toast("success", "Period reopened.");
          mutate();
        }}
      />
    </Card>
  );
}

function ToolsCard() {
  const tools = [
    { href: "/app/accounting/bank", icon: Landmark, title: "Bank reconciliation", body: "Import a statement and match it to the ledger." },
    { href: "/app/accounting/opening-balances", icon: Scale, title: "Opening balances", body: "Where the books start: bank, wallets, loans." },
    { href: "/app/accounting/rates", icon: Coins, title: "Exchange rates & gas", body: "Rates for non-USD amounts and network fees." },
    { href: "/app/accounting/export", icon: Download, title: "Export for your accountant", body: "QuickBooks Online, Xero or CSV." }
  ];
  return (
    <Card title="Tools">
      <ul className="divide-y">
        {tools.map(({ href, icon: Icon, title, body }) => (
          <li key={href}>
            <Link href={href} className="flex items-center gap-3 px-6 py-3 transition-colors hover:bg-accent/50 max-md:px-4">
              <Icon className="size-[18px] shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{title}</span>
                <span className="block text-sm text-muted-foreground">{body}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function YearEndButton() {
  const toast = useToast();
  const year = new Date().getFullYear() - 1;
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ net_income: string; changed: boolean }>(`/v1/accounting/years/${year}/close`, { method: "POST" });
      toast("success", r.changed ? `${year} closed. ${money(r.net_income)} moved to Retained Earnings.` : `${year} was already closed and nothing changed.`);
      setConfirm(false);
    } catch (e) {
      toast("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return confirm ? (
    <div className="grid gap-2 border-t px-6 py-3 text-sm max-md:px-4">
      <p>Close {year}? Its revenue and expenses move into Retained Earnings and all its months are closed. Profit and loss for {year} still reads normally. You can run it again after a late adjustment.</p>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={busy} onClick={run}>Close {year}</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
      </div>
    </div>
  ) : (
    <div className="border-t px-6 py-3 max-md:px-4">
      <Button size="sm" variant="ghost" icon={<CalendarCheck />} onClick={() => setConfirm(true)}>Close the year {year}</Button>
    </div>
  );
}

function MethodCard() {
  const { can } = useSession();
  const toast = useToast();
  const { data, mutate } = useApi<{ method: "accrual" | "cash"; method_locked: boolean; reporting_currency: string; valuation: string }>("/v1/accounting/settings");
  const [busy, setBusy] = useState(false);
  if (!data) return <SkeletonBlock height={140} />;
  const other = data.method === "accrual" ? "cash" : "accrual";
  const change = async () => {
    setBusy(true);
    try {
      await api("/v1/accounting/settings", { method: "PATCH", body: { method: other } });
      toast("success", `Switched to ${other} basis.`);
      mutate();
    } catch (e) {
      toast("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Accounting method" padded>
      <div className="grid gap-3 text-sm">
        <p>
          <span className="font-semibold">{data.method === "accrual" ? "Accrual basis." : "Cash basis."}</span>{" "}
          <span className="text-muted-foreground">
            {data.method === "accrual" ? "Revenue counts when you invoice; customers owe you until they pay." : "Revenue counts when money arrives; open invoices aren't in the ledger."}
          </span>
        </p>
        <p className="text-muted-foreground">
          Reporting in {data.reporting_currency}. {data.valuation}
        </p>
        {can("financials:manage") &&
          (data.method_locked ? (
            <p className="text-xs text-muted-foreground">The method is fixed once entries exist, so past entries keep their meaning.</p>
          ) : (
            <div>
              <Button size="sm" loading={busy} onClick={change}>
                Use {other} basis
              </Button>
            </div>
          ))}
      </div>
    </Card>
  );
}

export default function BooksPage() {
  return (
    <FinancialsGate>
      <BooksView />
    </FinancialsGate>
  );
}
