"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { PaymentsTable, SyncBadge } from "@/components/payment-tables";
import { useSession } from "@/components/session";
import { Address, Alert, Button, Card, CardBody, Chain, CopyButton, DetailGrid, ErrorState, Field, Input, KV, Metric, Metrics, Modal, PageHeader, SkeletonBlock, SkeletonRows, Stack, useToast } from "@/components/app-ui";
import { api, useApi } from "@/lib/api";
import { dateShort, timeAgo } from "@/lib/format";

export default function WalletDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useSession();
  const toast = useToast();
  const { data: w, error, mutate } = useApi<any>(`/v1/wallets/${id}`, { refreshInterval: 4000 });
  const { data: payments } = useApi<{ data: any[] }>(`/v1/payments?wallet_id=${id}&limit=25`, { refreshInterval: 5000 });
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!w) return <Stack><SkeletonBlock height={140} /><SkeletonBlock height={280} /></Stack>;

  const update = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    try {
      await api(`/v1/wallets/${id}`, { method: "PATCH", body });
      await mutate();
      toast("success", body.monitoring_enabled === false ? "Monitoring paused." : body.monitoring_enabled === true ? "Monitoring resumed. Setra will backfill the gap." : "Wallet renamed.");
      setRenaming(false);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Stop using ${w.name}? Its payment history is kept.`)) return;
    try {
      await api(`/v1/wallets/${id}`, { method: "DELETE" });
      toast("success", "Wallet removed. History is preserved.");
      router.push("/app/wallets");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  const sync = w.sync;

  return (
    <Stack>
      <PageHeader
        breadcrumbs={[{ label: "Wallets", href: "/app/wallets" }, { label: w.name }]}
        title={w.name}
        actions={
          can("wallets:write") && (
            <>
              <Button icon={<Pencil />} onClick={() => { setName(w.name); setRenaming(true); }}>Rename</Button>
              {w.monitoring_enabled ? (
                <Button icon={<Pause />} loading={busy === "pause"} onClick={() => update({ monitoring_enabled: false }, "pause")}>Pause monitoring</Button>
              ) : (
                <Button variant="primary" icon={<Play />} loading={busy === "resume"} onClick={() => update({ monitoring_enabled: true }, "resume")}>Resume monitoring</Button>
              )}
              <Button variant="danger" icon={<Trash2 />} onClick={remove} aria-label="Remove wallet" />
            </>
          )
        }
      />
      {sync && sync.status !== "live" && sync.status !== "backfilling" && (
        <Alert tone={sync.status === "paused" || sync.status === "starting" ? "info" : "warning"} title={sync.status === "starting" ? "Starting monitor" : sync.status === "paused" ? "Monitoring paused" : "Monitoring needs attention"}>
          {sync.message}
        </Alert>
      )}
      <Metrics className="xl:grid-cols-4">
        <Metric label="Status" value={<SyncBadge sync={sync} />} small foot={sync?.last_synced_at ? `Synced ${timeAgo(sync.last_synced_at)}` : "Not synced yet"} />
        <Metric label="Settled through block" small value={sync?.settled_block ? Number(sync.settled_block).toLocaleString() : "-"} foot={sync?.head_block ? `Chain head ${Number(sync.head_block).toLocaleString()}` : undefined} />
        <Metric label="Payments" value={String(w.stats.payments)} foot={w.stats.last_payment_at ? `Last ${timeAgo(w.stats.last_payment_at)}` : "None yet"} />
        <Metric label="Received" value={w.stats.total_received} money />
      </Metrics>
      <DetailGrid>
        <Card title="Activity">{!payments ? <SkeletonRows rows={4} /> : <PaymentsTable rows={payments.data} compact />}</Card>
        <Card title="Wallet">
          <CardBody className="py-1">
            <KV
              items={[
                ["Address", <Address key="a" value={w.address} href={w.explorer_url} />],
                ["Network", <Chain key="n" network={w.network} name={w.network_name} />],
                ["Chain ID", <span key="c" className="tabular">{w.chain_id}</span>],
                ["Assets", w.assets.map((a: any) => a.symbol).join(", ")],
                ["Monitoring since", w.monitor_from_block ? <span key="m" className="tabular">Block {Number(w.monitor_from_block).toLocaleString()}</span> : "Starting…"],
                sync?.backfill && ["History scan", <span key="b" className="text-sm text-muted-foreground">{sync.backfill.status === "completed" ? "Complete" : "Running"} · blocks {Number(sync.backfill.from_block).toLocaleString()}–{Number(sync.backfill.to_block).toLocaleString()}</span>],
                ["Added", dateShort(w.created_at)],
                ["ID", <span key="id" className="flex items-center gap-1 font-mono text-xs">{w.id}<CopyButton value={w.id} /></span>]
              ]}
            />
          </CardBody>
        </Card>
      </DetailGrid>
      <Modal
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename wallet"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
            <Button variant="primary" loading={busy === "rename"} disabled={!name.trim()} onClick={() => update({ name }, "rename")}>Save</Button>
          </>
        }
      >
        <Field label="Name" htmlFor="rename">
          <Input id="rename" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </Stack>
  );
}
