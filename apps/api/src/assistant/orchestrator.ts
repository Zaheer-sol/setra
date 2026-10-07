import type { FastifyInstance } from "fastify";
import { appEnv } from "@setra/config";
import { withTenant } from "@setra/database";
import { newId } from "@setra/schemas";
import { ASSISTANT_TOKEN } from "../lib/internal";
import type { Permission } from "../lib/principal";
import type { Block, InvoiceCard, Link, PaymentCard, Row } from "./blocks";
import { applyFinancialAction, financial } from "./financial-intents";
import { understand, type ConversationTurn } from "./language-model";
import { pick, speak } from "./voice";
import { clean, findAmount, normalizeAmount, parseIntent, periodStart, resolveDue, titleCase, type Intent, type Period } from "./intent-parser";

/**
 * The Setra Assistant's orchestrator. It turns an intent into calls to Setra's own API, made
 * in-process as the signed-in user (same session, role, workspace and test/live mode), and turns the
 * answers into cards. It holds no business logic of its own: matching, balances, statuses and totals
 * all come from the API. Anything that creates or changes a financial record becomes a pending action
 * that the user must confirm; confirmation replays the API call with the action id as its
 * Idempotency-Key, so a double click can't create two payment requests.
 */

type Any = Record<string, any>;

export interface Draft {
  amount?: string;
  asset?: string;
  customerId?: string;
  customerName?: string;
  newCustomer?: string;
  purpose?: string;
  dueAt?: string | null;
  dueNote?: string;
  loose?: string;
}

export type Pending =
  | { awaiting: "create"; missing: "customer" | "amount" | "purpose" | "asset"; draft: Draft; expiresAt: string }
  | { awaiting: "customer_choice"; name: string; options: Array<{ id: string; name: string }>; next: { kind: "create"; draft: Draft } | { kind: "status" | "history" | "accounting" | "outstanding" | "summary"; period?: Period }; expiresAt: string }
  | { awaiting: "invoice_choice"; options: Array<{ id: string; number: string; title: string | null }>; payment: { id: string; status: string; exceptionId: string | null; label: string }; expiresAt: string };

export interface AssistantContext {
  app: FastifyInstance;
  cookie: string;
  organizationId: string;
  environment: "test" | "live";
  userId: string;
  can: (permission: Permission) => boolean;
  tz: string;
  now: Date;
  messageId: string;
  conversationId: string;
  pending: Pending | null;
  /** Recent conversation only; no balances or customer records are sent to the language model. */
  history?: ConversationTurn[];
}

export interface Reply {
  intent: string;
  blocks: Block[];
  pending: Pending | null;
}

export class ApiCallError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

const PENDING_MINUTES = 15;
export const expires = (now: Date) => new Date(now.getTime() + PENDING_MINUTES * 60_000).toISOString();

// ── API access ────────────────────────────────────────────────────────────────────────────────

