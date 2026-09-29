"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { Download, ExternalLink, Lock } from "lucide-react";
import { Alert, Badge, Button, EmptyState, Field, Input, Modal, Select, Textarea, useToast } from "@/components/app-ui";
import { useSession } from "@/components/session";
import { api, useApi, type ApiError } from "@/lib/api";
import { calendarDate, money, shortAddress, todayIso } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** Shared pieces for the accounting pages: account pickers, date ranges, statement rows, entry status. */

export interface LedgerAccount {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "cogs" | "expense";
  subtype: string;
  normal_balance: "debit" | "credit";
  system: boolean;
  system_key: string | null;
  wallet_id: string | null;
  description: string | null;
  archived: boolean;
  balance: string;
}

export const TYPE_LABEL: Record<LedgerAccount["type"], string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  revenue: "Revenue",
  cogs: "Cost of goods sold",
  expense: "Expenses"
};
export const TYPE_ORDER: LedgerAccount["type"][] = ["asset", "liability", "equity", "revenue", "cogs", "expense"];

export function useAccounts() {
  return useApi<{ data: LedgerAccount[] }>("/v1/accounting/accounts");
}

/** A grouped account picker. `filter` narrows it (e.g. expense accounts only). */
export function AccountSelect({ value, onChange, filter, placeholder = "Choose an account", id, invalid, size }: { value: string; onChange: (v: string) => void; filter?: (a: LedgerAccount) => boolean; placeholder?: string; id?: string; invalid?: boolean; size?: "sm" | "default" }) {
  const { data } = useAccounts();
  const options = useMemo(
    () =>
      TYPE_ORDER.map((t) => ({
        group: TYPE_LABEL[t],
        options: (data?.data ?? []).filter((a) => a.type === t && !a.archived && (!filter || filter(a))).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))
      })),
    [data, filter]
  );
  return <Select id={id} value={value} onValueChange={onChange} options={options} placeholder={data ? placeholder : "Loading accounts…"} invalid={invalid} size={size} />;
}

export const isSpendAccount = (a: LedgerAccount) => ["expense", "cogs"].includes(a.type) || (a.type === "asset" && a.subtype !== "cash" && !a.system_key);
export const isPayFromAccount = (a: LedgerAccount) => !a.wallet_id && (a.subtype === "cash" || a.type === "equity" || (a.type === "liability" && !a.system_key));
export const isClassifyAccount = (a: LedgerAccount) => !["payments_to_identify", "transfers_to_classify"].includes(a.system_key ?? "") && !a.wallet_id;

// ── Date ranges ───────────────────────────────────────────────────────────────────────────────

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function presetRange(preset: string): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case "last_month":
      return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case "quarter": {
      const q = Math.floor(m / 3) * 3;
      return { from: iso(new Date(y, q, 1)), to: todayIso() };
    }
    case "ytd":
      return { from: iso(new Date(y, 0, 1)), to: todayIso() };
    case "last_year":
      return { from: iso(new Date(y - 1, 0, 1)), to: iso(new Date(y - 1, 11, 31)) };
    case "all":
      return { from: "2020-01-01", to: todayIso() };
    default:
      return { from: iso(new Date(y, m, 1)), to: todayIso() };
  }
}

