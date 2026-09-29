"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, ExternalLink, MessageSquareText, RotateCcw, Send, X } from "lucide-react";
import { api, useApi, type ApiError } from "@/lib/api";
import { dateShort, dateTime, money, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useSession } from "./session";
import { Badge, Button, CopyButton, SimulatedTag, useToast } from "./app-ui";
import { AnimatePresence, motion } from "./motion";
import { Seti } from "./seti";

// ── types (mirror of apps/api/src/assistant/blocks.ts) ──────────────────────────────────────────

type Row = [string, string];
type LinkT = { label: string; href: string };
interface InvoiceCard { id: string; number: string; title: string | null; purpose: string | null; customer: string; amount: string; remaining: string; asset: string; network: string; status: string; due_at: string | null; payment_url: string; line_items: Array<{ description: string; quantity: number; amount: string }>; href: string }
interface PaymentCard { id: string; customer: string | null; purpose: string | null; purpose_status: string; invoice: string | null; amount: string; asset: string; network: string; status: string; status_label: string; transaction_hash: string; explorer_url: string | null; received_at: string; simulated: boolean; href: string }
interface ExceptionCard { id: string; type: string; summary: string; amount: string | null; customer: string | null; invoice: string | null; href: string }
type Block =
  | { type: "text"; text: string }
  | { type: "notice"; tone: "info" | "warning" | "danger" | "success"; title: string; text?: string; link?: LinkT }
  | { type: "choice"; prompt: string; options: Array<{ label: string; detail?: string; value: string }> }
  | { type: "confirm"; actionId: string; title: string; rows: Row[]; confirmLabel: string; testMode: boolean; expiresAt: string }
  | { type: "payment_request"; invoice: InvoiceCard; testMode: boolean }
  | { type: "payment"; title: string; tone: "success" | "warning" | "info" | "danger"; payment: PaymentCard; note?: string }
  | { type: "payments"; title: string; items: PaymentCard[]; empty: string; link?: LinkT }
  | { type: "invoices"; title: string; items: InvoiceCard[]; empty: string; total?: string; link?: LinkT }
  | { type: "summary"; title: string; rows: Row[]; highlight: { label: string; value: string }; link?: LinkT; note?: string }
  | { type: "exceptions"; title: string; items: ExceptionCard[]; empty: string; link?: LinkT }
  | { type: "record"; title: string; rows: Row[]; links: LinkT[] };
interface Message { id: string | null; role: "user" | "assistant"; text: string; blocks: Block[]; created_at?: string }

const timezone = () => (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC");

const SUGGESTIONS = [
  "How much profit did we make this month?",
  "How much cash do we have?",
  "What do we owe vendors?",
  "Did Acme Ltd pay?",
  "Create a $250 USDC payment request for Acme Ltd for website development, due Friday",
  "Are the books in order?"
];

// ── drawer state ──────────────────────────────────────────────────────────────────────────────

const AssistantCtx = createContext<{ open: boolean; setOpen: (v: boolean) => void }>({ open: false, setOpen: () => undefined });
export const useAssistant = () => useContext(AssistantCtx);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => setOpen(false), [pathname]);
  return (
    <AssistantCtx.Provider value={{ open, setOpen }}>
      {children}
      <Sheet open={open && pathname !== "/app/assistant"} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 border-l-0 bg-background p-0 shadow-overlay sm:max-w-[480px] [&>button]:hidden">
          <SheetTitle className="sr-only">Seti</SheetTitle>
          <SheetDescription className="sr-only">Create payment requests and ask about your payments.</SheetDescription>
          <AssistantPanel onClose={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </AssistantCtx.Provider>
  );
}

export function AssistantButton() {
  const { setOpen } = useAssistant();
  return (
    <Button variant="secondary" size="sm" onClick={() => setOpen(true)} title="Ask Seti (⌘K)" icon={<MessageSquareText aria-hidden="true" />} aria-label="Ask Seti">
      <span className="max-md:hidden">Ask Seti</span>
      <kbd className="rounded-[5px] bg-foreground/8 px-1.5 font-sans text-[11px] text-muted-foreground max-md:hidden">⌘K</kbd>
    </Button>
  );
}

