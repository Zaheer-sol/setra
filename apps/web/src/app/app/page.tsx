"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Check, Plus } from "lucide-react";
import { ExceptionsList, PaymentsTable } from "@/components/payment-tables";
import { useSession } from "@/components/session";
import { ButtonLink, Card, CardBody, ErrorState, Metric, Metrics, Money, Segmented, SkeletonBlock, SkeletonRows, Spinner } from "@/components/app-ui";
import { cn } from "@/lib/utils";
import { Seti } from "@/components/seti";
import { useApi } from "@/lib/api";

interface Overview {
  period: { name: string };
  metrics: {
    received: string;
    payments: number;
    matched: number;
    confirming: number;
    needs_attention: number;
    needs_attention_amount: string;
    unknown: number;
    outstanding: string;
    outstanding_invoices: number;
  };
  recent_activity: any[];
  needs_attention: any[];
  monitoring: Array<{ wallet_id: string; name: string; network: string; status: string; message: string }>;
  setup: { wallets: number; customers: number; invoices: number; payments: number; webhooks: number };
}

const PERIODS = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" }
] as const;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default function OverviewPage() {
  const { me } = useSession();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("today");
  const { data, error, mutate } = useApi<Overview>(`/v1/overview?period=${period}`, { refreshInterval: 5000, keepPreviousData: true });
  const firstName = me.user.name.split(" ")[0];

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-end gap-4">
          <Seti mood="welcome" size={84} priority className="-mb-1 max-sm:hidden" />
          <div>
          <p className="text-sm text-muted-foreground">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
          <h1 className="mt-1 text-[2.125rem] leading-[1.08] font-bold tracking-[-0.03em] max-md:text-[1.75rem]">
            {greeting()}, {firstName}.
          </h1>
          <p className="mt-2 text-[1.0625rem] tracking-[-0.012em] text-muted-foreground">Here&rsquo;s what is happening with your money.</p>
          </div>
        </div>
        <Segmented label="Period" value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p.key, label: p.label }))} />
      </header>

      {error ? (
        <Card>
          <ErrorState error={error} retry={() => mutate()} />
        </Card>
      ) : !data ? (
        <SkeletonBlock height={104} />
      ) : (
        <>
          {data.setup.payments === 0 && <SetupChecklist setup={data.setup} />}
          <Metrics label="Summary">
            <Metric label="Received" value={data.metrics.received} money foot={`${data.metrics.payments} payment${data.metrics.payments === 1 ? "" : "s"}`} />
            <Metric label="Matched" value={String(data.metrics.matched)} foot={data.metrics.payments ? `${Math.round((data.metrics.matched / data.metrics.payments) * 100)}% matched automatically` : "No payments in period"} />
            <Metric label="Needs attention" value={String(data.metrics.needs_attention)} href="/app/exceptions" warn={data.metrics.needs_attention > 0} foot={data.metrics.needs_attention ? <Money value={data.metrics.needs_attention_amount} /> : "All clear"} />
            <Metric label="Unknown" value={String(data.metrics.unknown)} href="/app/exceptions?type=unknown_payment" warn={data.metrics.unknown > 0} foot="Can't be matched safely" />
            <Metric label="Outstanding" value={data.metrics.outstanding} money href="/app/invoices?status=open" foot={`${data.metrics.outstanding_invoices} open invoice${data.metrics.outstanding_invoices === 1 ? "" : "s"}`} />
          </Metrics>
          {data.metrics.confirming > 0 && (
            <div className="flex gap-3 rounded-xl bg-info/10 px-4 py-3 text-sm" role="status">
              <Spinner className="mt-0.5 text-info" />
              <div className="grid gap-0.5">
                <strong className="font-semibold">
                  {data.metrics.confirming} payment{data.metrics.confirming === 1 ? "" : "s"} confirming
                </strong>
                <span className="text-foreground/80">Detected on chain and waiting for finality. Balances update the moment they&rsquo;re final.</span>
              </div>
            </div>
          )}
        </>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card
          title="Recent activity"
          actions={
            <ButtonLink href="/app/payments" size="sm" variant="ghost">
              All payments <ArrowRight />
            </ButtonLink>
          }
        >
          {!data ? <SkeletonRows rows={6} cols={4} /> : <PaymentsTable rows={data.recent_activity} compact />}
        </Card>
        <Card
          title="Needs attention"
          description="Payments Setra won't decide on its own"
          actions={
            data?.needs_attention.length ? (
              <ButtonLink href="/app/exceptions" size="sm" variant="ghost">
                Review <ArrowRight />
              </ButtonLink>
            ) : undefined
          }
        >
          {!data ? (
            <SkeletonRows rows={4} cols={2} />
          ) : (
            <ExceptionsList rows={data.needs_attention} empty={<CardBody className="flex items-center gap-2.5 text-muted-foreground"><Check className="size-4 text-success" /> Every payment is accounted for.</CardBody>} />
          )}
        </Card>
      </div>
    </div>
  );
}

function SetupChecklist({ setup }: { setup: Overview["setup"] }) {
  const steps = [
    { done: setup.wallets > 0, title: "Add a receiving wallet", desc: "Setra watches it on Monad. Your funds stay under your control.", href: "/app/wallets?add=1", cta: "Add wallet" },
    { done: setup.customers > 0, title: "Add a customer", desc: "Link their wallet addresses so partial payments can be matched safely.", href: "/app/customers?add=1", cta: "Add customer" },
    { done: setup.invoices > 0, title: "Create your first invoice", desc: "Monad and USDC are selected by default.", href: "/app/invoices/new", cta: "Create invoice" },
    { done: setup.payments > 0, title: "Receive a payment", desc: "Share the payment link. Setra detects, verifies and matches the payment.", href: "/app/invoices", cta: "View invoices" }
  ];
  const next = steps.find((s) => !s.done);
  return (
    <Card title="Get set up" description={`${steps.filter((s) => s.done).length} of ${steps.length} done`}>
      <CardBody className="py-1">
        <ol className="grid">
          {steps.map((s) => (
            <li key={s.title} className="grid grid-cols-[26px_1fr_auto] items-center gap-3 border-t py-3 first:border-t-0">
              <span className={cn("grid size-[22px] place-items-center rounded-full", s.done ? "bg-success text-white" : "border-[1.5px] border-dashed border-muted-foreground/40")} aria-label={s.done ? "Done" : "Not done"}>
                {s.done && <Check className="size-3 stroke-[3]" />}
              </span>
              <div>
                <div className={cn("font-semibold", s.done && "text-muted-foreground line-through decoration-muted-foreground/40")}>{s.title}</div>
                <div className="text-sm text-muted-foreground">{s.desc}</div>
              </div>
              {!s.done && s === next && (
                <ButtonLink href={s.href} size="sm" variant="primary" icon={<Plus />}>
                  {s.cta}
                </ButtonLink>
              )}
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}

