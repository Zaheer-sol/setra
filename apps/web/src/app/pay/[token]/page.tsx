"use client";

import nextDynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { createPublicClient, createWalletClient, custom, defineChain, http, type Address, type EIP1193Provider, type Hex } from "viem";
import { AlertCircle, CheckCircle2, Clock, ExternalLink, FlaskConical, Lock, Mail, QrCode, Wallet, XCircle } from "lucide-react";
import { ERC20_ABI_MIN, PAYMENT_INTENT_PAY_ABI } from "@/lib/abi";
import { useApi } from "@/lib/api";
import { useInjectedWallets, type InjectedWallet } from "@/lib/browser-wallets";
import { dateShort, money, moneyParts, shortAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ChainMark, LineItems, Segmented, Spinner } from "@/components/app-ui";
import { CountUp, EASE, motion } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

interface PublicView {
  merchant: { name: string; support_email: string | null };
  invoice: { number: string; title: string | null; purpose: string | null; line_items: Array<{ description: string; quantity: number; unit_amount: string; amount: string }>; customer_name: string; currency: string; amount_due: string; tax_amount?: string; amount_paid: string; amount_remaining: string; amount_confirming: string; due_at: string | null; expires_at: string | null; paid_at: string | null };
  state: "awaiting_payment" | "confirming" | "partially_paid" | "paid" | "overpaid" | "expired" | "cancelled";
  test_mode: boolean;
  pay: {
    network: { name: string; family: string; chain_id: number; testnet: boolean; explorer_url: string | null; native_symbol: string; rpc_url: string };
    asset: { symbol: string; name: string; address: Address; decimals: number };
    recipient: Address;
    amount: string;
    amount_base_units: string;
    payment_intents: { contract_address: Address } | null;
  };
  payments: Array<{ amount: string; status: string; transaction_hash: string | null; explorer_url: string | null; simulated: boolean; paid_at: string }>;
}

async function publicCall<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store"
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? "Something went wrong. Please try again.");
  return data as T;
}

export default function PayPage() {
  const { token } = useParams<{ token: string }>();
  const { data, error, mutate } = useApi<PublicView>(`/v1/public/payment-requests/${token}`, {
    refreshInterval: (d) => (d && ["paid", "overpaid", "cancelled", "expired"].includes(d.state) ? 0 : 2000),
    shouldRetryOnError: false
  });

  if (error) {
    return (
      <PayFrame>
        <div className={cn(cardCls, "grid justify-items-center gap-2.5 text-center")}>
          <XCircle className="size-7 text-muted-foreground" aria-hidden="true" />
          <h1 className={titleCls}>Payment link not found</h1>
          <p className="text-muted-foreground">This link is incorrect or no longer exists. Check the link you were sent, or contact the merchant for a new one.</p>
        </div>
      </PayFrame>
    );
  }
  if (!data) {
    return (
      <PayFrame>
        <div className={cardCls} aria-busy="true" aria-label="Loading payment request">
          <Skeleton className="h-3.5 w-[40%]" />
          <Skeleton className="mt-[18px] h-10 w-[60%]" />
          <Skeleton className="mt-7 h-[120px] w-full" />
        </div>
      </PayFrame>
    );
  }
  return (
    <PayFrame testMode={data.test_mode}>
      <PayCard view={data} token={token} refresh={() => mutate()} />
    </PayFrame>
  );
}

function PayFrame({ children, testMode }: { children: React.ReactNode; testMode?: boolean }) {
  return (
    <div className="min-h-screen bg-background">
      {testMode && (
        <div className="flex items-center justify-center gap-2 border-b border-warning/25 bg-warning/10 px-4 py-2 text-center text-sm font-medium text-warning" role="note">
          <FlaskConical className="size-3.5 shrink-0" aria-hidden="true" /> Test payment page on Monad testnet. No real funds are requested.
        </div>
      )}
      <main id="main" className="mx-auto max-w-[480px] px-4 pt-14 pb-12 max-sm:pt-5">
        {children}
        <p className="mt-5 text-center text-xs leading-relaxed text-muted-foreground">
          <Lock className="mr-1 inline size-3 align-[-2px]" aria-hidden="true" /> Payments go directly to the merchant&rsquo;s wallet. Powered by{" "}
          <a href="/?from=payment-page" target="_blank" rel="noopener" className="font-semibold text-foreground/70 hover:underline">
            Setra
          </a>
        </p>
      </main>
    </div>
  );
}