// ── the conversation ──────────────────────────────────────────────────────────────────────────

export function AssistantPanel({ onClose, full = false }: { onClose?: () => void; full?: boolean }) {
  const { isTest } = useSession();
  const toast = useToast();
  const [conversation, setConversation] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [resolved, setResolved] = useState<Record<string, "confirm" | "cancel">>({});
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api<{ conversation_id: string | null; messages: Message[] }>("/v1/assistant/conversations/latest")
      .then((r) => {
        setConversation(r.conversation_id);
        setMessages(r.messages);
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
    inputRef.current?.focus();
  }, [isTest]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = useCallback(
    async (value: string, choice?: string) => {
      const t = value.trim();
      if (!t || busy) return;
      setBusy(true);
      setText("");
      setMessages((m) => [...m, { id: null, role: "user", text: t, blocks: [] }]);
      try {
        const r = await api<{ conversation_id: string; message: Message }>("/v1/assistant/messages", { method: "POST", body: { text: t, choice, conversation_id: conversation ?? undefined, timezone: timezone() } });
        setConversation(r.conversation_id);
        setMessages((m) => [...m, r.message]);
      } catch (e) {
        setMessages((m) => [...m, { id: null, role: "assistant", text: "", blocks: [{ type: "notice", tone: "danger", title: (e as ApiError).message || "The assistant is unavailable right now." }] }]);
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, conversation]
  );

  const decide = async (actionId: string, decision: "confirm" | "cancel") => {
    setResolved((r) => ({ ...r, [actionId]: decision }));
    setBusy(true);
    try {
      const r = await api<{ message: Message }>(`/v1/assistant/actions/${actionId}`, { method: "POST", body: { decision, conversation_id: conversation ?? undefined, timezone: timezone() } });
      setMessages((m) => [...m, { id: null, role: "user", text: decision === "confirm" ? "Confirm" : "Cancel", blocks: [] }, r.message]);
      if (decision === "confirm" && r.message.blocks.some((b) => b.type === "payment_request")) toast("success", "Payment request created.");
    } catch (e) {
      setResolved((r) => {
        const { [actionId]: _, ...rest } = r;
        return rest;
      });
      toast("error", (e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", full && "min-h-0")}>
      <div className="material flex items-center justify-between gap-3 border-b border-sidebar-border/70 px-[18px] py-3.5">
        <div className="flex items-center gap-2.5">
          <Seti mood={busy ? "focused" : "welcome"} size={38} idle={false} enter={false} key={busy ? "busy" : "idle"} />
          <div className="grid gap-px">
            <strong className="font-semibold">Seti</strong>
            <span className="text-xs text-muted-foreground">{isTest ? "Test mode · Monad testnet" : "Live mode · Monad"}</span>
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw />}
            onClick={() => {
              setConversation(null);
              setMessages([]);
              setResolved({});
            }}
          >
            New
          </Button>
          {onClose && <Button variant="ghost" size="sm" aria-label="Close assistant" icon={<X />} onClick={onClose} className="text-muted-foreground" />}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-[18px]" ref={listRef} aria-live="polite">
        {loaded && messages.length === 0 && (
          <div>
            <div className="mb-4 flex items-end gap-3">
              <Seti mood="welcome" size={92} priority />
              <div className="mb-2 rounded-[18px_18px_18px_6px] bg-card px-3.5 py-2.5 shadow-card">
                <p className="font-semibold">Hi, I&rsquo;m Seti.</p>
                <p className="text-sm text-muted-foreground">What can I help you with today?</p>
              </div>
            </div>
            <p className="mb-3 text-sm text-foreground/80">Create payment requests and ask about your payments in plain language. Anything that creates a record asks you to confirm first.</p>
            <motion.div className="flex flex-wrap gap-1.5" initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } } }}>
              {SUGGESTIONS.map((s) => (
                <motion.div key={s} variants={{ hidden: { opacity: 0, y: 8, scale: 0.96 }, show: { opacity: 1, y: 0, scale: 1 } }}>
                  <Chip onClick={() => send(s)}>{s}</Chip>
                </motion.div>
              ))}
            </motion.div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <motion.div
              key={m.id ?? `u${i}`}
              initial={{ opacity: 0, y: 12, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 380, damping: 28 }}
              style={{ originX: 1, originY: 1 }}
              className="max-w-[85%] self-end rounded-[18px_18px_6px_18px] bg-primary px-3.5 py-2 leading-snug break-words whitespace-pre-wrap text-primary-foreground"
            >
              {m.text}
            </motion.div>
          ) : (
            <motion.div
              key={m.id ?? `a${i}`}
              className="grid min-w-0 gap-2"
              initial="hidden"
              animate="show"
              variants={{ hidden: {}, show: { transition: { staggerChildren: 0.08 } } }}
            >
              {m.blocks.map((b, j) => (
                <motion.div key={j} variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.32, 0.72, 0, 1] } } }}>
                  <BlockView block={b} onChoose={(label, value) => send(label, value === "@text" ? undefined : value)} onDecide={decide} resolved={resolved} busy={busy} />
                </motion.div>
              ))}
            </motion.div>
          )
        )}
        <AnimatePresence>
          {busy && (
            <motion.div className="flex items-end gap-2" aria-label="Setra is working" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
              <Seti mood="focused" size={44} enter={false} />
              <div className="mb-1 flex w-fit gap-1 rounded-full bg-card px-3 py-2.5 shadow-card">
                {[0, 0.15, 0.3].map((d) => (
                  <motion.span key={d} className="size-1.5 rounded-full bg-muted-foreground" animate={{ y: [0, -4, 0], opacity: [0.4, 1, 0.4] }} transition={{ duration: 0.9, delay: d, repeat: Infinity, ease: "easeInOut" }} />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <form
        className="material flex items-end gap-2 border-t border-sidebar-border/70 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <Textarea
          ref={inputRef}
          rows={1}
          maxLength={2000}
          value={text}
          placeholder="Ask about payments or your books, or describe a payment request…"
          aria-label="Message Seti"
          className="max-h-[140px] min-h-[38px] flex-1 resize-none rounded-[19px] px-3.5 py-2"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <Button type="submit" variant="primary" size="sm" icon={<Send />} disabled={!text.trim() || busy} aria-label="Send" />
      </form>
    </div>
  );
}

// ── cards ─────────────────────────────────────────────────────────────────────────────────────

function Chip({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="max-w-full cursor-pointer rounded-full bg-card px-3.5 py-[7px] text-left text-sm text-info shadow-card transition-shadow hover:shadow-raised disabled:cursor-default disabled:opacity-60">
      {children}
    </button>
  );
}

function ACard({ children, tone, className }: { children: ReactNode; tone?: string; className?: string }) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-2 rounded-2xl border border-transparent bg-card px-4 py-3.5 text-sm break-words shadow-card",
        tone === "warning" && "border-warning/35 bg-[color-mix(in_srgb,var(--warning)_6%,var(--card))]",
        tone === "danger" && "border-destructive/35 bg-[color-mix(in_srgb,var(--destructive)_5%,var(--card))]",
        tone === "success" && "border-success/35",
        className
      )}
    >
      {children}
    </div>
  );
}

