"use client";

import Link from "next/link";
import { ChevronRight, Clock, FileSpreadsheet, Landmark, Scale, TrendingUp, Waves } from "lucide-react";
import { PageHeader } from "@/components/app-ui";
import { FinancialsGate, presetRange } from "@/components/ledger-components";
import { qs, useApi } from "@/lib/api";
import { money } from "@/lib/format";

const REPORTS = [
  { slug: "profit-and-loss", title: "Profit and loss", body: "Revenue, costs and what's left over for a period.", icon: TrendingUp },
  { slug: "balance-sheet", title: "Balance sheet", body: "What the business owns and owes on a date.", icon: Landmark },
  { slug: "cash-flow", title: "Cash flow", body: "Where money came from and went, excluding transfers between your own accounts.", icon: Waves },
  { slug: "receivables", title: "Receivables aging", body: "What customers owe, by how overdue it is.", icon: Clock },
  { slug: "payables", title: "Payables aging", body: "What you owe vendors, by due date.", icon: FileSpreadsheet },
  { slug: "trial-balance", title: "Trial balance", body: "Every account's balance. Debits always equal credits.", icon: Scale }
];

function ReportsView() {
  const month = presetRange("month");
  const { data: pl } = useApi<any>(`/v1/accounting/reports/profit-and-loss${qs(month)}`);
  const { data: bs } = useApi<any>("/v1/accounting/reports/balance-sheet");
  const { data: cf } = useApi<any>(`/v1/accounting/reports/cash-flow${qs(month)}`);
  const { data: ar } = useApi<any>("/v1/accounting/reports/receivables-aging");
  const { data: ap } = useApi<any>("/v1/accounting/reports/payables-aging");
  const { data: tb } = useApi<any>("/v1/accounting/reports/trial-balance");
  const figure: Record<string, [string, string | undefined] | undefined> = {
    "profit-and-loss": ["Net income this month", pl?.net_income],
    "balance-sheet": ["Total assets", bs?.assets.total],
    "cash-flow": ["Net change this month", cf?.net_change],
    receivables: ["Outstanding", ar?.total],
    payables: ["Owed to vendors", ap?.total],
    "trial-balance": ["Total debits", tb?.totals.debit]
  };
  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader title="Reports" description="Financial statements built from posted journal entries. Open any line to inspect the accounts, entries and source records behind the total." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {REPORTS.map(({ slug, title, body, icon: Icon }) => {
          const [label, value] = figure[slug] ?? [];
          return (
            <Link key={slug} href={`/app/reports/${slug}`} className="group grid content-between gap-6 rounded-2xl bg-card p-5 shadow-card transition-[box-shadow,translate] duration-300 hover:-translate-y-0.5 hover:shadow-raised">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="flex items-center gap-1 font-semibold">
                    {title}
                    <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                  </h2>
                  <p className="text-sm text-muted-foreground">{body}</p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="tabular text-xl font-semibold tracking-tight">{value === undefined ? "…" : money(value)}</p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <FinancialsGate>
      <ReportsView />
    </FinancialsGate>
  );
}
