"use client";

import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { Badge, Card, EmptyState, ErrorState, PageHeader, SkeletonRows } from "@/components/app-ui";
import { ExportLink, FinancialsGate, RangePicker, SectionLabel, StatementRow, calendarDate, useRange } from "@/components/ledger-components";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { qs, useApi } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

const META: Record<string, { title: string; api: string; mode: "range" | "as_of"; description: string }> = {
  "profit-and-loss": { title: "Profit and loss", api: "profit-and-loss", mode: "range", description: "Revenue less costs for the period. Refunds reduce revenue; money not yet identified is never counted." },
  "balance-sheet": { title: "Balance sheet", api: "balance-sheet", mode: "as_of", description: "What the business owns, owes, and the owners' stake, on one date." },
  "cash-flow": { title: "Cash flow", api: "cash-flow", mode: "range", description: "Money in and out of your wallets and bank accounts, by purpose. Transfers between your own accounts are shown apart and never counted as income." },
  "trial-balance": { title: "Trial balance", api: "trial-balance", mode: "as_of", description: "Every account with a balance. Total debits always equal total credits." },
  receivables: { title: "Receivables aging", api: "receivables-aging", mode: "as_of", description: "Open invoice balances by how far past due they are." },
  payables: { title: "Payables aging", api: "payables-aging", mode: "as_of", description: "Unpaid approved bills by how far past due they are." }
};

