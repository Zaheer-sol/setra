"use client";

import { Attachments } from "@/components/attachments";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCheck, RotateCcw, Send, Trash2 } from "lucide-react";
import { Alert, Button, Card, ErrorState, KV, PageHeader, SkeletonBlock, TextLink, Timeline } from "@/components/app-ui";
import { EntryStatus, FinancialsGate, ReasonModal, TxProof, calendarDate, useAction } from "@/components/ledger-components";
import { useSession } from "@/components/session";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, useApi } from "@/lib/api";
import { dateTime, money, timeAgo } from "@/lib/format";

const ACTION_LABEL: Record<string, string> = {
  journal_entry_created: "Drafted",
  journal_entry_updated: "Edited",
  journal_entry_approved: "Approved",
  journal_entry_posted: "Posted",
  journal_entry_voided: "Discarded",
  journal_entry_reversed: "Reversed"
};

function EntryView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useSession();
  const { data: e, error, mutate } = useApi<any>(`/v1/accounting/journal-entries/${id}`);
  const { busy, run } = useAction();
  const [modal, setModal] = useState<"void" | "reverse" | "unclassify" | null>(null);

  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!e) return <SkeletonBlock height={420} />;
  const editable = ["draft", "approved"].includes(e.status);

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Books", href: "/app/accounting" }, { label: "Journal", href: "/app/accounting/journal" }, { label: e.number }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {e.number}
            <EntryStatus status={e.status} />
          </span>
        }
        description={e.description}
        actions={
          <>
            {e.status === "draft" && can("financials:approve") && (
              <Button icon={<CheckCheck />} loading={busy === "approve"} onClick={() => run("approve", `/v1/accounting/journal-entries/${id}/approve`, undefined, "Entry approved.", () => mutate())}>
                Approve
              </Button>
            )}
            {editable && can("financials:approve") && (
              <Button variant="primary" icon={<Send />} loading={busy === "post"} onClick={() => run("post", `/v1/accounting/journal-entries/${id}/post`, undefined, `${e.number} posted.`, () => mutate())}>
                Post
              </Button>
            )}
            {editable && can("financials:write") && (
              <Button variant="ghost" icon={<Trash2 />} onClick={() => setModal("void")}>
                Discard
              </Button>
            )}
            {e.source.type === "classification" && e.status === "posted" && !e.reversed_by && can("financials:approve") && (
              <Button icon={<RotateCcw />} onClick={() => setModal("unclassify")}>
                Undo classification
              </Button>
            )}
            {e.status === "posted" && !e.reversed_by && e.source.type !== "classification" && can("financials:approve") && (
              <Button icon={<RotateCcw />} onClick={() => setModal("reverse")}>
                Reverse
              </Button>
            )}
          </>
        }
      />

      {e.status === "posted" && (
        <Alert tone="neutral">
          Posted entries never change. {e.reversed_by ? <>This entry was reversed by <TextLink href={`/app/accounting/journal/${e.reversed_by.id}`} mono>{e.reversed_by.number}</TextLink>.</> : "To correct it, reverse it and post the right entry."}
        </Alert>
      )}
      {e.reverses && (
        <Alert tone="info">
          This entry reverses <TextLink href={`/app/accounting/journal/${e.reverses.id}`} mono>{e.reverses.number}</TextLink>.
        </Alert>
      )}
      {e.original_date && e.original_date !== e.date && (
        <Alert tone="info">Dated {calendarDate(e.date)} because {calendarDate(e.original_date)} falls in a closed period. The original date is kept here.</Alert>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px] [&>*]:min-w-0">
        <Card title="Lines" description={e.totals.balanced ? `Debits and credits both total ${money(e.totals.debit)}.` : `Unbalanced: debits ${money(e.totals.debit)}, credits ${money(e.totals.credit)}.`}>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Account</TableHead>
                <TableHead className="max-lg:hidden">Details</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {e.lines.map((l: any) => (
                <TableRow key={l.id} className="align-top hover:bg-transparent">
                  <TableCell>
                    <Link href={`/app/accounting/accounts/${l.account.id}`} className="font-medium hover:underline">
                      <span className="mr-2 font-mono text-xs text-muted-foreground">{l.account.code}</span>
                      {l.account.name}
                    </Link>
                    {l.memo && <span className="block text-xs text-muted-foreground">{l.memo}</span>}
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs lg:hidden">
                      {(l.customer || l.vendor) && <span className="text-muted-foreground">{(l.customer ?? l.vendor).name}</span>}
                      {l.invoice && <TextLink href={`/app/invoices/${l.invoice.id}`} mono>{l.invoice.number}</TextLink>}
                      {l.bill && <TextLink href={`/app/bills/${l.bill.id}`} mono>{l.bill.number}</TextLink>}
                      {l.payment && <TxProof hash={l.payment.transaction_hash} url={l.payment.explorer_url} simulated={l.payment.simulated} />}
                      {l.outgoing_transfer && <TxProof hash={l.outgoing_transfer.transaction_hash} url={l.outgoing_transfer.explorer_url} />}
                    </span>
                  </TableCell>
                  <TableCell className="max-lg:hidden">
                    <div className="grid gap-0.5 text-sm">
                      {l.customer && <TextLink href={`/app/customers/${l.customer.id}`}>{l.customer.name}</TextLink>}
                      {l.vendor && <TextLink href={`/app/vendors/${l.vendor.id}`}>{l.vendor.name}</TextLink>}
                      {l.invoice && <TextLink href={`/app/invoices/${l.invoice.id}`} mono>{l.invoice.number}</TextLink>}
                      {l.bill && <TextLink href={`/app/bills/${l.bill.id}`} mono>Bill {l.bill.number}</TextLink>}
                      {l.payment && (
                        <span className="flex flex-wrap items-center gap-2">
                          <TextLink href={`/app/payments/${l.payment.id}`}>Payment</TextLink>
                          <TxProof hash={l.payment.transaction_hash} url={l.payment.explorer_url} simulated={l.payment.simulated} />
                        </span>
                      )}
                      {l.outgoing_transfer && (
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-muted-foreground">Sent</span>
                          <TxProof hash={l.outgoing_transfer.transaction_hash} url={l.outgoing_transfer.explorer_url} />
                        </span>
                      )}
                      {l.asset && <span className="text-xs text-muted-foreground">Valued at {l.asset.rate_source.replace("peg:", "1:1 peg to ")}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="tabular text-right">{l.debit ? money(l.debit, { currency: false }) : ""}</TableCell>
                  <TableCell className="tabular text-right">{l.credit ? money(l.credit, { currency: false }) : ""}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
                <TableCell colSpan={2} className="max-lg:hidden">Total</TableCell>
                <TableCell className="lg:hidden">Total</TableCell>
                <TableCell className="tabular text-right">{money(e.totals.debit, { currency: false })}</TableCell>
                <TableCell className="tabular text-right">{money(e.totals.credit, { currency: false })}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>

        <div className="grid gap-6 [&>*]:min-w-0">
          <Card title="Details" padded>
            <KV
              items={[
                ["Date", calendarDate(e.date, { year: true })],
                ["Source", e.source.link ? <TextLink key="s" href={e.source.link}>{e.source.label}</TextLink> : e.source.label],
                e.memo && ["Memo", e.memo],
                ["Created by", e.created_by ?? "Setra (automatic)"],
                e.approved_by && ["Approved by", e.approved_by],
                e.posted_at && ["Posted", <span key="p" title={dateTime(e.posted_at)}>{timeAgo(e.posted_at)}{e.posted_by ? ` by ${e.posted_by}` : ""}</span>],
                e.void_reason && ["Discarded because", e.void_reason]
              ]}
            />
          </Card>
          <Attachments objectType="journal_entry" objectId={e.id} title="Supporting documents" />
          {e.history.length > 0 && (
            <Card title="History" padded>
              <Timeline items={e.history.map((h: any) => ({ title: ACTION_LABEL[h.action] ?? h.action, meta: h.actor_label ?? "Setra", time: timeAgo(h.created_at), timeTitle: dateTime(h.created_at) }))} />
            </Card>
          )}
        </div>
      </div>

      <ReasonModal
        open={modal === "void"}
        onClose={() => setModal(null)}
        title={`Discard ${e.number}?`}
        description="It stays on record as discarded and is never posted."
        confirmLabel="Discard entry"
        danger
        onConfirm={async (reason) => {
          await api(`/v1/accounting/journal-entries/${id}/void`, { method: "POST", body: { reason } });
          mutate();
        }}
      />
      <ReasonModal
        open={modal === "unclassify"}
        onClose={() => setModal(null)}
        title="Undo this classification?"
        description="The entry is reversed and the money goes back to its holding account, ready to classify again."
        confirmLabel="Undo classification"
        onConfirm={async (reason) => {
          await api(`/v1/accounting/classifications/${e.source.id}/undo`, { method: "POST", body: { reason } });
          router.push("/app/accounting/classify");
        }}
      />
      <ReasonModal
        open={modal === "reverse"}
        onClose={() => setModal(null)}
        title={`Reverse ${e.number}?`}
        description="Setra posts a new entry with every debit and credit swapped, dated today. The original stays exactly as it is."
        confirmLabel="Post reversal"
        onConfirm={async (reason) => {
          const r = await api<{ id: string }>(`/v1/accounting/journal-entries/${id}/reverse`, { method: "POST", body: { reason } });
          router.push(`/app/accounting/journal/${r.id}`);
        }}
      />
    </div>
  );
}

export default function EntryPage() {
  return (
    <FinancialsGate>
      <EntryView />
    </FinancialsGate>
  );
}
