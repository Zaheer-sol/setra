"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Button, Field, Input } from "@/components/app-ui";
import { api, type ApiError } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <>
      <h1>Reset your password</h1>
      <p className="mt-2 text-[1.0625rem] tracking-[-0.012em] text-muted-foreground">We&rsquo;ll email you a link to choose a new one.</p>
      {sent ? (
        <Alert tone="success" title="Check your email">
          If an account exists for {email}, a reset link is on its way. It expires in one hour.
        </Alert>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api("/v1/auth/forgot-password", { method: "POST", body: { email } });
              setSent(true);
            } catch (err) {
              setError(err as ApiError);
            } finally {
              setBusy(false);
            }
          }}
        >
          {error && <Alert tone="danger">{error.message}</Alert>}
          <Field label="Work email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-5 text-center text-sm text-muted-foreground">
        <Link href="/login" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