function PayCard({ view, token, refresh }: { view: PublicView; token: string; refresh: () => void }) {
  const { invoice, pay, state } = view;
  const settled = state === "paid" || state === "overpaid";
  const [whole, cents] = moneyParts(settled ? invoice.amount_paid : state === "partially_paid" ? invoice.amount_remaining : invoice.amount_due);
  const latest = view.payments[view.payments.length - 1];
  useEffect(() => {
    document.title = `Pay ${view.merchant.name} · ${invoice.number}`;
  }, [view.merchant.name, invoice.number]);

  return (
    <div className="[perspective:1400px]">
    <div className={cn(cardCls, "animate-in slide-in-from-bottom-4 duration-500 motion-reduce:animate-none")}>
      <div className="flex items-center gap-3 border-b pb-5">
        <span className="grid size-10 place-items-center rounded-[11px] bg-gradient-to-b from-[#2997ff] to-[#0071e3] text-[17px] font-bold text-white" aria-hidden="true">
          {view.merchant.name.slice(0, 1)}
        </span>
        <div>
          <div className="text-[0.9375rem] font-semibold tracking-[-0.015em]">{view.merchant.name}</div>
          <div className="text-sm text-muted-foreground">
            Invoice <span className="font-mono text-[0.92em]">{invoice.number}</span>
          </div>
        </div>
      </div>

      {settled ? (
        <div className="grid justify-items-center gap-1.5 pt-7 pb-2 text-center" role="status">
          <SuccessMark />
          <h1 className={titleCls}>Payment received</h1>
          <Amount whole={whole} cents={cents} unit={pay.asset.symbol} />
          {invoice.title && <p className="mt-1.5 font-medium text-foreground/80">for {invoice.title}</p>}
          <p className="text-muted-foreground">You&rsquo;re all set. {view.merchant.name} has been notified.</p>
          {state === "overpaid" && <p className="mt-1.5 rounded-xl bg-primary/10 px-3.5 py-2.5 text-sm text-info">You paid more than the amount due. {view.merchant.name} will follow up about the difference.</p>}
          {latest?.explorer_url && (
            <Button asChild variant="secondary" size="sm" className="mt-3.5">
              <a href={latest.explorer_url} target="_blank" rel="noreferrer noopener">
                View transaction <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          )}
          {latest?.simulated && <p className="mt-2.5 text-xs text-muted-foreground">Simulated test payment. No funds moved.</p>}
        </div>
      ) : state === "cancelled" || state === "expired" ? (
        <div className="grid justify-items-center gap-2.5 pt-7 pb-2 text-center">
          {state === "cancelled" ? <XCircle className="size-7 text-muted-foreground" aria-hidden="true" /> : <Clock className="size-7 text-muted-foreground" aria-hidden="true" />}
          <h1 className={titleCls}>{state === "cancelled" ? "This payment request was cancelled" : "This payment request has expired"}</h1>
          {invoice.title && <p className="font-medium text-foreground/80">{invoice.title}</p>}
          <p className="text-muted-foreground">Please don&rsquo;t send funds to this request. Contact {view.merchant.name}{view.merchant.support_email ? ` at ${view.merchant.support_email}` : ""} for a new link.</p>
        </div>
      ) : (
        <>
          <div className="pt-[22px] pb-1.5">
            <h1 className="m-0 text-[1.375rem] leading-tight font-semibold tracking-[-0.022em] break-words">{invoice.title ?? `Invoice ${invoice.number}`}</h1>
            {invoice.purpose && <p className="mt-1.5 text-foreground/80">{invoice.purpose}</p>}
            {invoice.line_items.length > 0 && (
              <div aria-label="What you are paying for" className="mt-3.5">
                <LineItems className="mt-0" items={invoice.line_items} total={invoice.amount_due} />
              </div>
            )}
            <div className="mt-[18px] text-sm text-muted-foreground">{state === "partially_paid" ? "Remaining balance" : "Amount due"}</div>
            <Amount whole={whole} cents={cents} />
            {Number(invoice.tax_amount ?? 0) > 0 && <div className="mt-1 text-sm text-muted-foreground">Includes {money(invoice.tax_amount!)} tax</div>}
            <dl className="mt-4 flex flex-wrap gap-6">
              <div>
                <dt className="text-xs text-muted-foreground">Billed to</dt>
                <dd className="mt-0.5 font-medium">{invoice.customer_name}</dd>
              </div>
              {invoice.due_at && (
                <div>
                  <dt className="text-xs text-muted-foreground">Due</dt>
                  <dd className="mt-0.5 font-medium">{dateShort(invoice.due_at)}</dd>
                </div>
              )}
              {state === "partially_paid" && (
                <div>
                  <dt className="text-xs text-muted-foreground">Paid so far</dt>
                  <dd className="mt-0.5 font-medium">{money(invoice.amount_paid)}</dd>
                </div>
              )}
            </dl>
          </div>

          {state === "confirming" ? (
            <div className={cn(confirmingCls, "mt-5")} role="status" aria-live="polite">
              <Spinner className="mt-[3px] text-info" />
              <div>
                <strong className="font-semibold">Payment detected</strong>
                <div className="text-sm text-muted-foreground">
                  {money(invoice.amount_confirming)} {pay.asset.symbol} seen on {pay.network.name}. Confirming, which takes about a second.
                </div>
              </div>
            </div>
          ) : (
            <PaymentMethods view={view} token={token} refresh={refresh} />
          )}
        </>
      )}
    </div>
    </div>
  );
}

