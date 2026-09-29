"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Alert, Button, Card, Field, Input, PageHeader, SkeletonBlock, useToast } from "@/components/app-ui";
import { AccountSelect, FinancialsGate, calendarDate, type LedgerAccount } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { api, useApi, type ApiError } from "@/lib/api";
import { todayIso } from "@/lib/format";

const EXCLUDED = new Set(["accounts_receivable", "accounts_payable", "payments_to_identify", "transfers_to_classify", "customer_credits", "opening_balance_equity"]);
const eligible = (a: LedgerAccount) => ["asset", "liability", "equity"].includes(a.type) && !EXCLUDED.has(a.system_key ?? "");

function OpeningView() {
  const { can } = useSession();
  const toast = useToast();
  const { data, mutate } = useApi<{ date: string | null; entry_id: string | null; lines: Array<{ account_id: string; amount: string }> }>("/v1/accounting/opening-balances");
  const [date, setDate] = useState("");
  const [rows, setRows] = useState<Array<{ key: number; account_id: string; amount: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (!data) return;
    setDate(data.date ?? todayIso());
    setRows(data.lines.length ? data.lines.map((l, i) => ({ key: i, account_id: l.account_id, amount: l.amount })) : [{ key: 0, account_id: "", amount: "" }]);
  }, [data]);
  if (!data) return <SkeletonBlock height={300} />;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/v1/accounting/opening-balances", { method: "PUT", body: { date, lines: rows.filter((r) => r.account_id && r.amount.trim()).map((r) => ({ account_id: r.account_id, amount: r.amount.trim() })) } });
      toast("success", data.entry_id ? "Opening balances replaced. The previous entry was reversed." : "Opening balances posted.");
      mutate();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Books", href: "/app/accounting" }, { label: "Opening balances" }]}
        title="Opening balances"
        description="Where your books start: what was in the bank, in wallets before Setra began monitoring, owed on loans. Customer and vendor balances come from invoices and bills."
      />
      {data.entry_id && <Alert tone="info">Current opening balances are dated {calendarDate(data.date, { year: true })}. Saving again replaces them: the old entry is reversed, never edited.</Alert>}
      {error && <Alert tone="danger">{error.message}</Alert>}
      <Card padded>
        <Field label="As of" htmlFor="ob-date" hint="Usually the day before your first activity in Setra.">
          <Input id="ob-date" type="date" className="w-[180px]" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </Card>
      <Card title="Balances" description="Positive amounts sit on the account's usual side: money you have, debts you owe.">
        <ul className="divide-y">
          {rows.map((r, i) => (
            <li key={r.key} className="grid gap-3 px-6 py-3 max-md:px-4 md:grid-cols-[minmax(0,1fr)_180px_36px] md:items-center">
              <AccountSelect id={`ob-acct-${i}`} value={r.account_id} onChange={(v) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, account_id: v } : x)))} filter={eligible} />
              <Input inputMode="decimal" className="tabular text-right" placeholder="0.00" aria-label={`Balance ${i + 1}`} value={r.amount} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, amount: e.target.value.replace(/[^\d.-]/g, "") } : x)))} />
              <Button variant="ghost" size="sm" icon={<Trash2 />} aria-label={`Remove balance ${i + 1}`} disabled={rows.length <= 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} />
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3 max-md:px-4">
          <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setRows((rs) => [...rs, { key: Math.max(0, ...rs.map((x) => x.key)) + 1, account_id: "", amount: "" }])}>Add account</Button>
          <span className="text-sm text-muted-foreground">The difference is balanced by Opening Balance Equity.</span>
        </div>
      </Card>
      {can("financials:manage") && (
        <div className="flex justify-end">
          <Button variant="primary" loading={busy} disabled={!date || !rows.some((r) => r.account_id && r.amount.trim())} onClick={save}>
            {data.entry_id ? "Replace opening balances" : "Post opening balances"}
          </Button>
        </div>
      )}
    </div>
  );
}

export default function OpeningBalancesPage() {
  return (
    <FinancialsGate>
      <OpeningView />
    </FinancialsGate>
  );
}
