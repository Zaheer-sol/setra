"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { CheckCircle2, Plus, Trash2 } from "lucide-react";
import { Alert, Button, Card, Field, Input, PageHeader, Textarea, useToast } from "@/components/app-ui";
import { AccountSelect, FinancialsGate } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { api, newIdempotencyKey, type ApiError } from "@/lib/api";
import { money, todayIso } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Line {
  key: number;
  account_id: string;
  debit: string;
  credit: string;
  memo: string;
}

const cents = (v: string) => (/^\d+(\.\d{0,6})?$/.test(v.trim()) ? Math.round(Number(v) * 100) : 0);
const blank = (key: number): Line => ({ key, account_id: "", debit: "", credit: "", memo: "" });

function NewEntryView() {
  const router = useRouter();
  const toast = useToast();
  const { can } = useSession();
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([blank(1), blank(2)]);
  const [busy, setBusy] = useState<"draft" | "post" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [key] = useState(newIdempotencyKey);

  const totals = useMemo(() => {
    const d = lines.reduce((s, l) => s + cents(l.debit), 0);
    const c = lines.reduce((s, l) => s + cents(l.credit), 0);
    return { d, c, diff: d - c };
  }, [lines]);
  const filled = lines.filter((l) => l.account_id && (cents(l.debit) > 0 || cents(l.credit) > 0));
  const balanced = totals.d > 0 && totals.diff === 0 && filled.length >= 2 && filled.length === lines.filter((l) => l.account_id || l.debit || l.credit).length;
  const update = (k: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const fmt = (c: number) => money((c / 100).toFixed(2));

  const save = async (post: boolean) => {
    setBusy(post ? "post" : "draft");
    setError(null);
    try {
      const e = await api<{ id: string; number: string }>("/v1/accounting/journal-entries", {
        method: "POST",
        idempotencyKey: `${key}-${post ? "post" : "draft"}`,
        body: {
          date,
          description,
          memo: memo || null,
          post,
          lines: filled.map((l) => ({ account_id: l.account_id, debit: cents(l.debit) > 0 ? l.debit.trim() : undefined, credit: cents(l.credit) > 0 ? l.credit.trim() : undefined, memo: l.memo || undefined }))
        }
      });
      toast("success", post ? `${e.number} posted.` : `${e.number} saved as a draft.`);
      router.push(`/app/accounting/journal/${e.id}`);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Books", href: "/app/accounting" }, { label: "Journal", href: "/app/accounting/journal" }, { label: "New entry" }]}
        title="New journal entry"
        description="For things Setra can't see on its own: opening balances, owner contributions, bank activity, accruals and corrections. Debits must equal credits."
      />
      {error && <Alert tone="danger">{error.message}</Alert>}
      <Card padded>
        <div className="grid gap-4 md:grid-cols-[180px_1fr]">
          <Field label="Date" htmlFor="je-date">
            <Input id="je-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Description" htmlFor="je-desc">
            <Input id="je-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Opening balance of the business bank account" />
          </Field>
        </div>
      </Card>
      <Card title="Lines">
        <div className="hidden grid-cols-[minmax(0,1.6fr)_130px_130px_minmax(0,1fr)_36px] gap-3 border-b px-6 py-2 text-xs font-semibold text-muted-foreground md:grid">
          <span>Account</span>
          <span className="text-right">Debit</span>
          <span className="text-right">Credit</span>
          <span>Memo</span>
          <span />
        </div>
        <ul className="divide-y">
          {lines.map((l, i) => (
            <li key={l.key} className="grid gap-3 px-6 py-3 max-md:px-4 md:grid-cols-[minmax(0,1.6fr)_130px_130px_minmax(0,1fr)_36px] md:items-center">
              <AccountSelect value={l.account_id} onChange={(v) => update(l.key, { account_id: v })} id={`line-${i}-account`} />
              <Input inputMode="decimal" className="tabular text-right" placeholder="Debit" aria-label={`Line ${i + 1} debit`} value={l.debit} onChange={(e) => update(l.key, { debit: e.target.value.replace(/[^\d.]/g, ""), credit: e.target.value ? "" : l.credit })} />
              <Input inputMode="decimal" className="tabular text-right" placeholder="Credit" aria-label={`Line ${i + 1} credit`} value={l.credit} onChange={(e) => update(l.key, { credit: e.target.value.replace(/[^\d.]/g, ""), debit: e.target.value ? "" : l.debit })} />
              <Input placeholder="Memo" aria-label={`Line ${i + 1} memo`} value={l.memo} onChange={(e) => update(l.key, { memo: e.target.value })} />
              <Button variant="ghost" size="sm" aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} icon={<Trash2 />} />
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3 max-md:px-4">
          <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setLines((ls) => [...ls, blank(Math.max(...ls.map((x) => x.key)) + 1)])}>
            Add line
          </Button>
          <div className="tabular flex flex-wrap items-center gap-5 text-sm">
            <span>Debits <strong>{fmt(totals.d)}</strong></span>
            <span>Credits <strong>{fmt(totals.c)}</strong></span>
            <span className={cn("flex items-center gap-1.5 font-semibold", balanced ? "text-success" : totals.diff !== 0 ? "text-warning" : "text-muted-foreground")}>
              {balanced ? <><CheckCircle2 className="size-4" aria-hidden="true" /> Balanced</> : totals.diff !== 0 ? `Off by ${fmt(Math.abs(totals.diff))}` : "Enter amounts"}
            </span>
          </div>
        </div>
      </Card>
      <Card padded>
        <Field label="Memo" htmlFor="je-memo" optional hint="Why this entry is needed. Kept with the entry forever.">
          <Textarea id="je-memo" rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </Field>
      </Card>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
        <Button loading={busy === "draft"} disabled={!description.trim() || filled.length < 2} onClick={() => save(false)}>
          Save draft
        </Button>
        {can("financials:approve") && (
          <Button variant="primary" loading={busy === "post"} disabled={!description.trim() || !balanced} onClick={() => save(true)}>
            Post entry
          </Button>
        )}
      </div>
    </div>
  );
}

export default function NewEntryPage() {
  return (
    <FinancialsGate>
      <NewEntryView />
    </FinancialsGate>
  );
}