const cardCls = "rounded-[28px] bg-card p-8 text-card-foreground shadow-raised max-sm:rounded-[22px] max-sm:p-[22px]";
const titleCls = "text-[1.625rem] font-bold tracking-[-0.028em]";
const confirmingCls = "flex items-start gap-3 rounded-2xl bg-info/10 px-4 py-3.5";
const stepCls = "text-sm font-semibold text-muted-foreground";
const fieldLabelCls = "mb-1 text-xs text-muted-foreground";
const errorCls = "mt-2.5 flex items-start gap-1.5 text-sm text-destructive";

function Amount({ whole, cents, unit }: { whole: string; cents: string; unit?: string }) {
  const n = Number(`${whole}${cents}`.replace(/[^\d.-]/g, ""));
  return (
    <div className="tabular mt-1 text-5xl leading-[1.1] font-semibold tracking-[-0.035em] max-sm:text-[2.4rem]">
      {Number.isFinite(n) ? (
        <CountUp
          value={n}
          duration={0.9}
          format={(x) => {
            const [w, c] = moneyParts(x.toFixed(2));
            return (
              <>
                {w}
                <span className="text-muted-foreground/70">{c}</span>
              </>
            );
          }}
        />
      ) : (
        <>
          {whole}
          <span className="text-muted-foreground/70">{cents}</span>
        </>
      )}
      {unit && <span className="ml-1.5 text-[1.3rem] font-medium tracking-[-0.01em] text-muted-foreground">{unit}</span>}
    </div>
  );
}

/** The "payment received" mark: a green disc springs in, the check draws itself, two soft ripples spread. */
function SuccessMark() {
  return (
    <div className="relative mb-2.5 grid size-16 place-items-center">
      {[0, 0.35].map((d) => (
        <motion.span
          key={d}
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-success/25"
          initial={{ scale: 0.8, opacity: 0.7 }}
          animate={{ scale: 2.1, opacity: 0 }}
          transition={{ duration: 1.6, delay: 0.35 + d, ease: "easeOut" }}
        />
      ))}
      <motion.div
        className="relative grid size-16 place-items-center rounded-full bg-[#34c759] text-white shadow-[0_8px_24px_rgba(52,199,89,0.35)]"
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 16 }}
      >
        <svg viewBox="0 0 24 24" className="size-[28px]" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <motion.path d="M5 12.5l4.5 4.5L19 7.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.5, delay: 0.25, ease: EASE }} />
        </svg>
      </motion.div>
    </div>
  );
}

