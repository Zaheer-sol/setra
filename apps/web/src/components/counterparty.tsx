"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RefreshCw, ScanSearch } from "lucide-react";
import { Alert, Badge, Button, Card } from "@/components/app-ui";
import { useApi } from "@/lib/api";
import { timeAgo } from "@/lib/format";

const KIND_LABEL: Record<string, string> = { exchange: "Exchange", bridge: "Bridge", fund: "Fund or treasury", contract: "Smart contract", protocol: "DeFi protocol", wallet: "Labelled wallet", unknown: "No public labels" };

type Subject = { paymentId: string; outgoingId?: never } | { outgoingId: string; paymentId?: never };

/**
 * "Who sent this?" / "Who received this?": public labels for the other side of a transfer, from Nansen,
 * with a plain explanation, the known customers that wallet has dealt with, and a suggested next step.
 * A hint for a person, never an automatic match.
 */
export function CounterpartyInsight({ compact = false, ...subject }: Subject & { compact?: boolean }) {
  const outgoing = "outgoingId" in subject && !!subject.outgoingId;
  const [asked, setAsked] = useState(!compact);
  const [refresh, setRefresh] = useState(0);
  const base = outgoing ? `/v1/outgoing-transfers/${subject.outgoingId}/counterparty` : `/v1/payments/${subject.paymentId}/counterparty`;
  const { data, isValidating } = useApi<any>(asked ? `${base}${refresh ? "?refresh=true" : ""}` : null, { revalidateOnFocus: false });
  const question = outgoing ? "Who received this?" : "Who sent this?";

  if (compact && !asked) {
    return (
      <Button size="sm" variant="ghost" icon={<ScanSearch />} onClick={() => setAsked(true)}>
        {question}
      </Button>
    );
  }
  const related: any[] = data?.related_customers ?? [];
  const body = !data ? (
    <p className="text-sm text-muted-foreground">Looking up this wallet…</p>
  ) : data.status === "disabled" ? (
    <p className="text-sm text-muted-foreground">
      Counterparty lookups are off. <Link href="/app/settings" className="font-medium text-primary hover:underline">Turn them on in Settings</Link> to see who's behind unknown wallets.
    </p>
  ) : data.status === "not_configured" || data.status === "unsupported_chain" || data.status === "error" ? (
    <p className="text-sm text-muted-foreground">{data.message}</p>
  ) : (
    <div className="grid gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={data.kind === "exchange" ? "info" : data.kind === "unknown" ? "neutral" : "accent"} dot={false}>
          {KIND_LABEL[data.kind] ?? data.kind}
        </Badge>
        {data.labels.slice(0, 4).map((l: any) => (
          <span key={l.label} className="rounded-full bg-muted px-2 py-0.5 text-xs">{l.label}</span>
        ))}
      </div>
      <p>{data.summary}</p>
      {related.length > 0 && (
        <div className="rounded-lg bg-muted/50 px-3 py-2">
          <p className="font-medium">Known customers this wallet has dealt with</p>
          <ul className="mt-1 grid gap-0.5">
            {related.map((c) => (
              <li key={c.customer_id}>
                <Link href={`/app/customers/${c.customer_id}`} className="font-medium text-primary hover:underline">{c.customer_name}</Link>
                <span className="text-muted-foreground">
                  {" "}· {c.interactions} transfer{c.interactions === 1 ? "" : "s"} with their saved wallet
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">Start with {related[0].customer_name}&rsquo;s open invoices.</p>
        </div>
      )}
      <p className="text-muted-foreground"><span className="font-medium text-foreground">Suggested:</span> {data.suggestion}</p>
      <p className="text-xs text-muted-foreground">
        Public data from Nansen{data.mainnetLabelsForTestnet ? " for this address on Monad mainnet" : ""}
        {related.length > 0 && data.related_lookback_days ? `, transfers over the last ${Math.round(data.related_lookback_days / 30)} months` : ""} · {timeAgo(data.fetchedAt)} · a clue, not a match
      </p>
    </div>
  );
  if (compact) return <div className="mt-2 rounded-xl border bg-muted/30 px-4 py-3">{body}</div>;
  return (
    <Card
      title={question}
      description={outgoing ? "What's publicly known about the receiving wallet." : "What's publicly known about the sending wallet."}
      actions={data && (data.status === "ok" || data.status === "none" || data.status === "error") ? <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={isValidating} onClick={() => setRefresh((r) => r + 1)} aria-label="Look up again">Refresh</Button> : undefined}
    >
      <div className="px-6 py-4 max-md:px-4">{body}</div>
    </Card>
  );
}

/** Wait until the person stops typing before looking an address up. */
function useSettled(value: string, ms = 500) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * Under a wallet-address field: warns when the address is a shared one (an exchange, bridge or app).
 * Saving it to one customer or vendor would tie other people's money to that record. Shows nothing when
 * lookups are off, unavailable, or the address is a private wallet.
 */
export function AddressCheck({ address, network = "monad" }: { address: string; network?: string }) {
  const settled = useSettled(address.trim().toLowerCase());
  const valid = /^0x[0-9a-f]{40}$/.test(settled);
  const { data } = useApi<any>(valid ? `/v1/counterparty/address?address=${settled}&network=${network}` : null, { revalidateOnFocus: false });
  if (!valid || !data?.shared || data.address !== settled) return null;
  return (
    <Alert tone="warning" title="This looks like a shared address">
      {data.warning} <span className="text-muted-foreground">Public labels from Nansen. You can still save it.</span>
    </Alert>
  );
}

/** The sending wallet's reading, for decisions such as whether to remember it for a customer. */
export function useSenderIntel(paymentId: string | undefined) {
  const { data } = useApi<any>(paymentId ? `/v1/payments/${paymentId}/counterparty?cached_only=true` : null, { revalidateOnFocus: false });
  const shared = !!data && (data.status === "ok" || data.status === "none") && ["exchange", "bridge", "contract", "protocol"].includes(data.kind);
  return { shared, labels: (data?.labels ?? []) as Array<{ label: string }> };
}