export async function api<T = Any>(ctx: AssistantContext, method: "GET" | "POST", url: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = {
    cookie: ctx.cookie,
    origin: appEnv().WEB_ORIGIN,
    "x-setra-internal": ASSISTANT_TOKEN,
    "x-setra-assistant-message": ctx.messageId
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const res = await ctx.app.inject({ method, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
  let data: Any = {};
  try {
    data = res.json();
  } catch {
    data = {};
  }
  if (res.statusCode >= 400) throw new ApiCallError(res.statusCode, data?.error?.code ?? "error", data?.error?.message ?? "Setra couldn't complete that.");
  return data as T;
}

export const qs = (params: Record<string, string | number | undefined | null>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

// ── formatting ────────────────────────────────────────────────────────────────────────────────

export function formatAmount(decimal: string | null | undefined, asset?: string | null): string {
  if (decimal === null || decimal === undefined) return "-";
  const neg = decimal.startsWith("-");
  const [w = "0", f = ""] = (neg ? decimal.slice(1) : decimal).split(".");
  const body = `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f.replace(/0+$/, "").padEnd(2, "0")}`;
  return `${neg ? "-" : ""}${body}${asset ? ` ${asset}` : ""}`;
}

const formatDate = (iso: string | null | undefined, tz: string, withTime = false) =>
  iso
    ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: withTime ? undefined : "short", month: "short", day: "numeric", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit", timeZoneName: "short" } : {}) }).format(new Date(iso))
    : "-";

const short = (hash: string | null | undefined) => (hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : "-");

/** What a payment's state means for the business, without claiming more than Setra knows. */
export function statusLabel(p: Any): string {
  switch (p.status) {
    case "matched":
      return p.finalized_at ? "Matched & confirmed" : "Matched";
    case "partial":
      return "Partially paid · confirmed";
    case "overpaid":
      return "Overpaid · needs review";
    case "needs_review":
      return "Needs review";
    case "confirming":
      return `Detected · confirming on ${p.network_name}`;
    case "dismissed":
      return "Not applied";
    case "refunded":
      return "Refunded to the sender";
    case "reversed":
      return "Reversed (no longer on chain)";
    default:
      return p.status;
  }
}

function paymentCard(p: Any): PaymentCard {
  return {
    id: p.id,
    customer: p.customer?.name ?? null,
    purpose: p.business_object?.title ?? null,
    purpose_status: p.purpose_status ?? "unknown",
    invoice: p.business_object?.number ?? null,
    amount: formatAmount(p.amount),
    asset: p.asset?.symbol ?? "Unknown token",
    network: p.network_name,
    status: p.status,
    status_label: statusLabel(p),
    transaction_hash: p.transaction_hash,
    explorer_url: p.explorer_url ?? null,
    received_at: p.paid_at,
    simulated: Boolean(p.simulated),
    href: `/app/payments/${p.id}`
  };
}

function invoiceCard(i: Any): InvoiceCard {
  return {
    id: i.id,
    number: i.number,
    title: i.title ?? null,
    purpose: i.purpose ?? null,
    customer: i.customer?.name ?? "-",
    amount: formatAmount(i.amount_due),
    remaining: formatAmount(i.amount_remaining),
    asset: i.asset?.symbol ?? "",
    network: i.network_name,
    status: i.status,
    due_at: i.due_at ?? null,
    payment_url: i.payment_url,
    line_items: (i.line_items ?? []).map((li: Any) => ({ description: li.description, quantity: li.quantity, amount: formatAmount(li.amount) })),
    href: `/app/invoices/${i.id}`
  };
}

const paymentTitle = (p: Any): { title: string; tone: "success" | "warning" | "info" | "danger" } =>
  p.status === "matched"
    ? { title: "Payment received", tone: "success" }
    : p.status === "partial"
      ? { title: "Partial payment received", tone: "warning" }
      : p.status === "overpaid"
        ? { title: "Payment requires review: more than was due", tone: "warning" }
        : p.status === "confirming"
          ? { title: "Payment detected, not yet confirmed", tone: "info" }
          : p.status === "reversed"
            ? { title: "Payment reversed", tone: "danger" }
            : p.status === "refunded"
              ? { title: "Payment refunded", tone: "info" }
              : { title: "Payment requires review", tone: "warning" };

function paymentNote(p: Any): string | undefined {
  if (p.status === "confirming") return "Setra hasn't reached finality for this payment yet. Nothing is applied until the block is final.";
  if (p.business_object && ["matched", "partial", "overpaid"].includes(p.status)) {
    const n = p.business_object.number;
    if (p.context_source === "manual_resolution") return `An operator assigned this payment to ${n}.`;
    if (p.context_source === "payment_intent") return `The payment's onchain reference identified ${n}.`;
    return `Setra matched this payment to ${n} automatically.`;
  }
  if (p.status === "needs_review") return "Setra couldn't safely decide which invoice this belongs to. Nothing was applied.";
  return undefined;
}

const HELP: Block[] = [
  { type: "text", text: "Hi, I'm Seti. Ask about the business in plain language, or tell me who to bill and I'll prepare the request for your confirmation." },
  {
    type: "choice",
    prompt: "For example",
    options: [
      { label: "What should I focus on today?", value: "@text" },
      { label: "How much profit did we make this month?", value: "@text" },
      { label: "Why is profit different from last month?", value: "@text" },
      { label: "How much cash do we have?", value: "@text" },
      { label: "What do we owe vendors?", value: "@text" },
      { label: "Did Acme Ltd pay?", value: "@text" },
      { label: "What's outstanding?", value: "@text" },
      { label: "Create a $250 USDC payment request for Acme Ltd for website development, due Friday", value: "@text" },
      { label: "Are the books in order?", value: "@text" }
    ]
  }
];

// When a message isn't understood: short, a little varied, and four things worth trying.
const UNKNOWN = [
  "I'm not sure which record or accounting question you mean. Name a payment, customer, invoice or part of the books, or choose an example below.",
  "I need a little more financial context. Tell me which payment, customer or accounting question to check, or choose an example below.",
  "I couldn't connect that request to a Setra record or accounting question. Choose an example below to get started."
];
const SUGGEST: Block = {
  type: "choice",
  prompt: "For example",
  options: [
    { label: "What should I focus on today?", value: "@text" },
    { label: "What's outstanding?", value: "@text" },
    { label: "How much cash do we have?", value: "@text" },
    { label: "Anything that needs review?", value: "@text" },
    { label: "What does reconciliation mean?", value: "@text" }
  ]
};

// ── customers ─────────────────────────────────────────────────────────────────────────────────

type Resolved = { status: "one"; id: string; name: string } | { status: "many"; options: Array<{ id: string; name: string; detail?: string }> } | { status: "none" };

async function resolveCustomer(ctx: AssistantContext, name: string): Promise<Resolved> {
  const res = await api<{ data: Any[] }>(ctx, "GET", `/v1/customers?${qs({ search: name, limit: 10 })}`);
  const rows = res.data;
  const exact = rows.filter((c) => c.name.toLowerCase() === name.toLowerCase());
  if (exact.length === 1) return { status: "one", id: exact[0]!.id, name: exact[0]!.name };
  const pool = exact.length > 1 ? exact : rows;
  if (pool.length === 1) return { status: "one", id: pool[0]!.id, name: pool[0]!.name };
  if (pool.length > 1) return { status: "many", options: pool.map((c) => ({ id: c.id, name: c.name, detail: c.email ?? undefined })) };
  return { status: "none" };
}

function customerChoice(name: string, options: Array<{ id: string; name: string; detail?: string }>): Block {
  return { type: "choice", prompt: `I found ${options.length} customers matching “${name}”. Which one do you mean?`, options: options.map((o) => ({ label: o.name, detail: o.detail, value: o.id })) };
}

// ── entry point ───────────────────────────────────────────────────────────────────────────────

export async function respond(ctx: AssistantContext, text: string, choice?: string): Promise<Reply> {
  try {
    return speak(await respondInner(ctx, text, choice), text);
  } catch (error) {
    if (error instanceof ApiCallError) return { intent: "error", pending: ctx.pending, blocks: [friendly(error)] };
    throw error;
  }
}

async function respondInner(ctx: AssistantContext, text: string, choice?: string): Promise<Reply> {
  const pending = ctx.pending && new Date(ctx.pending.expiresAt) > ctx.now ? ctx.pending : null;
  if (pending && /^\s*(cancel|never ?mind|stop|forget it|no thanks)\b/i.test(text)) return { intent: "cancel", pending: null, blocks: [{ type: "text", text: "Cancelled. I didn't create anything." }] };

  if (pending) {
    const continued = await continuePending(ctx, pending, text, choice);
    if (continued) return continued;
  }

  // The model understands ordinary conversation; deterministic rules remain the reliable fallback.
  const intent = await understand(text, undefined, ctx.history ?? []);
  switch (intent.kind) {
    case "create_request":
      return createFlow(ctx, draftFrom(ctx, intent));
    case "payment_status":
      return paymentStatus(ctx, intent);
    case "summary":
      return summary(ctx, intent.period, intent.customer, intent.asset);
    case "outstanding":
      return outstanding(ctx, intent.customer);
    case "overdue":
      return overdue(ctx);
    case "review":
      return review(ctx, intent.filter);
    case "latest":
      return latest(ctx);
    case "history":
      return history(ctx, intent.customer);
    case "find":
      return find(ctx, intent.query);
    case "accounting":
      return accounting(ctx, intent);
    case "correction":
      return correction(ctx, intent);
    case "who_sent":
      return whoSent(ctx, intent.amount);
    case "help":
      return { intent: "help", pending: null, blocks: HELP };
    case "guidance":
      return { intent: "guidance", pending: null, blocks: [{ type: "text", text: intent.answer }] };
    case "fin_pl":
    case "fin_compare":
    case "fin_spend":
    case "fin_cash":
    case "fin_payables":
    case "fin_health":
    case "fin_unclassified":
    case "fin_briefing":
    case "record_expense":
    case "record_bill":
    case "close_period":
      return financial(ctx, intent);
    default:
      return { intent: "unknown", pending: null, blocks: [{ type: "text", text: pick(text.toLowerCase(), UNKNOWN) }, SUGGEST] };
  }
}

// ── pending conversations ─────────────────────────────────────────────────────────────────────

async function continuePending(ctx: AssistantContext, pending: Pending, text: string, choice?: string): Promise<Reply | null> {
  if (pending.awaiting === "customer_choice") {
    const picked =
      pending.options.find((o) => o.id === choice) ??
      pending.options[Number(text.trim()) - 1] ??
      pending.options.find((o) => o.name.toLowerCase() === text.trim().toLowerCase());
    if (!picked) return null;
    const next = pending.next;
    if (next.kind === "create") return createFlow(ctx, { ...next.draft, customerId: picked.id, customerName: picked.name, newCustomer: undefined });
    if (next.kind === "status") return statusForCustomer(ctx, picked.id, picked.name);
    if (next.kind === "history") return historyForCustomer(ctx, picked.id, picked.name);
    if (next.kind === "outstanding") return outstandingFor(ctx, picked.id, picked.name);
    if (next.kind === "summary") return summaryFor(ctx, next.period ?? "month", { id: picked.id, name: picked.name });
    return accountingForCustomer(ctx, picked.id, picked.name);
  }
  if (pending.awaiting === "invoice_choice") {
    const picked = pending.options.find((o) => o.id === choice) ?? pending.options[Number(text.trim()) - 1] ?? pending.options.find((o) => o.number.toLowerCase() === text.trim().toLowerCase());
    if (!picked) return null;
    return proposeCorrection(ctx, pending.payment, picked);
  }
  // Waiting for one missing field of a payment request. A clear new question starts over instead.
  const draft = { ...pending.draft };
  const fresh = parseIntent(text);
  if (fresh.kind !== "unknown" && fresh.kind !== "create_request") return null;
  if (fresh.kind === "create_request" && (fresh.amount || fresh.customer || fresh.purpose)) return null;
  switch (pending.missing) {
    case "amount": {
      const found = findAmount(text) ?? bareAmount(text);
      if (!found) return { intent: "create_request", pending, blocks: [{ type: "text", text: "How much is it for? You can say something like 250 USDC." }] };
      draft.amount = found.amount;
      draft.asset = draft.asset ?? found.asset;
      break;
    }
    case "purpose": {
      const purpose = clean(text);
      if (!purpose) return { intent: "create_request", pending, blocks: [{ type: "text", text: "What's it for? Your customer sees this before they pay." }] };
      draft.purpose = titleCase(purpose);
      break;
    }
    case "customer": {
      const name = clean(choice && choice !== "@text" ? choice : text, 80);
      if (!name) return { intent: "create_request", pending, blocks: [{ type: "text", text: "Who should I bill?" }] };
      draft.customerName = name;
      draft.customerId = undefined;
      break;
    }
    case "asset": {
      const asset = /usdt/i.test(choice ?? text) ? "USDT0" : /usdc/i.test(choice ?? text) ? "USDC" : null;
      if (!asset) return { intent: "create_request", pending, blocks: [{ type: "text", text: "Which stablecoin should they pay in?" }] };
      draft.asset = asset;
      break;
    }
  }
  return createFlow(ctx, draft);
}

function bareAmount(text: string): { amount: string; asset?: string } | null {
  const m = /^\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,6}))?\s*(k)?\s*(usdc|usdt0|usdt)?\s*$/i.exec(text);
  if (!m) return null;
  const amount = normalizeAmount(m[1]!, m[2], Boolean(m[3]));
  if (!amount) return null;
  return { amount, asset: m[4] ? (/usdc/i.test(m[4]) ? "USDC" : "USDT0") : undefined };
}

// ── creating payment requests ─────────────────────────────────────────────────────────────────

function draftFrom(ctx: AssistantContext, intent: Extract<Intent, { kind: "create_request" }>): Draft {
  let dueAt: string | null | undefined;
  let dueNote: string | undefined;
  if (intent.due) {
    const resolved = resolveDue(intent.due, ctx.now, ctx.tz);
    if (resolved) dueAt = resolved.toISOString();
    else dueNote = "I couldn't read that due date, so none is set.";
  }
  return { amount: intent.amount, asset: intent.asset, customerName: intent.customer, purpose: intent.purpose, dueAt, dueNote, loose: intent.loose };
}

async function createFlow(ctx: AssistantContext, input: Draft): Promise<Reply> {
  const draft = { ...input };
  if (!ctx.can("invoices:write")) {
    return { intent: "create_request", pending: null, blocks: [{ type: "notice", tone: "warning", title: "Your role can't create payment requests.", text: "Ask an owner, admin or operator of this workspace." }] };
  }

  // A single "for …" is either the customer or the purpose: only a real customer makes it a customer.
  if (draft.loose && !draft.customerName && !draft.customerId) {
    const r = await resolveCustomer(ctx, draft.loose);
    if (r.status === "one") {
      draft.customerId = r.id;
      draft.customerName = r.name;
    } else if (r.status === "many") {
      const loose = draft.loose;
      delete draft.loose;
      return { intent: "create_request", pending: { awaiting: "customer_choice", name: loose, options: r.options, next: { kind: "create", draft }, expiresAt: expires(ctx.now) }, blocks: [customerChoice(loose, r.options)] };
    } else if (!draft.purpose) {
      draft.purpose = titleCase(draft.loose);
    }
    delete draft.loose;
  }

  if (!draft.customerId && !draft.newCustomer) {
    if (!draft.customerName) return ask(ctx, draft, "customer", "Who should I bill?");
    const r = await resolveCustomer(ctx, draft.customerName);
    if (r.status === "many") {
      return { intent: "create_request", pending: { awaiting: "customer_choice", name: draft.customerName, options: r.options, next: { kind: "create", draft }, expiresAt: expires(ctx.now) }, blocks: [customerChoice(draft.customerName, r.options)] };
    }
    if (r.status === "one") {
      draft.customerId = r.id;
      draft.customerName = r.name;
    } else if (ctx.can("customers:write")) {
      draft.newCustomer = draft.customerName;
    } else {
      return { intent: "create_request", pending: null, blocks: [{ type: "notice", tone: "warning", title: `No customer called “${draft.customerName}”.`, text: "Your role can't add customers. Ask an admin to add them first." }] };
    }
  }
  if (!draft.amount) return ask(ctx, draft, "amount", `Sure. How much should I bill ${draft.customerName ?? draft.newCustomer}?`);
  if (!draft.purpose) return ask(ctx, draft, "purpose", "What's it for? Your customer sees this before they pay.");

  // Asset and network: only safe defaults. Monad is the network; the asset must be one a wallet accepts.
  const wallets = (await api<{ data: Any[] }>(ctx, "GET", "/v1/wallets")).data.filter((w) => w.network === "monad");
  const accepted = [...new Set(wallets.flatMap((w) => (w.assets ?? []).map((a: Any) => a.symbol as string)))];
  const network = wallets[0]?.network_name ?? (ctx.environment === "test" ? "Monad Testnet" : "Monad");
  if (!accepted.length) {
    return { intent: "create_request", pending: null, blocks: [{ type: "notice", tone: "warning", title: `I couldn't create the payment request: no ${network} receiving wallet is set up.`, text: "Add the wallet you'll be paid to (Setra only needs its public address).", link: { label: "Open wallet settings", href: "/app/wallets?add=1" } }] };
  }
  if (draft.asset && !accepted.includes(draft.asset)) {
    return { intent: "create_request", pending: null, blocks: [{ type: "notice", tone: "warning", title: `No ${network} wallet accepts ${draft.asset}.`, text: `Your wallets accept ${accepted.join(", ")}.`, link: { label: "Open wallet settings", href: "/app/wallets" } }] };
  }
  if (!draft.asset) {
    if (accepted.length === 1) draft.asset = accepted[0];
    else
      return {
        intent: "create_request",
        pending: { awaiting: "create", missing: "asset", draft, expiresAt: expires(ctx.now) },
        blocks: [{ type: "choice", prompt: "Which stablecoin should they pay in?", options: accepted.map((a) => ({ label: a, value: a })) }]
      };
  }

  const action = await createAction(ctx, "create_payment_request", {
    customer_id: draft.customerId ?? null,
    new_customer: draft.newCustomer ?? null,
    customer_name: draft.customerName ?? draft.newCustomer,
    title: draft.purpose,
    amount: draft.amount,
    asset: draft.asset,
    network: "monad",
    network_name: network,
    due_at: draft.dueAt ?? null
  });
  const rows: Row[] = [
    ["Customer", draft.newCustomer ? `${draft.newCustomer} (new customer)` : draft.customerName!],
    ["For", draft.purpose],
    ["Amount", formatAmount(draft.amount, draft.asset)],
    ["Network", network],
    ["Due", draft.dueAt ? formatDate(draft.dueAt, ctx.tz) : "No due date"]
  ];
  const blocks: Block[] = [
    {
      type: "confirm",
      actionId: action.id,
      title: "Create this payment request?",
      rows,
      confirmLabel: "Create payment request",
      testMode: ctx.environment === "test",
      expiresAt: action.expires_at
    }
  ];
  if (draft.dueNote) blocks.unshift({ type: "notice", tone: "info", title: draft.dueNote });
  return { intent: "create_request", pending: null, blocks };
}

function ask(ctx: AssistantContext, draft: Draft, missing: "customer" | "amount" | "purpose", question: string): Reply {
  return { intent: "create_request", pending: { awaiting: "create", missing, draft, expiresAt: expires(ctx.now) }, blocks: [{ type: "text", text: question }] };
}

export async function createAction(ctx: AssistantContext, kind: "create_payment_request" | "correct_payment" | "record_expense" | "record_bill" | "close_period", payload: Any) {
  const id = newId("assistantAction");
  const expiresAt = expires(ctx.now);
  await withTenant(ctx.organizationId, (c) =>
    c.query(
      `INSERT INTO assistant_actions (id, organization_id, environment, conversation_id, user_id, kind, payload, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, ctx.organizationId, ctx.environment, ctx.conversationId, ctx.userId, kind, JSON.stringify(payload), expiresAt]
    )
  );
  return { id, expires_at: expiresAt };
}

/** Carry out a confirmed action (exactly once), or cancel it. */
export async function resolveAction(ctx: AssistantContext, actionId: string, decision: "confirm" | "cancel"): Promise<Block[]> {
  const action = (await withTenant(ctx.organizationId, (c) => c.query("SELECT * FROM assistant_actions WHERE id = $1 AND organization_id = $2", [actionId, ctx.organizationId]))).rows[0] as Any | undefined;
  if (!action || action.user_id !== ctx.userId) return [{ type: "notice", tone: "danger", title: "That action isn't available." }];
  if (action.environment !== ctx.environment) {
    return [{ type: "notice", tone: "warning", title: `This was prepared in ${action.environment} mode.`, text: `Switch back to ${action.environment} mode to confirm it, or ask again in ${ctx.environment} mode.` }];
  }
  if (action.status === "confirmed" && action.result) return action.result.blocks as Block[];
  if (action.status !== "pending") return [{ type: "notice", tone: "info", title: action.status === "cancelled" ? "Already cancelled. Nothing was created." : action.status === "failed" ? "That action didn't go through earlier." : "This confirmation has expired. Ask again to start over." }];
  if (new Date(action.expires_at) <= ctx.now) {
    await withTenant(ctx.organizationId, (c) => c.query("UPDATE assistant_actions SET status = 'expired', resolved_at = now() WHERE id = $1 AND status = 'pending'", [actionId]));
    return [{ type: "notice", tone: "info", title: "This confirmation has expired. Ask again to start over." }];
  }
  if (decision === "cancel") {
    await withTenant(ctx.organizationId, (c) => c.query("UPDATE assistant_actions SET status = 'cancelled', resolved_at = now() WHERE id = $1 AND status = 'pending'", [actionId]));
    return [{ type: "text", text: "Cancelled. I didn't create anything." }];
  }
  // Claim it: only one confirmation proceeds.
  const claimed = await withTenant(ctx.organizationId, (c) => c.query("UPDATE assistant_actions SET status = 'confirmed', resolved_at = now() WHERE id = $1 AND status = 'pending' RETURNING id", [actionId]));
  if (!claimed.rows[0]) return [{ type: "notice", tone: "info", title: "Already being processed." }];

  let blocks: Block[];
  try {
    blocks =
      action.kind === "create_payment_request"
        ? await createPaymentRequest(ctx, action)
        : action.kind === "correct_payment"
          ? await applyCorrection(ctx, action)
          : await applyFinancialAction(ctx, action);
  } catch (error) {
    const failure = error instanceof ApiCallError ? [friendly(error)] : [{ type: "notice" as const, tone: "danger" as const, title: "Something went wrong. Nothing was created." }];
    await withTenant(ctx.organizationId, (c) => c.query("UPDATE assistant_actions SET status = 'failed', result = $2 WHERE id = $1", [actionId, JSON.stringify({ blocks: failure, error: (error as Error).message.slice(0, 300) })]));
    return failure;
  }
  await withTenant(ctx.organizationId, (c) => c.query("UPDATE assistant_actions SET result = $2 WHERE id = $1", [actionId, JSON.stringify({ blocks })]));
  return blocks;
}

async function createPaymentRequest(ctx: AssistantContext, action: Any): Promise<Block[]> {
  const p = action.payload;
  let customerId: string = p.customer_id;
  if (!customerId && p.new_customer) {
    customerId = (await api(ctx, "POST", "/v1/customers", { name: p.new_customer }, `${action.id}-customer`)).id;
  }
  const invoice = await api(ctx, "POST", "/v1/invoices", { customer_id: customerId, title: p.title, amount: p.amount, asset: p.asset, network: p.network, due_at: p.due_at ?? undefined }, action.id);
  return [
    { type: "payment_request", invoice: invoiceCard(invoice), testMode: ctx.environment === "test" },
    { type: "text", text: `Done. Send ${invoice.customer?.name ?? "your customer"} the link and I'll let you know as soon as they pay.` }
  ];
}

// ── questions ─────────────────────────────────────────────────────────────────────────────────

async function withCustomer(ctx: AssistantContext, name: string, next: Extract<Pending, { awaiting: "customer_choice" }>["next"], go: (id: string, name: string) => Promise<Reply>): Promise<Reply> {
  const r = await resolveCustomer(ctx, name);
  if (r.status === "one") return go(r.id, r.name);
  if (r.status === "many") return { intent: next.kind, pending: { awaiting: "customer_choice", name, options: r.options, next, expiresAt: expires(ctx.now) }, blocks: [customerChoice(name, r.options)] };
  return { intent: next.kind, pending: null, blocks: [{ type: "notice", tone: "info", title: `No customer called “${name}” in this workspace.`, link: { label: "View customers", href: "/app/customers" } }] };
}

async function paymentStatus(ctx: AssistantContext, intent: Extract<Intent, { kind: "payment_status" }>): Promise<Reply> {
  if (intent.invoice) {
    const found = (await api<{ data: Any[] }>(ctx, "GET", `/v1/invoices?${qs({ search: intent.invoice, limit: 5 })}`)).data.find((i) => i.number.toUpperCase() === intent.invoice);
    if (!found) return { intent: "payment_status", pending: null, blocks: [{ type: "notice", tone: "info", title: `No invoice ${intent.invoice} in this workspace.` }] };
    const inv = await api(ctx, "GET", `/v1/invoices/${found.id}`);
    const latestPayment = inv.payments?.[0] ? await api(ctx, "GET", `/v1/payments/${inv.payments[0].id}`) : null;
    const blocks: Block[] = [{ type: "invoices", title: `${inv.number}: ${inv.status.replace("_", " ")}`, items: [invoiceCard(inv)], empty: "" }];
    if (latestPayment) blocks.push({ type: "payment", ...paymentTitle(latestPayment), payment: paymentCard(latestPayment), note: paymentNote(latestPayment) });
    else blocks.push({ type: "text", text: `I'll let you know as soon as a payment comes in for ${inv.number}.` });
    return { intent: "payment_status", pending: null, blocks };
  }
  if (!intent.customer) return { intent: "payment_status", pending: null, blocks: [{ type: "text", text: "Whose payment should I check? You can ask something like “Did Acme Ltd pay?”" }] };
  return withCustomer(ctx, intent.customer, { kind: "status" }, (id, name) => statusForCustomer(ctx, id, name));
}

async function statusForCustomer(ctx: AssistantContext, customerId: string, name: string): Promise<Reply> {
  const [payments, open] = await Promise.all([
    api<{ data: Any[] }>(ctx, "GET", `/v1/payments?${qs({ customer_id: customerId, limit: 3 })}`),
    api<{ data: Any[] }>(ctx, "GET", `/v1/invoices?${qs({ customer_id: customerId, state: "unpaid", limit: 5 })}`)
  ]);
  const blocks: Block[] = [];
  const last = payments.data[0];
  if (last) {
    const detail = await api(ctx, "GET", `/v1/payments/${last.id}`);
    blocks.push({ type: "payment", ...paymentTitle(detail), payment: paymentCard(detail), note: paymentNote(detail) });
  } else {
    blocks.push({ type: "notice", tone: "info", title: `No payments from ${name} yet.` });
  }
  if (open.data.length) blocks.push({ type: "invoices", title: `Still open for ${name}`, items: open.data.map(invoiceCard), empty: "", link: { label: "View customer", href: `/app/customers/${customerId}` } });
  else if (last) blocks.push({ type: "text", text: `Nothing else is open for ${name}.` });
  return { intent: "payment_status", pending: null, blocks };
}

async function summary(ctx: AssistantContext, period: Period, customer?: string, asset?: string): Promise<Reply> {
  if (customer) return withCustomer(ctx, customer, { kind: "summary", period }, (id, name) => summaryFor(ctx, period, { id, name }, asset));
  return summaryFor(ctx, period, undefined, asset);
}

async function summaryFor(ctx: AssistantContext, period: Period, customer?: { id: string; name: string }, asset?: string): Promise<Reply> {
  const { start, end, label } = periodStart(period, ctx.now, ctx.tz);
  const s = await api(ctx, "GET", `/v1/payments/summary?${qs({ created_gte: start.toISOString(), created_lte: end.toISOString(), customer_id: customer?.id, asset })}`);
  const title = customer ? `${customer.name}: ${label.toLowerCase()}` : `${label}'s payments`.replace("This week's", "This week's").replace("Today's payments", "Today's payments");
  const rows: Row[] = [
    ["Payments received", String(s.count - s.by_status.confirming)],
    ["Matched", String(s.by_status.matched)],
    ["Partially paid", String(s.by_status.partial)],
    ["Needs review", String(s.by_status.needs_review + s.by_status.overpaid)]
  ];
  if (s.by_status.confirming) rows.push(["Confirming now", `${s.by_status.confirming} (${formatAmount(s.confirming_amount)})`]);
  if (s.by_status.refunded) rows.push(["Refunded", String(s.by_status.refunded)]);
  for (const a of s.by_asset) if (s.by_asset.length > 1 || asset) rows.push([`${a.asset} received`, formatAmount(a.received, a.asset)]);
  return {
    intent: "summary",
    pending: null,
    blocks: [
      {
        type: "summary",
        title: customer ? title : `${label}: payments`,
        rows,
        highlight: { label: asset ? `${asset} received` : "Total received", value: asset ? formatAmount(s.by_asset.find((a: Any) => a.asset === asset)?.received ?? "0.00", asset) : `${formatAmount(s.received)} USD in stablecoins` },
        note: s.simulated ? `Includes ${s.simulated} simulated test payment${s.simulated === 1 ? "" : "s"}.` : undefined,
        link: { label: "View payments", href: customer ? `/app/customers/${customer.id}` : "/app/payments" }
      }
    ]
  };
}

async function outstanding(ctx: AssistantContext, customer?: string): Promise<Reply> {
  if (customer) return withCustomer(ctx, customer, { kind: "outstanding" }, (id, name) => outstandingFor(ctx, id, name));
  const [open, overview] = await Promise.all([api<{ data: Any[]; has_more: boolean }>(ctx, "GET", "/v1/invoices?state=unpaid&limit=8"), api(ctx, "GET", "/v1/overview?period=today")]);
  return {
    intent: "outstanding",
    pending: null,
    blocks: [
      {
        type: "invoices",
        title: `Outstanding: ${overview.metrics.outstanding_invoices} payment request${overview.metrics.outstanding_invoices === 1 ? "" : "s"}`,
        items: open.data.map(invoiceCard),
        empty: "Nothing is outstanding. Every payment request is settled.",
        total: `${formatAmount(overview.metrics.outstanding)} USD outstanding`,
        link: { label: "View invoices", href: "/app/invoices" }
      }
    ]
  };
}

async function outstandingFor(ctx: AssistantContext, customerId: string, name: string): Promise<Reply> {
  const [open, customer] = await Promise.all([api<{ data: Any[] }>(ctx, "GET", `/v1/invoices?${qs({ customer_id: customerId, state: "unpaid", limit: 8 })}`), api(ctx, "GET", `/v1/customers/${customerId}`)]);
  return {
    intent: "outstanding",
    pending: null,
    blocks: [{ type: "invoices", title: `Outstanding for ${name}`, items: open.data.map(invoiceCard), empty: `${name} owes nothing right now.`, total: customer.stats ? `${formatAmount(customer.stats.outstanding)} USD outstanding` : undefined, link: { label: "View customer", href: `/app/customers/${customerId}` } }]
  };
}

async function overdue(ctx: AssistantContext): Promise<Reply> {
  const res = await api<{ data: Any[] }>(ctx, "GET", "/v1/invoices?state=overdue&limit=10");
  return { intent: "overdue", pending: null, blocks: [{ type: "invoices", title: "Overdue payment requests", items: res.data.map(invoiceCard), empty: "Nothing is overdue.", link: { label: "View invoices", href: "/app/invoices" } }] };
}

async function review(ctx: AssistantContext, filter: "all" | "wrong_amount" | "unknown" | "duplicate"): Promise<Reply> {
  const types = filter === "wrong_amount" ? ["partial_payment", "overpayment"] : filter === "duplicate" ? ["duplicate_payment"] : filter === "unknown" ? ["unknown_payment", "ambiguous_match"] : [undefined];
  const lists = await Promise.all(types.map((t) => api<{ data: Any[] }>(ctx, "GET", `/v1/exceptions?${qs({ status: "open", type: t, limit: 20 })}`)));
  const items = lists.flatMap((l) => l.data).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const title = filter === "wrong_amount" ? "Payments with the wrong amount" : filter === "duplicate" ? "Possible duplicate payments" : filter === "unknown" ? "Unidentified payments" : "Payments needing review";
  return {
    intent: "review",
    pending: null,
    blocks: [
      {
        type: "exceptions",
        title,
        items: items.slice(0, 10).map((e) => ({ id: e.id, type: e.type, summary: e.summary, amount: e.amount ? formatAmount(e.amount, e.asset?.symbol) : null, customer: e.customer?.name ?? null, invoice: e.invoice?.number ?? null, href: `/app/exceptions/${e.id}` })),
        empty: filter === "wrong_amount" ? "No one has paid the wrong amount. Nothing is waiting for review." : "Nothing needs review.",
        link: { label: "Open review queue", href: "/app/exceptions" }
      }
    ]
  };
}

async function latest(ctx: AssistantContext): Promise<Reply> {
  const res = await api<{ data: Any[] }>(ctx, "GET", "/v1/payments?limit=1");
  if (!res.data[0]) return { intent: "latest", pending: null, blocks: [{ type: "notice", tone: "info", title: "No payments yet." }] };
  const p = await api(ctx, "GET", `/v1/payments/${res.data[0].id}`);
  return { intent: "latest", pending: null, blocks: [{ type: "payment", ...paymentTitle(p), payment: paymentCard(p), note: paymentNote(p) }] };
}

async function history(ctx: AssistantContext, customer: string): Promise<Reply> {
  return withCustomer(ctx, customer, { kind: "history" }, (id, name) => historyForCustomer(ctx, id, name));
}

async function historyForCustomer(ctx: AssistantContext, customerId: string, name: string): Promise<Reply> {
  const [payments, customer] = await Promise.all([api<{ data: Any[] }>(ctx, "GET", `/v1/payments?${qs({ customer_id: customerId, limit: 10 })}`), api(ctx, "GET", `/v1/customers/${customerId}`)]);
  return {
    intent: "history",
    pending: null,
    blocks: [
      {
        type: "payments",
        title: `${name}: payment history${customer.stats ? ` · ${formatAmount(customer.stats.total_received)} USD received` : ""}`,
        items: payments.data.map(paymentCard),
        empty: `No payments from ${name} yet.`,
        link: { label: "View customer", href: `/app/customers/${customerId}` }
      }
    ]
  };
}

/** "Who sent the $740?": the public picture of the wallet behind an unidentified payment (Nansen), as advice. */
async function whoSent(ctx: AssistantContext, amount?: string): Promise<Reply> {
  const pending = (await api<{ data: Any[] }>(ctx, "GET", `/v1/payments?${qs({ status: "needs_review", limit: 25 })}`)).data.filter((p) => !p.customer);
  const target = amount ? pending.find((p) => p.amount === amount) : pending[0];
  if (!target) {
    const text = amount
      ? `I don't see an unidentified payment of $${formatAmount(amount)}. Every payment of that amount is already tied to a customer or invoice.`
      : "There's no unidentified payment right now. Every payment so far came from a customer I could place.";
    return { intent: "who_sent", pending: null, blocks: [{ type: "text", text }] };
  }
  const [detail, intel] = await Promise.all([api(ctx, "GET", `/v1/payments/${target.id}`), api(ctx, "GET", `/v1/payments/${target.id}/counterparty`)]);
  const paid = `${formatAmount(detail.amount)} ${detail.asset?.symbol ?? ""}`.trim();
  const card: Block = { type: "payment", ...paymentTitle(detail), payment: paymentCard(detail), note: paymentNote(detail) };
  if (intel.status === "disabled") {
    return { intent: "who_sent", pending: null, blocks: [{ type: "notice", tone: "info", title: "I can check who's behind that wallet, but counterparty lookups are off.", text: "Turn them on in Settings. Setra then asks Nansen for the wallet's public labels.", link: { label: "Open Settings", href: "/app/settings" } }, card] };
  }
  if (intel.status !== "ok" && intel.status !== "none") return { intent: "who_sent", pending: null, blocks: [{ type: "notice", tone: "info", title: intel.message ?? "I couldn't look that wallet up right now." }, card] };
  const related: Any[] = intel.related_customers ?? [];
  const top = related[0];
  const lead = top ? ` That wallet has moved money with ${top.customer_name}'s saved wallet ${top.interactions === 1 ? "once" : `${top.interactions} times`}, so I'd start with ${top.customer_name}'s open invoices.` : "";
  return {
    intent: "who_sent",
    pending: null,
    blocks: [
      { type: "text", text: `The ${paid} came from ${intel.address.slice(0, 6)}…${intel.address.slice(-4)}. ${intel.summary}${lead}` },
      { type: "text", text: `What I'd do: ${lowerFirst(intel.suggestion)} It's a clue from Nansen's public data, not a match, so the decision is yours.` },
      card
    ]
  };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

async function find(ctx: AssistantContext, query: string): Promise<Reply> {
  const [payments, invoices] = await Promise.all([api<{ data: Any[] }>(ctx, "GET", `/v1/payments?${qs({ search: query, limit: 5 })}`), api<{ data: Any[] }>(ctx, "GET", `/v1/invoices?${qs({ search: query, limit: 5 })}`)]);
  const blocks: Block[] = [{ type: "payments", title: `Payments matching “${query}”`, items: payments.data.map(paymentCard), empty: `No payments match “${query}”.`, link: { label: "Search all payments", href: `/app/payments?search=${encodeURIComponent(query)}` } }];
  if (invoices.data.length) blocks.push({ type: "invoices", title: `Payment requests matching “${query}”`, items: invoices.data.map(invoiceCard), empty: "" });
  return { intent: "find", pending: null, blocks };
}

async function accounting(ctx: AssistantContext, intent: Extract<Intent, { kind: "accounting" }>): Promise<Reply> {
  let paymentId = intent.payment;
  if (!paymentId && intent.tx) paymentId = (await api<{ data: Any[] }>(ctx, "GET", `/v1/payments?${qs({ search: intent.tx, limit: 1 })}`)).data[0]?.id;
  if (!paymentId && intent.invoice) {
    const inv = (await api<{ data: Any[] }>(ctx, "GET", `/v1/invoices?${qs({ search: intent.invoice, limit: 5 })}`)).data.find((i) => i.number.toUpperCase() === intent.invoice);
    if (inv) paymentId = (await api<{ data: Any[] }>(ctx, "GET", `/v1/payments?${qs({ invoice_id: inv.id, limit: 1 })}`)).data[0]?.id;
  }
  if (paymentId) return accountingRecord(ctx, paymentId);
  if (intent.customer) return withCustomer(ctx, intent.customer, { kind: "accounting" }, (id, name) => accountingForCustomer(ctx, id, name));
  return { intent: "accounting", pending: null, blocks: [{ type: "text", text: "Which payment? Name the customer, an invoice number (INV-…), a payment id or a transaction hash." }] };
}

async function accountingForCustomer(ctx: AssistantContext, customerId: string, name: string): Promise<Reply> {
  const settled = (await api<{ data: Any[] }>(ctx, "GET", `/v1/payments?${qs({ customer_id: customerId, status: "settled", limit: 1 })}`)).data[0];
  const any = settled ?? (await api<{ data: Any[] }>(ctx, "GET", `/v1/payments?${qs({ customer_id: customerId, limit: 1 })}`)).data[0];
  if (!any) return { intent: "accounting", pending: null, blocks: [{ type: "notice", tone: "info", title: `No payments from ${name} yet.` }] };
  return accountingRecord(ctx, any.id);
}

async function accountingRecord(ctx: AssistantContext, paymentId: string): Promise<Reply> {
  const p = await api(ctx, "GET", `/v1/payments/${paymentId}`);
  const inv = p.invoice_detail;
  const rows: Row[] = [
    ["Customer", p.customer?.name ?? "Unknown"],
    ["Invoice", inv?.number ?? "Not applied"],
    ["Purpose", inv?.title ?? "Unknown"],
    ["Amount received", formatAmount(p.amount, p.asset?.symbol)],
    ["Asset", p.asset?.address ? `${p.asset.symbol} (${short(p.asset.address)})` : (p.asset?.symbol ?? "Unknown token")],
    ["Network", `${p.network_name} (chain ${p.chain_id})`],
    ["Received in", `${p.wallet?.name ?? "Wallet"} (${short(p.recipient)})`],
    ["From", p.sender],
    ["Transaction", p.simulated ? "Simulated (test mode, no transaction)" : p.transaction_hash],
    ["Block", p.simulated ? "-" : Number(p.block_number).toLocaleString("en-US")],
    ["Payment status", statusLabel(p)],
    ["Received at", formatDate(p.paid_at, ctx.tz, true)],
    ["Finalized at", formatDate(p.finalized_at, ctx.tz, true)],
    ["Matched by", p.decision ? `${p.context_source === "manual_resolution" ? "Operator" : "Rules"} (${p.decision.rule_version})` : "-"],
    ["Reference", p.id]
  ];
  if (p.refunds_summary?.refunded && p.refunds_summary.refunded !== "0.00") rows.push(["Refunded", formatAmount(p.refunds_summary.refunded, p.asset?.symbol)]);
  const links: Link[] = [{ label: "View payment", href: `/app/payments/${p.id}` }];
  if (!p.simulated) links.push({ label: "Export CSV", href: `/api/v1/exports/payments.csv?search=${p.transaction_hash}` });
  return {
    intent: "accounting",
    pending: null,
    blocks: [
      { type: "record", title: "Accounting-ready payment record", rows, links },
      { type: "text", text: "These are the facts Setra recorded. It doesn't assign tax treatment, exchange rates or journal entries." }
    ]
  };
}

// ── corrections ───────────────────────────────────────────────────────────────────────────────

async function correction(ctx: AssistantContext, intent: Extract<Intent, { kind: "correction" }>): Promise<Reply> {
  if (!ctx.can("exceptions:resolve")) return { intent: "correction", pending: null, blocks: [{ type: "notice", tone: "warning", title: "Your role can't change how payments are applied." }] };
  let payment: Any | undefined;
  if (intent.payment) payment = await api(ctx, "GET", `/v1/payments/${intent.payment}`);
  else if (intent.customer) {
    const r = await resolveCustomer(ctx, intent.customer);
    if (r.status !== "one") return { intent: "correction", pending: null, blocks: [{ type: "notice", tone: "info", title: r.status === "many" ? `More than one customer matches “${intent.customer}”. Name the payment by invoice number or open it in Setra.` : `No customer called “${intent.customer}”.` }] };
    const recent = (await api<{ data: Any[] }>(ctx, "GET", `/v1/payments?${qs({ customer_id: r.id, limit: 5 })}`)).data.find((p) => ["matched", "partial", "overpaid", "needs_review"].includes(p.status));
    if (recent) payment = await api(ctx, "GET", `/v1/payments/${recent.id}`);
  }
  if (!payment) return { intent: "correction", pending: null, blocks: [{ type: "text", text: "Which payment? Name the customer who paid, or the payment id." }] };

  const invoiceNumber = /\bINV-\d{1,9}\b/i.exec(intent.target)?.[0]?.toUpperCase();
  const candidates = (await api<{ data: Any[] }>(ctx, "GET", `/v1/invoices?${qs({ state: invoiceNumber ? undefined : "unpaid", search: invoiceNumber ?? intent.target.replace(/\b(project|invoice|request)\b/gi, "").trim(), limit: 5 })}`)).data.filter(
    (i) => i.id !== payment!.business_object?.id && (!invoiceNumber || i.number.toUpperCase() === invoiceNumber)
  );
  const label = `${formatAmount(payment.amount, payment.asset?.symbol)} from ${payment.customer?.name ?? "an unknown sender"}`;
  const exceptionId = payment.exceptions?.find((e: Any) => e.status === "open")?.id ?? null;
  const target = { id: payment.id, status: payment.status, exceptionId, label };
  if (!candidates.length) return { intent: "correction", pending: null, blocks: [{ type: "notice", tone: "info", title: `No open payment request matches “${intent.target}”.`, link: { label: "View invoices", href: "/app/invoices" } }] };
  if (candidates.length > 1) {
    const options = candidates.map((i) => ({ id: i.id, number: i.number, title: i.title ?? null }));
    return {
      intent: "correction",
      pending: { awaiting: "invoice_choice", options, payment: target, expiresAt: expires(ctx.now) },
      blocks: [{ type: "choice", prompt: `Which payment request should the ${label} go to?`, options: options.map((o) => ({ label: `${o.number}${o.title ? `, ${o.title}` : ""}`, value: o.id })) }]
    };
  }
  const only = candidates[0]!;
  return proposeCorrection(ctx, target, { id: only.id, number: only.number, title: only.title ?? null });
}

async function proposeCorrection(ctx: AssistantContext, payment: { id: string; status: string; exceptionId: string | null; label: string }, invoice: { id: string; number: string; title: string | null }): Promise<Reply> {
  const mode = payment.status === "needs_review" ? "assign" : "reassign";
  if (mode === "assign" && !payment.exceptionId) return { intent: "correction", pending: null, blocks: [{ type: "notice", tone: "info", title: "This payment can't be assigned from here.", link: { label: "Open payment", href: `/app/payments/${payment.id}` } }] };
  const action = await createAction(ctx, "correct_payment", { payment_id: payment.id, invoice_id: invoice.id, mode, exception_id: payment.exceptionId });
  return {
    intent: "correction",
    pending: null,
    blocks: [
      {
        type: "confirm",
        actionId: action.id,
        title: mode === "assign" ? "Apply this payment?" : "Move this payment?",
        rows: [
          ["Payment", payment.label],
          ["To", `${invoice.number}${invoice.title ? `, ${invoice.title}` : ""}`],
          ["History", "The original record is kept; the change is recorded with your name."]
        ],
        confirmLabel: mode === "assign" ? "Apply payment" : "Move payment",
        testMode: ctx.environment === "test",
        expiresAt: action.expires_at
      }
    ]
  };
}

async function applyCorrection(ctx: AssistantContext, action: Any): Promise<Block[]> {
  const p = action.payload;
  const reason = "Requested in Setra Assistant";
  if (p.mode === "assign") await api(ctx, "POST", `/v1/exceptions/${p.exception_id}/resolve`, { action: "assign", invoice_id: p.invoice_id, reason });
  else await api(ctx, "POST", `/v1/payments/${p.payment_id}/corrections`, { action: "reassign", invoice_id: p.invoice_id, reason });
  const payment = await api(ctx, "GET", `/v1/payments/${p.payment_id}`);
  return [{ type: "payment", ...paymentTitle(payment), payment: paymentCard(payment), note: paymentNote(payment) }];
}

// ── errors ────────────────────────────────────────────────────────────────────────────────────

function friendly(error: ApiCallError): Block {
  if (error.code === "wallet_required" || error.code === "wallet_not_eligible") return { type: "notice", tone: "warning", title: "I couldn't create the payment request.", text: error.message, link: { label: "Open wallet settings", href: "/app/wallets" } };
  if (error.status === 403) return { type: "notice", tone: "warning", title: "Your role doesn't allow that.", text: error.message };
  if (error.status === 404) return { type: "notice", tone: "info", title: "I couldn't find that in this workspace." };
  return { type: "notice", tone: "danger", title: "Setra couldn't complete that.", text: error.message };
}