const PRESETS = [
  { value: "month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "quarter", label: "This quarter" },
  { value: "ytd", label: "Year to date" },
  { value: "last_year", label: "Last year" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Custom" }
];

/** Report period in the URL (?from=&to=), so a report link always shows the same numbers. */
export function useRange(mode: "range" | "as_of" = "range") {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const preset = params.get("preset") ?? (params.get("from") || params.get("as_of") ? "custom" : "month");
  const fallback = presetRange(preset === "custom" ? "month" : preset);
  const from = params.get("from") ?? fallback.from;
  const to = params.get("to") ?? params.get("as_of") ?? (mode === "as_of" ? todayIso() : fallback.to);
  const set = (next: Record<string, string | null>) => {
    const u = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) (v === null ? u.delete(k) : u.set(k, v));
    router.replace(`${pathname}?${u.toString()}`, { scroll: false });
  };
  return { preset, from, to, set };
}

export function RangePicker({ mode = "range" }: { mode?: "range" | "as_of" }) {
  const { preset, from, to, set } = useRange(mode);
  if (mode === "as_of") {
    return (
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        As of
        <Input type="date" className="h-8 w-[150px]" value={to} max={todayIso()} onChange={(e) => e.target.value && set({ as_of: e.target.value })} aria-label="As of date" />
      </label>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select size="sm" className="w-auto" value={preset} onValueChange={(v) => (v === "custom" ? set({ preset: "custom", from, to }) : set({ preset: v, from: null, to: null }))} options={PRESETS} aria-label="Period" />
      {preset === "custom" && (
        <>
          <Input type="date" className="h-8 w-[150px]" value={from} onChange={(e) => e.target.value && set({ from: e.target.value })} aria-label="From" />
          <span className="text-muted-foreground">to</span>
          <Input type="date" className="h-8 w-[150px]" value={to} onChange={(e) => e.target.value && set({ to: e.target.value })} aria-label="To" />
        </>
      )}
    </div>
  );
}

export function ExportLink({ path, label = "Export CSV" }: { path: string; label?: string }) {
  const href = `/api${path}${path.includes("?") ? "&" : "?"}format=csv`;
  return (
    <a href={href} className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-3 text-sm font-medium shadow-xs transition-colors hover:bg-accent" download>
      <Download className="size-3.5" aria-hidden="true" />
      {label}
    </a>
  );
}

// ── Statements ────────────────────────────────────────────────────────────────────────────────

/** One statement row. Amounts are exact decimal strings; negatives use a true minus sign. */
export function StatementRow({ label, amount, href, level = 0, strong = false, total = false, muted = false, hint }: { label: ReactNode; amount: string | null | undefined; href?: string | null; level?: 0 | 1; strong?: boolean; total?: boolean; muted?: boolean; hint?: ReactNode }) {
  const content = (
    <>
      <span className={cn("min-w-0", level === 1 && "pl-5 max-sm:pl-3", muted && "text-muted-foreground")}>
        {label}
        {hint && <span className="block text-xs font-normal text-muted-foreground">{hint}</span>}
      </span>
      <span className={cn("tabular shrink-0 text-right", amount?.startsWith("-") && "text-destructive", muted && "text-muted-foreground")}>{money(amount)}</span>
    </>
  );
  const cls = cn("flex items-baseline justify-between gap-4 px-6 py-2.5 max-md:px-4", (strong || total) && "font-semibold", total && "border-t bg-muted/40 py-3");
  return href ? (
    <Link href={href} className={cn(cls, "transition-colors hover:bg-accent/60 focus-visible:bg-accent/60")}>
      {content}
    </Link>
  ) : (
    <div className={cls}>{content}</div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="border-t px-6 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase first:border-t-0 max-md:px-4">{children}</div>;
}

// ── Entries ───────────────────────────────────────────────────────────────────────────────────

const ENTRY_TONE: Record<string, "success" | "warning" | "neutral" | "info"> = { posted: "success", draft: "neutral", approved: "info", void: "neutral" };
export function EntryStatus({ status }: { status: string }) {
  return <Badge tone={ENTRY_TONE[status] ?? "neutral"}>{status === "void" ? "Discarded" : status[0]!.toUpperCase() + status.slice(1)}</Badge>;
}

export const BILL_TONE: Record<string, "success" | "warning" | "neutral" | "info" | "danger"> = { draft: "neutral", approved: "info", partially_paid: "warning", paid: "success", void: "neutral" };
export const BILL_LABEL: Record<string, string> = { draft: "Awaiting approval", approved: "To pay", partially_paid: "Partly paid", paid: "Paid", void: "Void" };
export const EXPENSE_TONE: Record<string, "success" | "warning" | "neutral"> = { pending: "warning", approved: "success", rejected: "neutral" };
export const EXPENSE_LABEL: Record<string, string> = { pending: "Awaiting approval", approved: "Recorded", rejected: "Rejected" };

/** Onchain proof for a line: the transaction, linked to the explorer unless it was simulated. */
export function TxProof({ hash, url, simulated }: { hash?: string | null; url?: string | null; simulated?: boolean }) {
  if (!hash) return null;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
      {shortAddress(hash, 8, 6)} <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  ) : (
    <span className="font-mono text-xs text-muted-foreground" title={simulated ? "Simulated in test mode" : undefined}>
      {shortAddress(hash, 8, 6)}
      {simulated && " (simulated)"}
    </span>
  );
}

/** Shown in place of a page when the role can't see the books. */
export function FinancialsGate({ children }: { children: ReactNode }) {
  const { can } = useSession();
  if (can("financials:read")) return <>{children}</>;
  return (
    <EmptyState icon={<Lock />} title="Your role can't see the books" mascot="resting">
      Financial statements and the ledger are visible to owners, admins, operators and viewers. Ask an owner if you need access.
    </EmptyState>
  );
}

/** Ask for a short reason before a consequential action (void, reverse, reject). */
export function ReasonModal({ open, onClose, title, description, confirmLabel, danger, onConfirm, extra }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: (reason: string) => Promise<void>; extra?: ReactNode }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const toast = useToast();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      setReason("");
      onClose();
    } catch (e) {
      setError(e as ApiError);
      toast("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} loading={busy} disabled={reason.trim().length < 3} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        {extra}
        <Field label="Reason" htmlFor="reason-input" hint="Kept permanently in the audit trail.">
          <Textarea id="reason-input" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus />
        </Field>
      </div>
    </Modal>
  );
}

/** Record who did what: POST helper that toasts and refreshes. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, path: string, body: unknown, success: string, after?: (r: any) => void) => {
    setBusy(key);
    try {
      const r = await api(path, { method: "POST", body });
      toast("success", success);
      after?.(r);
      return r;
    } catch (e) {
      toast("error", (e as ApiError).message);
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

/** General ledger lines. With `running`, shows the running balance of the one account being viewed. */
export function LedgerLines({ lines, running = false, showAccount = true }: { lines: any[]; running?: boolean; showAccount?: boolean }) {
  const router = useRouter();
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[92px]">Date</TableHead>
          <TableHead>Description</TableHead>
          {showAccount && <TableHead className="max-md:hidden">Account</TableHead>}
          <TableHead className="text-right">Debit</TableHead>
          <TableHead className="text-right">Credit</TableHead>
          {running && <TableHead className="text-right max-sm:hidden">Balance</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((l) => (
          <TableRow key={l.id} className="cursor-pointer" tabIndex={0} onClick={() => router.push(`/app/accounting/journal/${l.entry.id}`)} onKeyDown={(e) => e.key === "Enter" && router.push(`/app/accounting/journal/${l.entry.id}`)}>
            <TableCell className="text-muted-foreground whitespace-nowrap">{calendarDate(l.entry.date)}</TableCell>
            <TableCell className="max-w-[420px]">
              <span className="line-clamp-1 font-medium">{l.entry.description}</span>
              <span className="block text-xs text-muted-foreground">
                <span className="font-mono">{l.entry.number}</span>
                {(l.memo || l.customer?.name || l.vendor?.name) && ` · ${[l.customer?.name, l.vendor?.name, l.memo].filter(Boolean).join(" · ")}`}
              </span>
            </TableCell>
            {showAccount && (
              <TableCell className="text-muted-foreground max-md:hidden">
                <span className="font-mono text-xs">{l.account.code}</span> {l.account.name}
              </TableCell>
            )}
            <TableCell className="tabular text-right">{l.debit && l.debit !== "0.00" ? money(l.debit, { currency: false }) : ""}</TableCell>
            <TableCell className="tabular text-right">{l.credit && l.credit !== "0.00" ? money(l.credit, { currency: false }) : ""}</TableCell>
            {running && <TableCell className="tabular text-right font-medium max-sm:hidden">{money(l.running_balance)}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export { calendarDate };
