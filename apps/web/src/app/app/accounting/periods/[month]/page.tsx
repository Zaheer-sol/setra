"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Lock, XCircle } from "lucide-react";
import { Alert, Badge, Button, Card, ErrorState, Metric, Metrics, Modal, PageHeader, SkeletonBlock, useToast } from "@/components/app-ui";
import { FinancialsGate } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { api, useApi, type ApiError } from "@/lib/api";
import { money, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

type Check = { key: string; label: string; status: "ok" | "attention" | "blocking"; detail: string; link?: string };
type Summary = {
  month: string;
  end_date: string;
  as_of: string;
  ended: boolean;
  status: string;
  closed_at: string | null;
  closed_by: string | null;
  can_close: boolean;
  needs_attention: number;
  summary: {
    revenue: string;
    expenses: string;
    net_income: string;
    stablecoin_received: Array<{ asset: string; amount: string; count: number }>;
    stablecoin_paid_out: Array<{ asset: string; amount: string; count: number }>;
    cash_closing: string;
    receivables: string;
    payables: string;
    unidentified_receipts: { count: number; amount: string };
    unclassified_transfers: { count: number; amount: string };
    open_exceptions: number;
  };
  checks: Check[];
};

const monthLabel = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

const ICON = {
  ok: <CheckCircle2 className="size-5 shrink-0 text-success" aria-label="Done" />,
  attention: <AlertTriangle className="size-5 shrink-0 text-warning" aria-label="Needs attention" />,
  blocking: <XCircle className="size-5 shrink-0 text-destructive" aria-label="Blocks closing" />
};

function MonthView() {
  const { month } = useParams<{ month: string }>();
  const { can } = useSession();
  const toast = useToast();
  const { data, error, mutate } = useApi<Summary>(`/v1/accounting/periods/${month}/summary`);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = monthLabel(month);

  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!data) return <SkeletonBlock height={420} />;
  const s = data.summary;
  const moved = (rows: Summary["summary"]["stablecoin_received"]) => (rows.length ? rows.map((r) => `${money(r.amount, { currency: false })} ${r.asset}`).join(" · ") : "None");
  const close = async () => {
    setBusy(true);
    try {
      await api("/v1/accounting/periods/close", { method: "POST", body: { month } });
      toast("success", `${label} is closed. Nothing more can be posted into it.`);
      setConfirm(false);
      mutate();
    } catch (e) {
      toast("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Books", href: "/app/accounting" }, { label }]}
        title={label}
        description={data.ended ? `The month's results and whether the books can be trusted, as of ${data.end_date}.` : `So far this month, as of ${data.as_of}. A month can be closed after it ends.`}
        actions={
          data.status === "closed" ? (
            <Badge tone="neutral" icon={<Lock className="size-3" />} dot={false}>Closed</Badge>
          ) : can("financials:manage") && data.ended ? (
            <Button variant="primary" icon={<Lock />} disabled={!data.can_close} onClick={() => (data.needs_attention ? setConfirm(true) : close())} loading={busy && !confirm}>
              Close {label}
            </Button>
          ) : !data.ended ? (
            <Badge tone="info">Current month</Badge>
          ) : null
        }
      />
      {data.status === "closed" && (
        <Alert tone="neutral" title={`Closed${data.closed_by ? ` by ${data.closed_by}` : ""}${data.closed_at ? ` ${timeAgo(data.closed_at)}` : ""}`}>
          Nothing more can be posted into this month. Late activity lands in the next open month. To adjust it, reopen it from the Books page with a reason.
        </Alert>
      )}

      <Metrics label="Results">
        <Metric label="Revenue" value={s.revenue} money href={`/app/reports/profit-and-loss?from=${month}-01&to=${data.as_of}`} />
        <Metric label="Expenses" value={s.expenses} money />
        <Metric label="Net income" value={s.net_income} money warn={s.net_income.startsWith("-")} />
        <Metric label="Cash at the end of the month" value={s.cash_closing} money foot="Wallets and bank, from the ledger" />
      </Metrics>

      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card title="Money that moved" description="Stablecoin in and out of your wallets this month. This isn't the same as revenue and expenses: transfers between your own wallets, loans and money still unidentified are part of it.">
          <dl className="grid gap-3 px-6 py-5 text-sm max-md:px-4">
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Received</dt><dd className="tabular text-right font-medium">{moved(s.stablecoin_received)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Sent</dt><dd className="tabular text-right font-medium">{moved(s.stablecoin_paid_out)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Received, not identified</dt><dd className="tabular text-right font-medium">{s.unidentified_receipts.count ? `${s.unidentified_receipts.count} · ${money(s.unidentified_receipts.amount)}` : "None"}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Sent, not classified</dt><dd className="tabular text-right font-medium">{s.unclassified_transfers.count ? `${s.unclassified_transfers.count} · ${money(s.unclassified_transfers.amount)}` : "None"}</dd></div>
          </dl>
        </Card>
        <Card title="Owed at the end of the month">
          <dl className="grid gap-3 px-6 py-5 text-sm max-md:px-4">
            <div className="flex justify-between gap-4"><dt><Link href="/app/reports/receivables-aging" className="text-primary hover:underline">Customers owe you</Link></dt><dd className="tabular font-medium">{money(s.receivables)}</dd></div>
            <div className="flex justify-between gap-4"><dt><Link href="/app/reports/payables-aging" className="text-primary hover:underline">You owe vendors</Link></dt><dd className="tabular font-medium">{money(s.payables)}</dd></div>
            <div className="flex justify-between gap-4"><dt><Link href="/app/exceptions" className="text-primary hover:underline">Payments waiting for review</Link></dt><dd className="tabular font-medium">{s.open_exceptions}</dd></div>
          </dl>
        </Card>
      </div>

      <Card
        title="Before you close"
        description={
          data.checks.every((c) => c.status === "ok")
            ? "Everything checks out. These numbers come from posted entries and match the records behind them."
            : "What still needs a decision before this month's numbers can be trusted. Anything marked in red stops the month from closing."
        }
      >
        <ul className="divide-y">
          {data.checks.map((c) => (
            <li key={c.key}>
              {c.link && c.status !== "ok" ? (
                <Link href={c.link} className="flex items-start gap-3 px-6 py-3.5 transition-colors hover:bg-accent/50 max-md:px-4">
                  <CheckRow check={c} />
                  <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              ) : (
                <div className="flex items-start gap-3 px-6 py-3.5 max-md:px-4">
                  <CheckRow check={c} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Close ${label} with ${data.needs_attention} item${data.needs_attention === 1 ? "" : "s"} still open?`}
        description="Closing stops anything more being posted into this month. Items you resolve later are recorded in the next open month."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Review them first</Button>
            <Button variant="primary" icon={<Lock />} loading={busy} onClick={close}>Close anyway</Button>
          </>
        }
      >
        <ul className="grid gap-1.5 text-sm">
          {data.checks
            .filter((c) => c.status === "attention")
            .map((c) => (
              <li key={c.key} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />{c.detail}</li>
            ))}
        </ul>
      </Modal>
    </div>
  );
}

function CheckRow({ check }: { check: Check }) {
  return (
    <>
      {ICON[check.status]}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className={cn("font-medium", check.status === "blocking" && "text-destructive")}>{check.label}</span>
        <span className="text-sm text-muted-foreground">{check.detail}</span>
      </span>
    </>
  );
}

export default function MonthPage() {
  return (
    <FinancialsGate>
      <MonthView />
    </FinancialsGate>
  );
}
