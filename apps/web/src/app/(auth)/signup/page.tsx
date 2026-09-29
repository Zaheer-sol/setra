"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, fieldErrors, Input } from "@/components/app-ui";
import { api, type ApiError } from "@/lib/api";

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const errs = fieldErrors(error);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <h1>Create your account</h1>
      <p className="mt-2 text-[1.0625rem] tracking-[-0.012em] text-muted-foreground">Start in test mode on Monad testnet. No card required.</p>
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api("/v1/auth/signup", { method: "POST", body: form });
            router.replace("/onboarding");
          } catch (err) {
            setError(err as ApiError);
            setBusy(false);
          }
        }}
      >
        {error && !error.details && <Alert tone="danger">{error.message}</Alert>}
        <Field label="Your name" htmlFor="name" error={errs.name}>
          <Input id="name" autoComplete="name" required value={form.name} onChange={set("name")} autoFocus invalid={!!errs.name} />
        </Field>
        <Field label="Work email" htmlFor="email" error={errs.email}>
          <Input id="email" type="email" autoComplete="email" required value={form.email} onChange={set("email")} invalid={!!errs.email} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters." error={errs.password}>
          <Input id="password" type="password" autoComplete="new-password" required minLength={10} value={form.password} onChange={set("password")} invalid={!!errs.password} />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Create account
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
