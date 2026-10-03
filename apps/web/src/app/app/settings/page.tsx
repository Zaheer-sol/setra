"use client";

import { useState } from "react";
import { Plus, UserPlus } from "lucide-react";
import { useSession } from "@/components/session";
import { Alert, Badge, Button, Card, CardBody, CopyButton, ErrorState, Field, Input, KV, Modal, Mono, PageHeader, Select, SkeletonRows, useToast } from "@/components/app-ui";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useApi, type ApiError } from "@/lib/api";
import { dateShort, dateTime, initials } from "@/lib/format";

const TABS = ["Workspace", "Team", "Audit log"] as const;

export default function SettingsPage() {
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs defaultValue="Workspace" className="gap-6">
        <TabsList aria-label="Settings sections">
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t} className="cursor-pointer px-4">
              {t}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="Workspace">
          <Workspace />
        </TabsContent>
        <TabsContent value="Team">
          <Team />
        </TabsContent>
        <TabsContent value="Audit log">
          <AuditLog />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Workspace() {
  const { can, refresh } = useSession();
  const toast = useToast();
  const { data, error, mutate } = useApi<any>("/v1/organization");
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  if (!data) return <Card><SkeletonRows rows={3} cols={2} /></Card>;
  const editable = can("organization:write");
  return (
    <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
      <Card title="Business profile" description="Shown to customers on hosted payment pages.">
        <form
          className="grid gap-4 px-6 py-5 max-md:px-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api("/v1/organization", { method: "PATCH", body: { name: name ?? data.name, support_email: (email ?? data.support_email) || null } });
              await mutate();
              await refresh();
              toast("success", "Saved.");
            } catch (err) {
              toast("error", (err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Business name" htmlFor="org-name">
            <Input id="org-name" value={name ?? data.name} onChange={(e) => setName(e.target.value)} disabled={!editable} />
          </Field>
          <Field label="Support email" htmlFor="org-email" optional hint="Customers see this if they have a question about a payment.">
            <Input id="org-email" type="email" value={email ?? data.support_email ?? ""} onChange={(e) => setEmail(e.target.value)} disabled={!editable} />
          </Field>
          {editable && (
            <div>
              <Button type="submit" variant="primary" loading={busy}>Save changes</Button>
            </div>
          )}
        </form>
      </Card>
      <Card title="Workspace" padded>
        <KV
          items={[
            ["Workspace ID", <span key="id" className="flex items-center gap-1 font-mono text-xs">{data.id}<CopyButton value={data.id} /></span>],
            ["Created", dateShort(data.created_at)],
            ["Type", data.is_demo ? "Demo workspace (sample data)" : "Standard"]
          ]}
        />
        <p className="mt-3 text-sm text-muted-foreground">
          Setra keeps financial history permanently. Evidence, decisions, events and audit entries cannot be edited or deleted.
        </p>
      </Card>
      <Card title="Counterparty lookups" description="See who's behind wallets you don't recognise, using Nansen's public data.">
        <div className="grid gap-3 px-6 py-5 max-md:px-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 accent-[var(--primary)]"
              checked={!!data.counterparty_intel_enabled}
              disabled={!editable}
              onChange={async (e) => {
                try {
                  await api("/v1/organization", { method: "PATCH", body: { counterparty_intel_enabled: e.target.checked } });
                  await mutate();
                  toast("success", e.target.checked ? "Counterparty lookups are on." : "Counterparty lookups are off.");
                } catch (err) {
                  toast("error", (err as Error).message);
                }
              }}
            />
            <span className="text-sm">
              <span className="block font-medium">Look up unknown wallets with Nansen</span>
              <span className="text-muted-foreground">Setra sends a public wallet address to Nansen when you look at an unidentified payment, a transfer you sent, or an address you're about to save. It shows the wallet's public labels (for example, an exchange), which of your customers it has dealt with, and a suggested next step. Nothing is matched or saved automatically.</span>
            </span>
          </label>
          {!data.counterparty_intel_available && <p className="text-xs text-muted-foreground">Needs a Nansen API key on the server (NANSEN_API_KEY).</p>}
        </div>
      </Card>
    </div>
  );
}

function Team() {
  const { can, me } = useSession();
  const toast = useToast();
  const { data, error, mutate } = useApi<{ members: any[]; invitations: any[] }>("/v1/members");
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ email: string; url: string; sent: boolean } | null>(null);
  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  const manage = can("members:write");
  const changeRole = async (id: string, role: string) => {
    try {
      await api(`/v1/members/${id}`, { method: "PATCH", body: { role } });
      await mutate();
      toast("success", "Role updated.");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  const remove = async (m: any) => {
    if (!window.confirm(`Remove ${m.name} from this workspace?`)) return;
    try {
      await api(`/v1/members/${m.id}`, { method: "DELETE" });
      await mutate();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      {link && (
        <Alert tone={link.sent ? "success" : "info"} title={link.sent ? `Invitation emailed to ${link.email}` : `Share this invitation link with ${link.email}`}>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 truncate font-mono text-xs">{link.url}</code>
            <CopyButton value={link.url} label="Copy invitation link" />
          </div>
          <span className="text-xs text-muted-foreground">Valid for 7 days. Shown once.</span>
        </Alert>
      )}
      <Card title="Members" actions={manage && <Button size="sm" variant="primary" icon={<UserPlus />} onClick={() => setInviting(true)}>Invite</Button>}>
        {!data ? (
          <SkeletonRows rows={3} cols={3} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="max-md:hidden">Joined</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <span className="flex items-center gap-2.5">
                      <Avatar className="size-7">
                        <AvatarFallback className="bg-primary/12 text-xs font-bold text-primary">{initials(m.name)}</AvatarFallback>
                      </Avatar>
                      <span>
                        <span className="font-medium">
                          {m.name}
                          {m.user_id === me.user.id && <span className="text-muted-foreground"> (you)</span>}
                        </span>
                        <span className="block text-xs text-muted-foreground">{m.email}</span>
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    {m.role === "owner" || !manage || m.user_id === me.user.id ? (
                      <span className="capitalize">{m.role}</span>
                    ) : (
                      <Select
                        size="sm"
                        className="w-auto"
                        value={m.role}
                        onValueChange={(v) => changeRole(m.id, v)}
                        aria-label={`Role for ${m.name}`}
                        options={["admin", "operator", "accountant", "developer", "viewer"].map((r) => ({ value: r, label: r[0]!.toUpperCase() + r.slice(1) }))}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-md:hidden">{dateShort(m.joined_at)}</TableCell>
                  <TableCell className="text-right">
                    {manage && m.role !== "owner" && m.user_id !== me.user.id && (
                      <Button size="sm" variant="ghost" onClick={() => remove(m)}>
                        Remove
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {data.invitations.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <span className="font-medium">{i.email}</span>
                    <span className="block text-xs text-muted-foreground">Invitation pending</span>
                  </TableCell>
                  <TableCell className="capitalize">{i.role}</TableCell>
                  <TableCell className="text-muted-foreground max-md:hidden">Expires {dateShort(i.expires_at)}</TableCell>
                  <TableCell className="text-right">
                    {manage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await api(`/v1/members/invitations/${i.id}`, { method: "DELETE" });
                          mutate();
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <Card title="Roles" padded>
        <KV
          items={[
            ["Owner / Admin", "Everything, including wallets, team and live API keys."],
            ["Operator", "Customers, invoices, and resolving exceptions."],
            ["Developer", "Invoices, webhooks and test API keys."],
            ["Viewer", "Read-only access to payments, invoices and reports."]
          ]}
        />
      </Card>
      <InviteModal open={inviting} onClose={() => setInviting(false)} onInvited={(l) => { setLink(l); setInviting(false); mutate(); }} />
    </div>
  );
}

function InviteModal({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited: (l: { email: string; url: string; sent: boolean }) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("operator");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite a teammate"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon={<Plus />}
            loading={busy}
            disabled={!email}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await api<{ invitation_url: string; email_sent: boolean }>("/v1/members/invitations", { method: "POST", body: { email, role } });
                onInvited({ email, url: r.invitation_url, sent: r.email_sent });
                setEmail("");
              } catch (e) {
                setError(e as ApiError);
              } finally {
                setBusy(false);
              }
            }}
          >
            Send invitation
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error.message}</Alert>}
        <Field label="Email" htmlFor="inv-email"><Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
        <Field label="Role" htmlFor="inv-role">
          <Select id="inv-role" value={role} onValueChange={setRole} options={[
            { value: "admin", label: "Admin" },
            { value: "operator", label: "Operator" },
            { value: "accountant", label: "Accountant (books, invoices, reports; no wallets or developer settings)" },
            { value: "developer", label: "Developer" },
            { value: "viewer", label: "Viewer" }
          ]} />
        </Field>
      </div>
    </Modal>
  );
}

function AuditLog() {
  const { data, error, mutate } = useApi<{ data: any[] }>("/v1/audit-logs?limit=100", { refreshInterval: 10000 });
  if (error) return <Card><ErrorState error={error} retry={() => mutate()} /></Card>;
  return (
    <Card title="Audit log" description="Every change to wallets, invoices, keys, webhooks and exceptions, who, what and when. Append-only.">
      {!data ? (
        <SkeletonRows rows={8} cols={4} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Action</TableHead>
              <TableHead className="max-md:hidden">Object</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead className="max-md:hidden">Mode</TableHead>
              <TableHead className="text-right">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.data.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">{a.action.replace(/_/g, " ").replace(/^\w/, (c: string) => c.toUpperCase())}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground max-md:hidden">
                  {a.object_type} · {a.object_id.slice(0, 16)}
                  {a.object_id.length > 16 ? "…" : ""}
                </TableCell>
                <TableCell>
                  {a.actor.type === "system" ? "Setra" : a.actor.label ?? a.actor.type}
                  {a.actor.type === "api_key" && (
                    <Badge tone="neutral" dot={false} className="ml-1.5 h-5 rounded-md px-1.5 text-[11px]">
                      API key
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground max-md:hidden">{a.environment ?? "-"}</TableCell>
                <TableCell className="text-right text-muted-foreground" title={a.request_id ?? undefined}>
                  {dateTime(a.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
