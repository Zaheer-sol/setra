"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import { Alert, Badge, Button, ButtonLink, Chain, CopyButton, Field, fieldErrors, Input, Logo, MoneyInput, Spinner, TextLink } from "@/components/app-ui";
import { Card } from "@/components/ui/card";
import { AnimatePresence, EASE, motion } from "@/components/motion";
import { Seti, type SetiMood } from "@/components/seti";
import { cn } from "@/lib/utils";
import { api, newIdempotencyKey, useApi, type ApiError } from "@/lib/api";

const STEPS = ["Business", "Wallet", "Customer", "Invoice", "Share"] as const;
// Seti keeps the user company through setup: hello, careful with the wallet, curious about the
// customer, focused on the invoice, and celebrating when the payment link is ready.
const STEP_MOOD: SetiMood[] = ["welcome", "focused", "curious", "focused", "success"];

function Onboarding() {
  const router = useRouter();
  const params = useSearchParams();
  const creatingNew = params.get("new") === "1";
  const { data: me, error: meError, mutate } = useApi<any>("/v1/me", { shouldRetryOnError: false });
  const [step, setStep] = useState(0);
  const [setup, setSetup] = useState<"books" | "collect">("books");
  const steps = setup === "books" ? STEPS.slice(0, 2) : STEPS;
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [business, setBusiness] = useState("");
  const [wallet, setWallet] = useState({ name: "Main Wallet", address: "" });
  const [customer, setCustomer] = useState({ name: "", email: "", address: "" });
  const [customerId, setCustomerId] = useState("");
  const [invoice, setInvoice] = useState({ amount: "", title: "" });
  const [created, setCreated] = useState<{ id: string; number: string; payment_url: string } | null>(null);
  const [keys] = useState(() => ({ wallet: newIdempotencyKey(), invoice: newIdempotencyKey() }));
  const errs = fieldErrors(error);

  useEffect(() => {
    if (meError?.status === 401) router.replace("/login?next=/onboarding");
  }, [meError, router]);
  useEffect(() => {
    if (me?.organization && !creatingNew && step === 0) setStep(1);
  }, [me, creatingNew, step]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const finishBooks = async () => {
    await api("/v1/organization", { method: "PATCH", body: { onboarding_completed: true } });
    router.push("/app/accounting");
  };

  if (!me)
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );

  return (
    <div className="mx-auto max-w-[600px]">
      <header className="mb-8 flex items-center justify-between gap-3">
        <Logo />
        {me.organization && (
          <TextLink href="/app" className="text-sm">
            Skip to console
          </TextLink>
        )}
      </header>
      <ol className="mb-5 flex gap-1.5 overflow-x-auto" aria-label="Setup progress">
        {steps.map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? "step" : undefined}
            className={cn(
              "flex flex-1 items-center gap-2 border-b-2 pb-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground",
              i < step && "border-success text-foreground/80",
              i === step && "border-primary text-foreground",
              i > step && "border-border"
            )}
          >
            <span className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[11px]", i < step ? "bg-success text-white" : i === step ? "bg-primary text-primary-foreground" : "bg-muted")}>
              {i < step ? <Check className="size-3 stroke-[3]" /> : i + 1}
            </span>
            <span className="max-sm:hidden">{s}</span>
          </li>
        ))}
      </ol>

      <Card className="onboarding-card gap-0 rounded-3xl p-9 max-sm:px-[18px] max-sm:py-[22px] [&_h1]:text-[1.875rem] [&_h1]:leading-tight [&_h1]:font-bold [&_h1]:tracking-[-0.03em]">
        {error && !error.details && (
          <div className="mb-4">
            <Alert tone="danger">{error.message}</Alert>
          </div>
        )}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={step} initial={{ opacity: 0, x: 28 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -28 }} transition={{ duration: 0.35, ease: EASE }}>
            <Seti mood={STEP_MOOD[step] ?? "welcome"} size={96} className="mb-4" priority />
            {step === 0 && (
              <form
                className="grid gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    await api("/v1/organizations", { method: "POST", body: { name: business } });
                    await mutate();
                    setStep(1);
                  });
                }}
              >
                <div>
                  <h1>What&rsquo;s your business called?</h1>
                  <p className="mt-2 text-[1.0625rem] tracking-[-0.012em] text-muted-foreground">Your workspace brings wallets, books and financial reports together. If you collect payments, customers also see this name.</p>
                </div>
                <Field label="Business name" htmlFor="ob-business" error={errs.name}>
                  <Input id="ob-business" className="h-11 rounded-xl text-[1.0625rem]" value={business} onChange={(e) => setBusiness(e.target.value)} autoFocus placeholder="Acme Infrastructure" required />
                </Field>
                <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!business.trim()}>
                  Continue
                </Button>
              </form>
            )}

            {step === 1 && (
              <form
                className="grid gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    // Coming back to setup (reload, back button) with a wallet already added: carry on with it.
                    await api("/v1/wallets", { method: "POST", idempotencyKey: keys.wallet, body: { name: wallet.name, network: "monad", address: wallet.address.trim(), assets: ["USDC"] } }).catch((e) => {
                      if ((e as ApiError).code !== "wallet_exists") throw e;
                    });
                    if (setup === "books") await finishBooks();
                    else setStep(2);
                  });
                }}
              >
                <div>
                  <h1>How would you like to start?</h1>
                  <p className="mt-2 text-[1.0625rem] tracking-[-0.012em] text-muted-foreground">Keep the way you get paid. Connect a wallet for monitoring, or start your books and add one later.</p>
                </div>
                <fieldset className="grid gap-2" disabled={busy}>
                  <legend className="mb-2 text-sm font-medium">Choose your starting point</legend>
                  {([
                    ["books", "Start with my books", "Classify money, record bills and expenses, and review reports. No invoice required."],
                    ["collect", "Collect a payment", "Connect a wallet, add a customer and create your first payment request."]
                  ] as const).map(([value, title, description]) => (
                    <label key={value} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-4", setup === value && "border-primary bg-primary/5")}>
                      <input type="radio" name="setup" value={value} checked={setup === value} onChange={() => setSetup(value)} className="mt-1 accent-[var(--primary)]" />
                      <span><span className="block font-medium">{title}</span><span className="mt-1 block text-sm text-muted-foreground">{description}</span></span>
                    </label>
                  ))}
                </fieldset>
                <p className="text-sm text-muted-foreground">Setra monitors public addresses on Monad. Your funds never pass through Setra.</p>
                <div className="flex flex-wrap items-center gap-2.5">
                  <Badge tone="info">Test mode</Badge>
                  <Chain network="monad" name="Monad Testnet" />
                  <span className="text-muted-foreground text-sm">· USDC</span>
                </div>
                <Field label="Public wallet address" htmlFor="ob-address" error={errs.address} hint="Paste the address only. Setra never asks for a private key or seed phrase.">
                  <Input
                    id="ob-address"
                    className="h-11 rounded-xl font-mono"
                    value={wallet.address}
                    onChange={(e) => setWallet((w) => ({ ...w, address: e.target.value }))}
                    placeholder="0x…"
                    spellCheck={false}
                    required
                  />
                </Field>
                <Field label="Name" htmlFor="ob-wname">
                  <Input id="ob-wname" value={wallet.name} onChange={(e) => setWallet((w) => ({ ...w, name: e.target.value }))} />
                </Field>
                <Alert tone="neutral">You start in test mode on Monad testnet. Switch to live mode (Monad mainnet) any time from the console.</Alert>
                <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!/^0x[0-9a-fA-F]{40}$/.test(wallet.address.trim())}>
                  Start monitoring
                </Button>
                {setup === "books" && (
                  <Button type="button" size="lg" disabled={busy} onClick={() => run(finishBooks)}>
                    Set up wallet later
                  </Button>
                )}
              </form>
            )}

            {step === 2 && (
              <form
                className="grid gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    const c = await api<{ id: string }>("/v1/customers", {
                      method: "POST",
                      body: { name: customer.name, email: customer.email || undefined, wallet_addresses: customer.address ? [{ address: customer.address.trim(), network: "monad" }] : [] }
                    });
                    setCustomerId(c.id);
                    setStep(3);
                  });
                }}
              >
                <div>
                  <h1>Who&rsquo;s paying you?</h1>
                  <p className="mt-2 text-[1.0625rem] tracking-[-0.012em] text-muted-foreground">
                    Add your first customer. A known wallet helps Setra match payments; ambiguous activity still goes to review.
                  </p>
                </div>
                <Field label="Customer name" htmlFor="ob-cname" error={errs.name}>
                  <Input id="ob-cname" value={customer.name} onChange={(e) => setCustomer((c) => ({ ...c, name: e.target.value }))} autoFocus placeholder="Acme Ltd" required />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Billing email" htmlFor="ob-cemail" optional>
                    <Input id="ob-cemail" type="email" value={customer.email} onChange={(e) => setCustomer((c) => ({ ...c, email: e.target.value }))} />
                  </Field>
                  <Field label="Their wallet address" htmlFor="ob-caddr" optional error={errs["wallet_addresses.0.address"]}>
                    <Input id="ob-caddr" className="font-mono text-[0.92em]" value={customer.address} onChange={(e) => setCustomer((c) => ({ ...c, address: e.target.value }))} placeholder="0x…" spellCheck={false} />
                  </Field>
                </div>
                <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!customer.name.trim()}>
                  Continue
                </Button>
              </form>
            )}

            {step === 3 && (
              <form
                className="grid gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    const inv = await api<any>("/v1/invoices", {
                      method: "POST",
                      idempotencyKey: keys.invoice,
                      body: { customer_id: customerId, amount: invoice.amount, title: invoice.title.trim(), asset: "USDC", network: "monad" }
                    });
                    setCreated(inv);
                    setStep(4);
                  });
                }}
              >
                <div>
                  <h1>Request your first payment</h1>
                  <p className="mt-2 text-[1.0625rem] tracking-[-0.012em] text-muted-foreground">Monad and USDC are already selected. You can change them later.</p>
                </div>
                <Field label="Amount" htmlFor="ob-amount" error={errs.amount}>
                  <MoneyInput id="ob-amount" large suffix="USDC" value={invoice.amount} onChange={(amount) => setInvoice((i) => ({ ...i, amount }))} placeholder="2,000.00" autoFocus required />
                </Field>
                <Field label="What is this payment for?" htmlFor="ob-desc" hint="Your customer sees this before paying.">
                  <Input id="ob-desc" value={invoice.title} onChange={(e) => setInvoice((i) => ({ ...i, title: e.target.value }))} placeholder="September Infrastructure Services" maxLength={140} required />
                </Field>
                <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!invoice.title.trim() || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(invoice.amount) || Number(invoice.amount) <= 0}>
                  Create payment request
                </Button>
              </form>
            )}

            {step === 4 && created && (
              <div className="grid gap-4">
                <div>
                  <div className="mb-3 grid size-12 place-items-center rounded-full bg-success/12 text-success">
                    <Check className="size-[22px]" />
                  </div>
                  <h1>{created.number} is ready to pay</h1>
                  <p className="mt-2 text-[1.0625rem] tracking-[-0.012em] text-muted-foreground">
                    Send this link to your customer. When they pay, Setra detects the payment on Monad, verifies it, matches it to {created.number} and marks it paid.
                  </p>
                </div>
                <div className="flex min-w-0 items-center gap-1.5 rounded-xl bg-muted px-3.5 py-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{created.payment_url}</span>
                  <CopyButton value={created.payment_url} label="Copy payment link" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ButtonLink href={created.payment_url} target="_blank" rel="noreferrer" size="lg" icon={<ExternalLink aria-hidden="true" />}>
                    Open payment page
                  </ButtonLink>
                  <Button
                    variant="primary"
                    size="lg"
                    onClick={async () => {
                      await api("/v1/organization", { method: "PATCH", body: { onboarding_completed: true } }).catch(() => undefined);
                      router.push(`/app/invoices/${created.id}`);
                    }}
                  >
                    Watch for the payment
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">No testnet USDC handy? You can simulate the payment from the invoice page. It goes through the same pipeline.</p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </Card>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <main id="main" className="min-h-screen px-5 py-8">
      <Suspense>
        <Onboarding />
      </Suspense>
    </main>
  );
}
