"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert, Button, Field, Input } from "@/components/app-ui";
import { api, type ApiError } from "@/lib/api";

function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  if (!token) return <Alert tone="warning" title="This link is incomplete">Open the reset link from your email again, or request a new one.</Alert>;
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api("/v1/auth/reset-password", { method: "POST", body: { token, password } });
          router.replace("/app");
        } catch (err) {
          setError(err as ApiError);
          setBusy(false);
        }
      }}
    >
      {error && <Alert tone="danger">{error.message}</Alert>}
      <Field label="New password" htmlFor="password" hint="At least 10 characters. You'll be signed out on other devices.">
        <Input id="password" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </Field>
      <Button type="submit" variant="primary" size="lg" block loading={busy}>
        Set new password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <>
      <h1>Choose a new password</h1>
      <p className="mt-2 text-[1.0625rem] tracking-[-0.012em] text-muted-foreground">Reset links work once and expire after an hour.</p>
      <Suspense>
        <ResetForm />
      </Suspense>
      <p className="mt-5 text-center text-sm text-muted-foreground">
        <Link href="/forgot-password" className="font-medium text-primary hover:underline">
          Request a new link
        </Link>
      </p>
    </>
  );
}
