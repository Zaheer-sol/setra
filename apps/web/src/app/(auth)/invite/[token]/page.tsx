"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Input, SkeletonBlock } from "@/components/app-ui";
import { api, useApi, type ApiError } from "@/lib/api";

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { data, error } = useApi<{ email: string; role: string; organization_name: string; has_account: boolean }>(`/v1/invitations/${encodeURIComponent(token)}`, { shouldRetryOnError: false });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  if (error) return <Alert tone="warning" title="Invitation unavailable">{error.message}</Alert>;
  if (!data) return <SkeletonBlock height={200} />;
  const accept = async (body: Record<string, string>) => {
    setBusy(true);
    setSubmitError(null);
    try {
      await api("/v1/invitations/accept", { method: "POST", body: { token, ...body } });
      router.replace("/app");
    } catch (err) {
      setSubmitError(err as ApiError);
      setBusy(false);
    }
  };
  return (
    <>
      <h1>Join {data.organization_name}</h1>
      <p className="mt-2 text-[1.0625rem] tracking-[-0.012em] text-muted-foreground">
        You&rsquo;ve been invited as <strong className="text-foreground capitalize">{data.role}</strong> ({data.email}).
      </p>
      {submitError && <div className="mb-[16px]"><Alert tone="danger">{submitError.message}</Alert></div>}
      {data.has_account ? (
        <div className="grid gap-4">
          <Button variant="primary" size="lg" block loading={busy} onClick={() => accept({})}>
            Accept invitation
          </Button>
          <p className="text-muted-foreground text-sm text-center">
            Not signed in? <Link className="font-medium text-primary hover:underline" href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in as {data.email}</Link> first.
          </p>
        </div>
      ) : (
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); accept({ name, password }); }}>
          <Field label="Your name" htmlFor="name">
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Choose a password" htmlFor="password" hint="At least 10 characters.">
            <Input id="password" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            Create account and join
          </Button>
        </form>
      )}
    </>
  );
}