function Check({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return ok ? (
    <Badge tone="success" icon={<CheckCircle2 className="size-3" />} dot={false}>{okText}</Badge>
  ) : (
    <Badge tone="warning" icon={<AlertTriangle className="size-3" />} dot={false}>{badText}</Badge>
  );
}

function ReportView() {
  const { report } = useParams<{ report: string }>();
  const meta = META[report];
  if (!meta) notFound();
  const { preset, from, to } = useRange(meta.mode);
  const query = meta.mode === "range" ? qs({ from, to }) : qs({ as_of: to });
  const path = `/v1/accounting/reports/${meta.api}${query}`;
  const { data, error, mutate } = useApi<any>(path, { keepPreviousData: true });
  const drill = (accountId: string) => `/app/accounting/accounts/${accountId}${qs(meta.mode === "range" ? { preset: preset === "custom" ? "custom" : preset, from: preset === "custom" ? from : undefined, to: preset === "custom" ? to : undefined } : { preset: "all" })}`;
  const period = meta.mode === "range" ? `${calendarDate(from, { year: true })} to ${calendarDate(to, { year: true })}` : `As of ${calendarDate(to, { year: true })}`;

  let body: ReactNode = null;
  let status: ReactNode = null;
  if (data) {
    if (report === "profit-and-loss") {
      const section = (label: string, s: any) =>
        s.accounts.length > 0 && (
          <>
            <SectionLabel>{label}</SectionLabel>
            {s.accounts.map((a: any) => <StatementRow key={a.id} level={1} label={<><span className="mr-2 font-mono text-xs text-muted-foreground">{a.code}</span>{a.name}</>} amount={a.amount} href={drill(a.id)} />)}
            <StatementRow label={`Total ${label.toLowerCase()}`} amount={s.total} strong />
          </>
        );
      body =
        data.revenue.accounts.length + data.operating_expenses.accounts.length + data.cost_of_goods_sold.accounts.length === 0 ? (
          <EmptyState title="Nothing in this period" mascot="resting">No revenue or expenses were posted between these dates.</EmptyState>
        ) : (
          <>
            {section("Revenue", data.revenue)}
            {section("Cost of goods sold", data.cost_of_goods_sold)}
            {data.cost_of_goods_sold.accounts.length > 0 && <StatementRow label="Gross profit" amount={data.gross_profit} total />}
            {section("Operating expenses", data.operating_expenses)}
            <StatementRow label="Net income" amount={data.net_income} total />
          </>
        );
    } else if (report === "balance-sheet") {
      status = <Check ok={data.balanced} okText="Balanced" badText="Out of balance" />;
      const section = (label: string, s: any, extra?: ReactNode) => (
        <>
          <SectionLabel>{label}</SectionLabel>
          {s.accounts.map((a: any) => <StatementRow key={a.id} level={1} label={<><span className="mr-2 font-mono text-xs text-muted-foreground">{a.code}</span>{a.name}</>} amount={a.amount} href={drill(a.id)} />)}
          {extra}
          <StatementRow label={`Total ${label.toLowerCase()}`} amount={s.total} strong />
        </>
      );
      body = (
        <>
          {section("Assets", data.assets)}
          <StatementRow label="Total assets" amount={data.assets.total} total />
          {section("Liabilities", data.liabilities)}
          {section("Equity", data.equity, <StatementRow level={1} label="Earnings not yet closed" hint="Revenue less expenses since the last year-end close" amount={data.equity.current_earnings} href="/app/reports/profit-and-loss?preset=all" />)}
          <StatementRow label="Total liabilities and equity" amount={data.liabilities_and_equity} total />
        </>
      );
    } else if (report === "cash-flow") {
      status = <Check ok={data.reconciles} okText="Reconciles to cash balances" badText="Doesn't reconcile" />;
      body = (
        <>
          <StatementRow label="Opening cash" amount={data.opening_balance} strong />
          <SectionLabel>Operating</SectionLabel>
          {data.operating.lines.length === 0 ? <StatementRow level={1} label="No operating cash movement" amount="0.00" muted /> : data.operating.lines.map((l: any) => <StatementRow key={l.category} level={1} label={l.label} amount={l.amount} />)}
          <StatementRow label="Net cash from operations" amount={data.operating.total} strong />
          {data.financing.lines.length > 0 && (
            <>
              <SectionLabel>Financing</SectionLabel>
              {data.financing.lines.map((l: any) => <StatementRow key={l.category} level={1} label={l.label} amount={l.amount} />)}
              <StatementRow label="Net cash from financing" amount={data.financing.total} strong />
            </>
          )}
          <SectionLabel>Between your own accounts</SectionLabel>
          <StatementRow level={1} label="Internal transfers" hint={data.internal_transfers.note} amount={data.internal_transfers.net} muted />
          <StatementRow label="Net change in cash" amount={data.net_change} total />
          <StatementRow label="Closing cash" amount={data.closing_balance} strong />
        </>
      );
    } else if (report === "trial-balance") {
      status = <Check ok={data.totals.balanced} okText="Debits equal credits" badText="Out of balance" />;
      body = (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[80px]">Code</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.accounts.map((a: any) => (
              <TableRow key={a.id}>
                <TableCell className="font-mono text-sm text-muted-foreground">{a.code}</TableCell>
                <TableCell><Link href={drill(a.id)} className="font-medium hover:underline">{a.name}</Link></TableCell>
                <TableCell className="tabular text-right">{a.debit_balance !== "0.00" ? money(a.debit_balance, { currency: false }) : ""}</TableCell>
                <TableCell className="tabular text-right">{a.credit_balance !== "0.00" ? money(a.credit_balance, { currency: false }) : ""}</TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
              <TableCell />
              <TableCell>Total</TableCell>
              <TableCell className="tabular text-right">{money(data.totals.debit)}</TableCell>
              <TableCell className="tabular text-right">{money(data.totals.credit)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
    } else {
      const receivable = report === "receivables";
      const parties = receivable ? data.customers : data.vendors;
      const docs = receivable ? data.invoices : data.bills;
      if (data.ledger_check) status = <Check ok={data.ledger_check.matches} okText={`Matches ${receivable ? "Accounts Receivable" : "Accounts Payable"}`} badText={`Ledger shows ${money(data.ledger_check.account_balance)}`} />;
      body =
        docs.length === 0 ? (
          <EmptyState title={receivable ? "Nobody owes you anything" : "Nothing owed to vendors"} mascot="success">{receivable ? "Every invoice is paid, written off or cancelled." : "Every approved bill is paid."}</EmptyState>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-3 xl:grid-cols-5">
              {data.buckets.map((b: any) => (
                <div key={b.key} className="min-w-0 bg-card px-5 py-3.5 max-sm:px-4">
                  <p className="text-xs text-muted-foreground">{b.label === "Current" ? "Not yet due" : b.label}</p>
                  <p className={cn("tabular text-lg font-semibold", b.key !== "current" && b.amount !== "0.00" && "text-warning")}>{money(b.amount)}</p>
                </div>
              ))}
            </div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{receivable ? "Customer" : "Vendor"}</TableHead>
                  {data.buckets.map((b: any) => <TableHead key={b.key} className="text-right max-lg:hidden">{b.label === "Current" ? "Not due" : b.label}</TableHead>)}
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parties.map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell><Link href={receivable ? `/app/customers/${p.id}` : `/app/vendors/${p.id}`} className="font-medium hover:underline">{p.name}</Link></TableCell>
                    {data.buckets.map((b: any) => <TableCell key={b.key} className="tabular text-right max-lg:hidden">{p.buckets[b.key] !== "0.00" ? money(p.buckets[b.key], { currency: false }) : ""}</TableCell>)}
                    <TableCell className="tabular text-right font-semibold">{money(p.total)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
                  <TableCell>Total</TableCell>
                  {data.buckets.map((b: any) => <TableCell key={b.key} className="tabular text-right max-lg:hidden">{money(b.amount, { currency: false })}</TableCell>)}
                  <TableCell className="tabular text-right">{money(data.total)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <SectionLabel>{receivable ? "Open invoices" : "Unpaid bills"}</SectionLabel>
            <ul className="divide-y">
              {docs.map((d: any) => (
                <li key={d.id}>
                  <Link href={receivable ? `/app/invoices/${d.id}` : `/app/bills/${d.id}`} className="flex items-center gap-4 px-6 py-2.5 transition-colors hover:bg-accent/50 max-md:px-4">
                    <span className="w-24 shrink-0 font-mono text-sm">{d.number}</span>
                    <span className="min-w-0 flex-1 truncate">{(d.customer ?? d.vendor)?.name ?? "Unknown"} <span className="text-muted-foreground">· {d.title}</span></span>
                    <span className="hidden text-sm text-muted-foreground sm:inline">{d.due_date ?? d.due_at ? `Due ${calendarDate(d.due_date ?? d.due_at)}` : "No due date"}</span>
                    <span className={cn("tabular w-28 text-right font-semibold", d.bucket !== "current" && "text-warning")}>{money(d.remaining)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        );
    }
  }

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader breadcrumbs={[{ label: "Reports", href: "/app/reports" }, { label: meta.title }]} title={meta.title} description={meta.description} actions={<ExportLink path={path} />} />
      <Card
        title={<span className="flex flex-wrap items-center gap-3">{period}{status}</span>}
        actions={<RangePicker mode={meta.mode} />}
      >
        {error ? <ErrorState error={error} retry={() => mutate()} /> : !data ? <SkeletonRows rows={10} cols={2} /> : <div className="pb-1">{body}</div>}
      </Card>
    </div>
  );
}

export default function ReportPage() {
  return (
    <FinancialsGate>
      <Suspense>
        <ReportView />
      </Suspense>
    </FinancialsGate>
  );
}
