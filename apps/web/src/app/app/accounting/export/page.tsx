"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Card, ChoiceCard, ChoiceGroup, Field, Input, PageHeader, Select } from "@/components/app-ui";
import { FinancialsGate, presetRange } from "@/components/ledger-components";
import { qs } from "@/lib/api";

const FORMATS = {
  quickbooks: {
    title: "QuickBooks Online",
    body: "Journal entries in the layout QuickBooks imports (Settings → Import data → Journal entries). Accounts are matched by name, so import the chart first or map them there.",
    date: "MM/DD/YYYY"
  },
  xero: {
    title: "Xero",
    body: "Manual journals in Xero's import layout (Accounting → Manual journals → Import). Accounts are matched by code; set the tax rate your Xero region uses.",
    date: "DD/MM/YYYY"
  },
  setra: { title: "Spreadsheet (CSV)", body: "Every posted line with its entry, account, customer and vendor. For your accountant's own tools.", date: "YYYY-MM-DD" }
} as const;

function DownloadLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} download className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs transition-opacity hover:opacity-90">
      <Download className="size-4" aria-hidden="true" />
      {children}
    </a>
  );
}

function ExportView() {
  const ytd = presetRange("ytd");
  const [format, setFormat] = useState<keyof typeof FORMATS>("quickbooks");
  const [from, setFrom] = useState(ytd.from);
  const [to, setTo] = useState(ytd.to);
  const [dateFormat, setDateFormat] = useState<string>(FORMATS.quickbooks.date);
  const [tax, setTax] = useState("Tax Exempt");
  const params = { format, from, to, date_format: dateFormat, tax_rate: format === "xero" ? tax : undefined };
  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Books", href: "/app/accounting" }, { label: "Export for your accountant" }]}
        title="Export for your accountant"
        description="Export the posted journal and chart of accounts in QuickBooks or Xero import layouts. Drafts stay out of the file, and every amount is reported in USD."
      />
      <Card title="Where is it going?">
        <div className="px-6 py-5 max-md:px-4">
          <ChoiceGroup value={format} onChange={(v) => { setFormat(v as keyof typeof FORMATS); setDateFormat(FORMATS[v as keyof typeof FORMATS].date); }} label="Format">
            {(Object.keys(FORMATS) as Array<keyof typeof FORMATS>).map((k) => (
              <ChoiceCard key={k} id={`fmt-${k}`} value={k} selected={format === k} title={FORMATS[k].title} description={FORMATS[k].body} />
            ))}
          </ChoiceGroup>
        </div>
      </Card>
      <Card title="Options" padded>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="From" htmlFor="ex-from"><Input id="ex-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To" htmlFor="ex-to"><Input id="ex-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Date format" htmlFor="ex-df" hint="Match your accounting system's settings."><Select id="ex-df" value={dateFormat} onValueChange={setDateFormat} options={["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"].map((v) => ({ value: v, label: v }))} /></Field>
          {format === "xero" && <Field label="Tax rate" htmlFor="ex-tax" hint="For example Tax Exempt (US), No VAT (UK), BAS Excluded (AU)."><Input id="ex-tax" value={tax} onChange={(e) => setTax(e.target.value)} /></Field>}
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <DownloadLink href={`/api/v1/accounting/exports/journal${qs(params)}`}>Journal entries</DownloadLink>
          <DownloadLink href={`/api/v1/accounting/exports/chart${qs({ format, tax_rate: format === "xero" ? tax : undefined })}`}>Chart of accounts</DownloadLink>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">Year-end closing entries are left out, because QuickBooks and Xero close the year themselves. To give your accountant direct access instead, invite them with the Accountant role in Settings.</p>
      </Card>
    </div>
  );
}

export default function ExportPage() {
  return (
    <FinancialsGate>
      <ExportView />
    </FinancialsGate>
  );
}
