"use client";

import { useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { useSession } from "@/components/session";
import { Alert, Badge, Button, Card, CopyButton, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, SkeletonRows, useToast } from "@/components/app-ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api, useApi, type ApiError } from "@/lib/api";
import { dateShort, timeAgo } from "@/lib/format";

export default function ApiKeysPage() {
  const { can, me } = useSession();
  const toast = useToast();
  const { data, error, mutate } = useApi<{ data: any[] }>("/v1/api-keys");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(null);
  const revoke = async (key: any) => {
    if (!window.confirm(`Revoke “${key.name}”? Requests using it will fail immediately.`)) return;
    try {
      await api(`/v1/api-keys/${key.id}/revoke`, { method: "POST" });
      await mutate();
      toast("success", "Key revoked.");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <PageHeader
        breadcrumbs={[{ label: "Developers", href: "/app/developers" }, { label: "API keys" }]}
        title="API keys"
        description="Keys authenticate your servers. Test keys work with Monad testnet and simulated payments; live keys with Monad mainnet. Keep them server-side only."
        actions={can("api_keys:write") && <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>Create key</Button>}
      />
      {revealed && (
        <Alert tone="warning" title={`Copy “${revealed.name}” now. It won't be shown again`}>
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-warning/30 bg-card px-2.5 py-2">
            <code className="flex-1 truncate font-mono text-xs">{revealed.secret}</code>
            <CopyButton value={revealed.secret} label="Copy API key" />
          </div>
          <span className="text-xs text-muted-foreground block mt-[6px]">Setra stores only a hash of this key. If you lose it, revoke it and create a new one.</span>
        </Alert>
      )}
      <Card>
        {error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : !data ? (
          <SkeletonRows rows={3} cols={5} />
        ) : data.data.length === 0 ? (
          <EmptyState icon={<KeyRound />} title="No API keys yet" mascot="curious" actions={can("api_keys:write") && <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>Create key</Button>}>
            Create a test key to start integrating. You can create a live key when you&rsquo;re ready to accept real payments.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead className="max-md:hidden">Key</TableHead>
                <TableHead className="max-md:hidden">Access</TableHead>
                <TableHead className="max-md:hidden">Last used</TableHead>
                <TableHead className="max-md:hidden">Created</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((k) => (
                <TableRow key={k.id} className={cn(k.revoked_at && "opacity-55")}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell>
                    <Badge tone={k.mode === "live" ? "success" : "warning"}>{k.mode === "live" ? "Live" : "Test"}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground max-md:hidden">{k.prefix}</TableCell>
                  <TableCell className="max-md:hidden">{k.scope === "read_only" ? "Read only" : "Read & write"}</TableCell>
                  <TableCell className="text-muted-foreground max-md:hidden">{k.last_used_at ? timeAgo(k.last_used_at) : "Never"}</TableCell>
                  <TableCell className="text-muted-foreground max-md:hidden">{dateShort(k.created_at)}</TableCell>
                  <TableCell className="text-right">
                    {k.revoked_at ? (
                      <span className="text-muted-foreground">Revoked</span>
                    ) : (
                      can("api_keys:write") && (
                        <Button size="sm" variant="danger" onClick={() => revoke(k)}>
                          Revoke
                        </Button>
                      )
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <CreateKeyModal
        open={creating}
        onClose={() => setCreating(false)}
        canLive={me.permissions.includes("api_keys:write_live")}
        defaultMode={me.environment}
        onCreated={(k) => {
          setRevealed(k);
          setCreating(false);
          mutate();
        }}
      />
    </div>
  );
}

function CreateKeyModal({ open, onClose, onCreated, canLive, defaultMode }: { open: boolean; onClose: () => void; onCreated: (k: { name: string; secret: string }) => void; canLive: boolean; defaultMode: string }) {
  const [name, setName] = useState("Backend");
  const [mode, setMode] = useState(defaultMode === "live" && canLive ? "live" : "test");
  const [scope, setScope] = useState("read_write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create API key"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const k = await api<{ name: string; secret: string }>("/v1/api-keys", { method: "POST", body: { name, mode, scope } });
                onCreated(k);
              } catch (e) {
                setError(e as ApiError);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create key
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        <Field label="Name" htmlFor="k-name" hint="Where this key will be used, e.g. “Checkout service”.">
          <Input id="k-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mode" htmlFor="k-mode" hint={canLive ? undefined : "Only owners and admins can create live keys."}>
            <Select id="k-mode" value={mode} onValueChange={setMode} options={[
              { value: "test", label: "Test (Monad testnet)" },
              { value: "live", label: "Live (Monad mainnet)", disabled: !canLive }
            ]} />
          </Field>
          <Field label="Access" htmlFor="k-scope">
            <Select id="k-scope" value={scope} onValueChange={setScope} options={[
              { value: "read_write", label: "Read & write" },
              { value: "read_only", label: "Read only" }
            ]} />
          </Field>
        </div>
        {mode === "live" && (
          <Alert tone="warning">Live keys act on real payment data. Never embed them in a browser or mobile app.</Alert>
        )}
      </div>
    </Modal>
  );
}
