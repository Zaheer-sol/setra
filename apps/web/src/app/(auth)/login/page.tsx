"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert, Button, Field, Input } from "@/components/app-ui";
import { api, type ApiError } from "@/lib/api";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/app";

  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const res = await api<{ organization_id: string | null }>("/v1/auth/login", { method: "POST", body: { email, password } });
          router.replace(res.organization_id ? safeNext : "/onboarding");
        } catch (err) {
          setError(err as ApiError);
          setBusy(false);
        }
      }}
    >
      {error && <Alert tone="danger">{error.message}</Alert>}
      <Field label="Work email" htmlFor="email">
        <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </Field>
      <Field
        label={
          <span className="flex items-center justify-between gap-3 w-full">
            Password
            <Link href="/forgot-password" className="font-medium text-primary hover:underline text-xs">
              Forgot password?
            </Link>
          </span>
        }
        htmlFor="password"
      >
        <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" size="lg" block loading={busy}>
        Sign in
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <>
      <h1>Sign in to Setra</h1>
      <p className="mt-2 text-[1.0625rem] tracking-[-0.012em] text-muted-foreground">See what every payment means.</p>
      <Suspense>
        <LoginForm />
      </Suspense>
      <p className="mt-5 text-center text-sm text-muted-foreground">
        New to Setra?{" "}
        <Link href="/signup" className="font-medium text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}