function CardHead({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-between gap-2">{children}</div>;
}

function Rows({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid">
      {rows.map(([k, v], i) => (
        <div key={i} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2.5 border-t py-[5px]">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const aLink = "text-sm font-medium text-info hover:underline";

function CardLink({ link }: { link?: LinkT }) {
  if (!link) return null;
  return link.href.startsWith("/api/") ? (
    <a className={aLink} href={link.href}>
      {link.label}
    </a>
  ) : (
    <Link className={aLink} href={link.href}>
      {link.label} →
    </Link>
  );
}

function ListRow({ href, title, sub, right, rightSub, subMuted }: { href: string; title: ReactNode; sub: ReactNode; right: ReactNode; rightSub?: ReactNode; subMuted?: boolean }) {
  return (
    <li className="border-t first:border-t-0">
      <Link href={href} className="flex min-w-0 justify-between gap-3 py-[7px]">
        <span className="grid min-w-0">
          <span className="font-medium">{title}</span>
          <span className={cn("truncate text-xs text-muted-foreground", subMuted && "italic")}>{sub}</span>
        </span>
        <span className="grid shrink-0 justify-items-end text-right text-sm">
          <span className="tabular">{right}</span>
          {rightSub && <span className="text-xs text-muted-foreground">{rightSub}</span>}
        </span>
      </Link>
    </li>
  );
}

const TestBadge = () => <Badge tone="warning">Test mode</Badge>;
const Amount = ({ children }: { children: ReactNode }) => <span className="tabular text-2xl font-semibold tracking-[-0.028em]">{children}</span>;

function BlockView({ block: b, onChoose, onDecide, resolved, busy }: { block: Block; onChoose: (label: string, value: string) => void; onDecide: (id: string, d: "confirm" | "cancel") => void; resolved: Record<string, string>; busy: boolean }) {
  switch (b.type) {
    case "text":
      return <p className="break-words">{b.text}</p>;
    case "notice":
      return (
        <ACard tone={b.tone}>
          <strong className="font-semibold">{b.title}</strong>
          {b.text && <p>{b.text}</p>}
          <CardLink link={b.link} />
        </ACard>
      );
    case "choice":
      return (
        <div className="grid gap-2">
          <p>{b.prompt}</p>
          <div className="flex flex-wrap gap-1.5">
            {b.options.map((o, i) => (
              <Chip key={i} onClick={() => onChoose(o.label, o.value)} disabled={busy}>
                {o.label}
                {o.detail && <span className="text-muted-foreground"> · {o.detail}</span>}
              </Chip>
            ))}
          </div>
        </div>
      );
    case "confirm": {
      const done = resolved[b.actionId];
      return (
        <ACard>
          <CardHead>
            <strong className="font-semibold">{b.title}</strong>
            {b.testMode && <TestBadge />}
          </CardHead>
          <Rows rows={b.rows} />
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 pt-0.5">
            {done ? (
              <span className="text-muted-foreground">{done === "confirm" ? "Confirmed" : "Cancelled"}</span>
            ) : (
              <>
                <Button variant="primary" size="sm" onClick={() => onDecide(b.actionId, "confirm")} disabled={busy}>
                  {b.confirmLabel}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onDecide(b.actionId, "cancel")} disabled={busy}>
                  Cancel
                </Button>
              </>
            )}
          </div>
        </ACard>
      );
    }
    case "payment_request": {
      const i = b.invoice;
      return (
        <ACard>
          <CardHead>
            <span className="text-xs font-semibold text-muted-foreground">Payment request · {i.number}</span>
            {b.testMode && <TestBadge />}
          </CardHead>
          <div className="text-[0.9375rem] font-semibold tracking-[-0.015em]">{i.title ?? `Invoice ${i.number}`}</div>
          {i.purpose && <p className="text-muted-foreground">{i.purpose}</p>}
          <Amount>
            {money(i.amount, { currency: false })} <span className="text-sm font-medium text-muted-foreground">{i.asset}</span>
          </Amount>
          <Rows rows={[["For", i.customer], ["Network", i.network], ["Due", i.due_at ? dateShort(i.due_at) : "No due date"]]} />
          <div className="flex min-w-0 items-center gap-1.5 rounded-[10px] bg-muted py-1.5 pr-2 pl-3 text-xs">
            <span className="flex-1 truncate font-mono">{i.payment_url}</span>
            <CopyButton value={i.payment_url} label="Copy payment link" />
            <a className="inline-grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-primary" href={i.payment_url} target="_blank" rel="noreferrer" aria-label="Open payment page">
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </div>
          <Link className={aLink} href={i.href}>
            View invoice →
          </Link>
        </ACard>
      );
    }
    case "payment": {
      const p = b.payment;
      return (
        <ACard tone={b.tone}>
          <CardHead>
            <strong className="font-semibold">{b.title}</strong>
            {p.simulated && <SimulatedTag />}
          </CardHead>
          <div className="font-semibold">
            {p.customer ?? "Unknown sender"} {p.status === "confirming" ? "is paying" : "paid"} {money(p.amount, { currency: false })} {p.asset}
          </div>
          <Rows
            rows={[
              ["For", p.purpose ?? "Purpose unknown"],
              ["Invoice", p.invoice ?? "Not applied"],
              ["Status", p.status_label],
              ["Network", p.network],
              ["Transaction", p.simulated ? "Simulated, no transaction" : `${p.transaction_hash.slice(0, 10)}…${p.transaction_hash.slice(-6)}`],
              ["Received", dateTime(p.received_at)]
            ]}
          />
          {b.note && <p className="text-xs text-muted-foreground">{b.note}</p>}
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 pt-0.5">
            <Link className={aLink} href={p.href}>
              View payment in Setra →
            </Link>
            {p.explorer_url && (
              <a className={aLink} href={p.explorer_url} target="_blank" rel="noreferrer">
                Explorer
              </a>
            )}
          </div>
        </ACard>
      );
    }
    case "payments":
      return (
        <ACard>
          <strong className="font-semibold">{b.title}</strong>
          {b.items.length === 0 ? (
            <p className="text-muted-foreground">{b.empty}</p>
          ) : (
            <ul className="grid">
              {b.items.map((p) => (
                <ListRow key={p.id} href={p.href} title={p.customer ?? "Unknown sender"} sub={p.purpose ?? "Purpose unknown"} subMuted={!p.purpose} right={money(p.amount)} rightSub={`${p.status_label} · ${timeAgo(p.received_at)}`} />
              ))}
            </ul>
          )}
          <CardLink link={b.link} />
        </ACard>
      );
    case "invoices":
      return (
        <ACard>
          <strong className="font-semibold">{b.title}</strong>
          {b.items.length === 0 ? (
            <p className="text-muted-foreground">{b.empty}</p>
          ) : (
            <ul className="grid">
              {b.items.map((i) => (
                <ListRow
                  key={i.id}
                  href={i.href}
                  title={
                    <>
                      <span className="font-mono">{i.number}</span> · {i.customer}
                    </>
                  }
                  sub={i.title ?? "No purpose recorded"}
                  right={money(i.remaining)}
                  rightSub={i.due_at ? `Due ${dateShort(i.due_at)}` : i.status.replace("_", " ")}
                />
              ))}
            </ul>
          )}
          {b.total && <div className="border-t pt-1.5 font-semibold">{b.total}</div>}
          <CardLink link={b.link} />
        </ACard>
      );
    case "summary":
      return (
        <ACard>
          <strong className="font-semibold">{b.title}</strong>
          <div className="grid gap-0.5">
            <span className="text-muted-foreground">{b.highlight.label}</span>
            <Amount>{b.highlight.value}</Amount>
          </div>
          <Rows rows={b.rows} />
          {b.note && <p className="text-xs text-muted-foreground">{b.note}</p>}
          <CardLink link={b.link} />
        </ACard>
      );
    case "exceptions":
      return (
        <ACard>
          <strong className="font-semibold">{b.title}</strong>
          {b.items.length === 0 ? (
            <p className="text-muted-foreground">{b.empty}</p>
          ) : (
            <ul className="grid">
              {b.items.map((e) => (
                <ListRow key={e.id} href={e.href} title={e.summary} sub={[e.customer ?? "Unknown sender", e.invoice].filter(Boolean).join(" · ")} right={e.amount ?? ""} />
              ))}
            </ul>
          )}
          <CardLink link={b.link} />
        </ACard>
      );
    case "record":
      return (
        <ACard>
          <strong className="font-semibold">{b.title}</strong>
          <Rows rows={b.rows} />
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 pt-0.5">
            {b.links.map((l) => (
              <CardLink key={l.href} link={l} />
            ))}
          </div>
        </ACard>
      );
  }
}

// ── notifications ─────────────────────────────────────────────────────────────────────────────

interface Note { id: string; kind: string; tone: string; title: string; headline: string; rows: Row[]; note: string | null; href: string; test_mode: boolean; unread: boolean; created_at: string }

const noteBar: Record<string, string> = { success: "border-l-success", warning: "border-l-warning", danger: "border-l-destructive", info: "border-l-info" };

export function NotificationsBell() {
  const toast = useToast();
  const { data, mutate } = useApi<{ unread: number; data: Note[] }>("/v1/notifications?limit=20", { refreshInterval: 5000 });
  const [open, setOpen] = useState(false);
  const [ring, setRing] = useState(0);
  const known = useRef<Set<string> | null>(null);

  // A toast for each new payment event that arrives while the console is open.
  useEffect(() => {
    if (!data) return;
    if (known.current === null) {
      known.current = new Set(data.data.map((n) => n.id));
      return;
    }
    for (const n of [...data.data].reverse()) {
      if (!known.current.has(n.id)) {
        known.current.add(n.id);
        setRing((r) => r + 1);
        toast(n.tone === "success" ? "success" : "info", `${n.title}: ${n.headline}`);
      }
    }
  }, [data, toast]);

  const onOpenChange = async (next: boolean) => {
    setOpen(next);
    if (next && data?.unread) {
      await api("/v1/notifications/seen", { method: "POST" }).catch(() => undefined);
      void mutate();
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative"
          aria-label={`Notifications${data?.unread ? `, ${data.unread} new` : ""}`}
          icon={
            <motion.span key={ring} className="inline-flex origin-top" animate={ring ? { rotate: [0, 16, -12, 8, -4, 0] } : undefined} transition={{ duration: 0.8, ease: "easeOut" }}>
              <Bell aria-hidden="true" />
            </motion.span>
          }
        >
          <AnimatePresence>
            {!!data?.unread && (
              <motion.span
                key={data.unread}
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 22 }}
                className="absolute top-0.5 right-0.5 h-4 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] leading-4 font-bold text-white"
              >
                {data.unread > 9 ? "9+" : data.unread}
              </motion.span>
            )}
          </AnimatePresence>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="material max-h-[70vh] w-[min(400px,calc(100vw-32px))] overflow-y-auto p-0" aria-label="Payment notifications">
        <div className="border-b border-sidebar-border/70 px-4 py-3.5">
          <strong className="font-semibold">Payment notifications</strong>
        </div>
        {!data?.data.length ? (
          <div className="grid justify-items-center gap-2 px-6 py-8 text-center">
            <Seti mood="resting" size={80} />
            <p className="text-sm text-muted-foreground">All quiet. When money arrives, you&rsquo;ll see who paid, how much and what it was for here.</p>
          </div>
        ) : (
          <ul>
            {data.data.map((n) => (
              <li key={n.id} className={cn("border-t border-sidebar-border/70 first:border-t-0", n.unread && "bg-primary/6")}>
                <Link href={n.href} onClick={() => setOpen(false)} className={cn("grid gap-[3px] border-l-[3px] border-l-transparent px-4 py-3 text-sm", noteBar[n.tone])}>
                  <div className="flex justify-between gap-2">
                    <strong className="font-semibold">{n.title}</strong>
                    <span className="text-xs whitespace-nowrap text-muted-foreground">{timeAgo(n.created_at)}</span>
                  </div>
                  <div className="font-semibold">
                    {n.headline}
                    {n.test_mode && (
                      <Badge tone="neutral" dot={false} className="ml-1.5 h-5 rounded-md px-1.5 text-[11px]">
                        Test
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-foreground/80">
                    {n.rows.slice(0, 3).map(([k, v]) => (
                      <span key={k}>
                        <span className="text-muted-foreground">{k}:</span> {v}
                      </span>
                    ))}
                  </div>
                  {n.note && <div className="text-xs text-muted-foreground">{n.note}</div>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
