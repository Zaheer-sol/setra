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
          <p className="mt-2 text-[1.0625rem] tracking-[-0.012em] text-muted-foreground">What came in, what remains open and what needs your decision.</p>
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
          {/* Three numbers a business checks daily; the detail lives one click away. */}
          <Metrics label="Summary" className="grid-cols-1 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-3">
            <Metric
              label="Received"
              value={data.metrics.received}
              money
              href="/app/payments"
              foot={data.metrics.payments ? `${data.metrics.payments} payment${data.metrics.payments === 1 ? "" : "s"} · ${Math.round((data.metrics.matched / data.metrics.payments) * 100)}% matched automatically` : "No payments yet in this period"}
            />
            <Metric label="Outstanding" value={data.metrics.outstanding} money href="/app/invoices?status=open" foot={`${data.metrics.outstanding_invoices} open invoice${data.metrics.outstanding_invoices === 1 ? "" : "s"}`} />
            <Metric label="Needs review" value={String(data.metrics.needs_attention)} href="/app/exceptions" warn={data.metrics.needs_attention > 0} foot={data.metrics.needs_attention ? <Money value={data.metrics.needs_attention_amount} /> : "All clear"} />
          </Metrics>
          {data.metrics.confirming > 0 && (
            <div className="flex gap-3 rounded-xl bg-info/10 px-4 py-3 text-sm" role="status">
              <Spinner className="mt-0.5 text-info" />
              <div className="grid gap-0.5">
                <strong className="font-semibold">
                  {data.metrics.confirming} payment{data.metrics.confirming === 1 ? "" : "s"} confirming
                </strong>
                <span className="text-foreground/80">Seen on Monad and waiting for the block to be final, usually a couple of seconds.</span>
              </div>
            </div>
          )}
        </>
      )}

      <div className={cn("grid items-start gap-6", data?.needs_attention.length ? "xl:grid-cols-[minmax(0,1fr)_360px]" : "")}>
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
        {/* Only when something is waiting: the tile above already says "All clear" otherwise. */}
        {!!data?.needs_attention.length && (
          <Card
            title="Needs review"
            description="Payments Setra cannot apply automatically"
            actions={
              <ButtonLink href="/app/exceptions" size="sm" variant="ghost">
                Review <ArrowRight />
              </ButtonLink>
            }
          >
            <ExceptionsList rows={data.needs_attention} />
          </Card>
        )}
      </div>
    </div>
  );
}

function SetupChecklist({ setup }: { setup: Overview["setup"] }) {
  const steps = [
    { done: setup.wallets > 0, title: "Connect a receiving wallet", desc: "Add its public Monad address so Setra can monitor incoming and outgoing USDC.", href: "/app/wallets?add=1", cta: "Connect wallet" },
    { done: setup.customers > 0, title: "Add a customer", desc: "A known sender address gives Setra stronger evidence when matching payments.", href: "/app/customers?add=1", cta: "Add customer" },
    { done: setup.invoices > 0, title: "Create your first invoice", desc: "Request USDC on Monad and get a hosted payment page to share.", href: "/app/invoices/new", cta: "Create invoice" },
    { done: setup.payments > 0, title: "Follow a payment into the books", desc: "Inspect the match, blockchain evidence, journal entry and updated invoice.", href: "/app/invoices", cta: "View invoices" }
  ];
  const next = steps.find((s) => !s.done);
  return (
    <Card title="Get set up" description={`${steps.filter((s) => s.done).length} of ${steps.length} done`}>
      <CardBody className="py-1">
        <ol className="grid">
          {steps.map((s) => (
            <li key={s.title} className="grid grid-cols-[26px_1fr] items-center gap-x-3 gap-y-2 border-t py-3 first:border-t-0 sm:grid-cols-[26px_1fr_auto]">
              <span className={cn("grid size-[22px] place-items-center rounded-full", s.done ? "bg-success text-white" : "border-[1.5px] border-dashed border-muted-foreground/40")} aria-label={s.done ? "Done" : "Not done"}>
                {s.done && <Check className="size-3 stroke-[3]" />}
              </span>
              <div>
                <div className={cn("font-semibold", s.done && "text-muted-foreground line-through decoration-muted-foreground/40")}>{s.title}</div>
                <div className="text-sm text-muted-foreground">{s.desc}</div>
              </div>
              {!s.done && s === next && (
                <ButtonLink href={s.href} size="sm" variant="primary" icon={<Plus />} className="col-start-2 justify-self-start sm:col-start-auto">
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
