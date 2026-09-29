"use client";

import Link from "next/link";
import { useState } from "react";
import { RefreshCw, ScanSearch } from "lucide-react";
import { Badge, Button, Card } from "@/components/app-ui";
import { useApi } from "@/lib/api";
import { timeAgo } from "@/lib/format";

const KIND_LABEL: Record<string, string> = { exchange: "Exchange", bridge: "Bridge", fund: "Fund or treasury", contract: "Smart contract", protocol: "DeFi protocol", wallet: "Labelled wallet", unknown: "No public labels" };

/**
 * "Who sent this?": public labels for the sender of an unidentified payment, from Nansen, with a
 * plain explanation and a suggested next step. A hint for a person, never an automatic match.
 */
export function CounterpartyInsight({ paymentId, compact = false }: { paymentId: string; compact?: boolean }) {
  const [asked, setAsked] = useState(!compact);
  const [refresh, setRefresh] = useState(0);
  const { data, isValidating } = useApi<any>(asked ? `/v1/payments/${paymentId}/counterparty${refresh ? "?refresh=true" : ""}` : null, { revalidateOnFocus: false });

  if (compact && !asked) {
    return (
      <Button size="sm" variant="ghost" icon={<ScanSearch />} onClick={() => setAsked(true)}>
        Who sent this?
      </Button>
    );
  }
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
      <p className="text-muted-foreground"><span className="font-medium text-foreground">Suggested:</span> {data.suggestion}</p>
      <p className="text-xs text-muted-foreground">
        Public labels from Nansen{data.mainnetLabelsForTestnet ? " for this address on Monad mainnet" : ""} · {timeAgo(data.fetchedAt)} · a clue, not a match
      </p>
    </div>
  );
  if (compact) return <div className="mt-2 rounded-xl border bg-muted/30 px-4 py-3">{body}</div>;
  return (
    <Card
      title="Who sent this?"
      description="What's publicly known about the sending wallet."
      actions={data && (data.status === "ok" || data.status === "none" || data.status === "error") ? <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={isValidating} onClick={() => setRefresh((r) => r + 1)} aria-label="Look up again">Refresh</Button> : undefined}
    >
      <div className="px-6 py-4 max-md:px-4">{body}</div>
    </Card>
  );
}