function PaymentMethods({ view, token, refresh }: { view: PublicView; token: string; refresh: () => void }) {
  const [method, setMethod] = useState<"wallet" | "manual">("wallet");
  const { pay } = view;
  return (
    <div className="mt-5 border-t pt-5">
      <div className="grid grid-cols-2 gap-2.5">
        <div className="grid gap-[3px] rounded-[14px] bg-muted px-3.5 py-3 text-sm">
          <span className="text-muted-foreground">Pay with</span>
          <strong className="font-semibold">{pay.asset.symbol}</strong>
        </div>
        <div className="grid gap-[3px] rounded-[14px] bg-muted px-3.5 py-3 text-sm">
          <span className="text-muted-foreground">Network</span>
          <strong className="flex items-center gap-1.5 font-semibold">
            <ChainMark /> {pay.network.name}
          </strong>
        </div>
      </div>
      <Segmented
        className="mt-4 [&_[role=tablist]]:w-full"
        label="Payment method"
        value={method}
        onChange={setMethod}
        options={[
          { value: "wallet", label: <><Wallet className="size-3.5" aria-hidden="true" /> Browser wallet</> },
          { value: "manual", label: <><QrCode className="size-3.5" aria-hidden="true" /> Send manually</> }
        ]}
      />
      {/* Rendered at once with a CSS slide and no fade: wallet browsers and battery saver throttle animations, which left the card blank. */}
      <div key={method} className="animate-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none">
        {method === "wallet" ? <WalletCheckout view={view} token={token} onSubmitted={refresh} /> : <ManualInstructions view={view} />}
      </div>
      {view.test_mode && <SimulateButton token={token} onDone={refresh} />}
    </div>
  );
}

// Pay with just an email (Dynamic embedded wallets), when a Dynamic environment is configured.
const DYNAMIC_ENV = process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID;
const EmailWallet = nextDynamic(() => import("./email-wallet"), { ssr: false });

type Stage = { kind: "idle" } | { kind: "working"; label: string } | { kind: "submitted"; hash: Hex } | { kind: "error"; message: string };

function friendlyError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; code?: number };
  const message = err.shortMessage ?? err.message ?? "The payment didn't go through.";
  if (err.code === 4001 || /reject|denied|cancel/i.test(message)) return "You cancelled the request in your wallet. No funds moved.";
  if (err.code === -32002 || /already pending/i.test(message)) return "Your wallet already has a request waiting. Open the wallet extension and approve or reject it.";
  return message;
}

function WalletCheckout({ view, token, onSubmitted }: { view: PublicView; token: string; onSubmitted: () => void }) {
  const { pay } = view;
  const wallets = useInjectedWallets();
  const [selected, setSelected] = useState<InjectedWallet | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [emailOpen, setEmailOpen] = useState(false);
  const onEmailWallet = useCallback((w: { id: string; name: string; address: Address; provider: EIP1193Provider }) => {
    setSelected({ id: w.id, name: w.name, provider: w.provider });
    setAccount(w.address);
    setEmailOpen(false);
    setStage({ kind: "idle" });
  }, []);
  const onEmailClosed = useCallback(() => setEmailOpen(false), []);
  const chain = useMemo(
    () =>
      defineChain({
        id: pay.network.chain_id,
        name: pay.network.name,
        nativeCurrency: { name: pay.network.native_symbol, symbol: pay.network.native_symbol, decimals: 18 },
        rpcUrls: { default: { http: [pay.network.rpc_url] } },
        blockExplorers: pay.network.explorer_url ? { default: { name: "Explorer", url: pay.network.explorer_url } } : undefined,
        testnet: pay.network.testnet
      }),
    [pay.network]
  );
  const busy = stage.kind === "working";

  const connect = async (w: InjectedWallet) => {
    setSelected(w);
    setStage({ kind: "working", label: `Waiting for ${w.name}. Approve the connection in the wallet window…` });
    try {
      const accounts = (await w.provider.request({ method: "eth_requestAccounts" })) as Address[];
      if (!accounts?.[0]) throw new Error("No account was shared. Unlock the wallet and try again.");
      setAccount(accounts[0]);
      setStage({ kind: "idle" });
    } catch (e) {
      setStage({ kind: "error", message: friendlyError(e) });
    }
  };

  const payNow = async () => {
    if (!selected || !account) return;
    try {
      const wallet = createWalletClient({ account, chain, transport: custom(selected.provider) });
      const publicClient = createPublicClient({ chain, transport: http(pay.network.rpc_url) });
      if ((await wallet.getChainId()) !== chain.id) {
        setStage({ kind: "working", label: `Approve switching to ${pay.network.name} in your wallet…` });
        try {
          await wallet.switchChain({ id: chain.id });
        } catch (e) {
          if ((e as { code?: number }).code === 4001) throw e;
          await wallet.addChain({ chain });
          await wallet.switchChain({ id: chain.id });
        }
      }
      setStage({ kind: "working", label: "Checking your balance…" });
      const amount = BigInt(pay.amount_base_units);
      const balance = await publicClient.readContract({ address: pay.asset.address, abi: ERC20_ABI_MIN, functionName: "balanceOf", args: [account] });
      if (balance < amount && selected.id === "dynamic")
        throw new Error(`Your email wallet (${account}) doesn't have enough ${pay.asset.symbol} yet. Add ${money(pay.amount, { currency: false })} ${pay.asset.symbol} on ${pay.network.name} to it from an exchange or another wallet, plus a little ${pay.network.native_symbol} for the network fee, then press Pay again.`);
      if (balance < amount) throw new Error(`${shortAddress(account)} has ${money((Number(balance) / 10 ** pay.asset.decimals).toFixed(pay.asset.decimals), { currency: false })} ${pay.asset.symbol} on ${pay.network.name}, which isn't enough.`);

      let hash: Hex;
      if (pay.payment_intents) {
        // Structured payment: the reference travels inside the transaction, so matching is certain.
        setStage({ kind: "working", label: "Preparing payment…" });
        const intent = await publicCall<{ contract_address: Address; terms: { merchant: Address; token: Address; amount: string; expires_at: number; ref: Hex } }>(`/v1/public/payment-requests/${token}/intent`, "POST");
        const terms = { merchant: intent.terms.merchant, token: intent.terms.token, amount: BigInt(intent.terms.amount), expiresAt: BigInt(intent.terms.expires_at), ref: intent.terms.ref };
        const allowance = await publicClient.readContract({ address: pay.asset.address, abi: ERC20_ABI_MIN, functionName: "allowance", args: [account, intent.contract_address] });
        if (allowance < terms.amount) {
          setStage({ kind: "working", label: `Step 1 of 2: approve ${pay.asset.symbol} in your wallet…` });
          const approval = await wallet.writeContract({ account, chain, address: pay.asset.address, abi: ERC20_ABI_MIN, functionName: "approve", args: [intent.contract_address, terms.amount] });
          setStage({ kind: "working", label: "Waiting for the approval to confirm…" });
          await publicClient.waitForTransactionReceipt({ hash: approval });
        }
        setStage({ kind: "working", label: `${allowance < terms.amount ? "Step 2 of 2: c" : "C"}onfirm the payment in your wallet…` });
        hash = await wallet.writeContract({ account, chain, address: intent.contract_address, abi: PAYMENT_INTENT_PAY_ABI, functionName: "pay", args: [terms] });
      } else {
        setStage({ kind: "working", label: "Confirm the transfer in your wallet…" });
        hash = await wallet.writeContract({ account, chain, address: pay.asset.address, abi: ERC20_ABI_MIN, functionName: "transfer", args: [pay.recipient, amount] });
      }
      setStage({ kind: "submitted", hash });
      onSubmitted();
    } catch (e) {
      setStage({ kind: "error", message: friendlyError(e) });
    }
  };

  if (wallets === null)
    return (
      <div className="mt-4">
        <Skeleton className="h-11 rounded-full" />
      </div>
    );
  const emailOption = DYNAMIC_ENV ? (
    <>
      <Button size="lg" className="w-full" variant="outline" onClick={() => setEmailOpen(true)} disabled={busy || emailOpen}>
        {emailOpen ? <Spinner /> : <Mail aria-hidden="true" />}
        Pay with email, no wallet needed
      </Button>
      <EmailWallet
        environmentId={DYNAMIC_ENV}
        network={{ chainId: pay.network.chain_id, name: pay.network.name, rpcUrl: pay.network.rpc_url, explorerUrl: pay.network.explorer_url ?? null, nativeSymbol: pay.network.native_symbol }}
        open={emailOpen}
        onWallet={onEmailWallet}
        onClosed={onEmailClosed}
      />
    </>
  ) : null;

  if (wallets.length === 0 && !emailOption) {
    return (
      <div className="mt-4">
        <p className="text-sm text-muted-foreground">
          No browser wallet found. Install or enable a wallet extension and reload, open this page in your wallet app&rsquo;s browser, or choose <strong>Send manually</strong>.
        </p>
      </div>
    );
  }

  if (stage.kind === "submitted") {
    return (
      <div className="mt-4">
        <div className={confirmingCls} role="status">
          <Spinner className="mt-[3px] text-info" />
          <div>
            <strong className="font-semibold">Payment sent</strong>
            <div className="text-sm text-muted-foreground">
              Waiting for {pay.network.name}…{" "}
              {pay.network.explorer_url && (
                <a className="font-medium text-primary hover:underline" href={`${pay.network.explorer_url}/tx/${stage.hash}`} target="_blank" rel="noreferrer">
                  {shortAddress(stage.hash)}
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 grid gap-3">
      {!account ? (
        <>
          <div className={stepCls}>Step 1: connect the wallet you&rsquo;ll pay from</div>
          {emailOption}
          {wallets.map((w) => (
            <Button key={w.id} size="lg" className="w-full" onClick={() => connect(w)} disabled={busy}>
              {busy && selected?.id === w.id ? <Spinner /> : w.icon ? <img src={w.icon} alt="" width={18} height={18} className="rounded" /> : <Wallet aria-hidden="true" />}
              Connect {w.name}
            </Button>
          ))}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2.5 rounded-[14px] bg-success/12 px-3.5 py-3 text-sm font-medium">
            <span className="flex min-w-0 items-center gap-2">
              {selected?.icon ? <img src={selected.icon} alt="" width={16} height={16} className="rounded" /> : <Wallet className="size-4" aria-hidden="true" />}
              <span className="truncate">
                {selected?.name} · <span className="font-mono text-[0.92em]">{shortAddress(account)}</span>
              </span>
            </span>
            <button
              className="cursor-pointer text-sm font-medium text-primary hover:underline"
              onClick={() => {
                setAccount(null);
                setStage({ kind: "idle" });
              }}
              disabled={busy}
            >
              Change
            </button>
          </div>
          <div className={stepCls}>Step 2: pay</div>
          <Button size="lg" className="w-full" onClick={payNow} disabled={busy} aria-busy={busy}>
            {busy ? <Spinner /> : <Wallet aria-hidden="true" />}
            {`Pay ${money(pay.amount, { currency: false })} ${pay.asset.symbol}`}
          </Button>
        </>
      )}
      {stage.kind === "working" && (
        <div className="rounded-xl bg-info/10 px-3 py-2.5 text-sm text-info" role="status">
          <span>{stage.label}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Nothing happening? Open your wallet extension to find the request, or{" "}
            <button className="cursor-pointer font-medium text-primary hover:underline" onClick={() => setStage({ kind: "idle" })}>
              start over
            </button>
            . No funds move until you confirm in your wallet.
          </span>
        </div>
      )}
      {stage.kind === "error" && (
        <p className={errorCls} role="alert">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> {stage.message}
        </p>
      )}
      <p className="text-center text-xs text-muted-foreground">
        {pay.payment_intents ? "Your wallet will ask you to approve and confirm. " : "Your wallet will ask you to switch to " + pay.network.name + " and confirm one transfer. "}Funds go straight to {view.merchant.name}&rsquo;s wallet.
      </p>
    </div>
  );
}

function ManualInstructions({ view }: { view: PublicView }) {
  const { pay } = view;
  const [qr, setQr] = useState<string | null>(null);
  // EIP-681 transfer request, understood by most mobile wallets.
  const uri = `ethereum:${pay.asset.address}@${pay.network.chain_id}/transfer?address=${pay.recipient}&uint256=${pay.amount_base_units}`;
  useEffect(() => {
    QRCode.toDataURL(uri, { margin: 1, width: 360, color: { dark: "#1d1d1f", light: "#ffffff" } }).then(setQr).catch(() => setQr(null));
  }, [uri]);
  return (
    <div className="mt-4">
      <p className="mb-3 text-sm text-muted-foreground">
        Send the payment from any wallet or exchange yourself. Scan the code with a mobile wallet, or copy the details below. This page updates automatically when the payment arrives.
      </p>
      <div className="grid items-start gap-4 sm:grid-cols-[148px_minmax(0,1fr)] max-sm:justify-items-center">
        {qr && <img src={qr} alt={`QR code to pay ${pay.amount} ${pay.asset.symbol}`} width={148} height={148} className="rounded-[14px] shadow-card [image-rendering:pixelated]" />}
        <div className="grid w-full min-w-0 gap-3">
          <Copyable label="1. Send exactly" value={`${money(pay.amount, { currency: false })} ${pay.asset.symbol}`} copyValue={pay.amount} />
          <Copyable label="2. To this address" value={pay.recipient} mono />
          <div>
            <div className={fieldLabelCls}>3. On this network</div>
            <div className="flex items-center gap-1.5 font-semibold">
              <ChainMark />
              {pay.network.name} <span className="font-normal text-muted-foreground">(chain {pay.network.chain_id})</span>
            </div>
          </div>
          <Copyable label={`${pay.asset.symbol} token contract`} value={pay.asset.address} mono />
        </div>
      </div>
      <Button asChild variant="secondary" className="mt-3.5 w-full">
        <a href={uri}>
          <Wallet aria-hidden="true" /> Open in wallet app
        </a>
      </Button>
      <p className="mt-3.5 rounded-xl bg-warning/10 px-3 py-2.5 text-xs text-warning">
        Send {pay.asset.symbol} on {pay.network.name} only. Other tokens or networks won&rsquo;t be credited automatically.
      </p>
    </div>
  );
}

function Copyable({ label, value, copyValue, mono }: { label: string; value: string; copyValue?: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="min-w-0">
      <div className={fieldLabelCls}>{label}</div>
      <button
        type="button"
        className={cn("flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-xl bg-muted px-3 py-2.5 font-semibold transition-colors hover:bg-accent", mono && "font-mono text-xs font-medium")}
        onClick={async () => {
          await navigator.clipboard.writeText(copyValue ?? value).catch(() => undefined);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }}
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{value}</span>
        {done ? <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" /> : <span className="font-sans text-[11px] text-muted-foreground">Copy</span>}
      </button>
    </div>
  );
}

function SimulateButton({ token, onDone }: { token: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-[18px] border-t pt-3.5 text-center">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto min-h-8 text-xs whitespace-normal text-muted-foreground"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await publicCall(`/v1/public/payment-requests/${token}/simulate`, "POST");
            onDone();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner /> : <FlaskConical aria-hidden="true" />} Simulate a test payment (no funds move)
      </Button>
      {error && <p className={errorCls}>{error}</p>}
    </div>
  );
}
