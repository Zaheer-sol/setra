import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { newId } from "@setra/schemas";
import type { Client } from "@setra/database";
import { audit } from "@setra/engine";
import { can } from "../lib/principal";
import { idParam, route } from "../lib/route";
import { paymentUpdate, resolveAction, respond, formatAmount, type AssistantContext, type Pending } from "../assistant/orchestrator";
import { MAX_MESSAGE, safeTimeZone } from "../assistant/intent-parser";
import type { Block } from "../assistant/blocks";

type Row = Record<string, any>;

const messageInput = z.object({
  text: z.string().trim().min(1, "Type a message").max(MAX_MESSAGE),
  conversation_id: z.string().max(64).optional(),
  /** The value of a choice the user clicked (a customer or invoice id, an asset). */
  choice: z.string().max(64).optional(),
  timezone: z.string().max(64).optional()
});
const actionInput = z.object({ decision: z.enum(["confirm", "cancel"]), conversation_id: z.string().max(64).optional(), timezone: z.string().max(64).optional() });

/**
 * Setra Assistant and in-app notifications.
 *
 * The assistant endpoints are console-only (a signed-in user). Every question and action is answered
 * by calling the regular API in-process as that user (see assistant/orchestrator.ts), so the assistant can
 * never see or do more than the user could in the console.
 *
 * Notifications are Setra's financial events, formatted as business-ready cards. There is no separate
 * notification store: one event is one notification, so a replayed event can't notify twice.
 */
export function assistantRoutes(app: FastifyInstance) {
  route(app, {
    method: "POST",
    url: "/v1/assistant/messages",
    summary: "Ask the Setra Assistant",
    tags: ["assistant"],
    permission: "read",
    sessionOnly: true,
    body: messageInput,
    rateLimit: { max: 60, timeWindow: "1 minute" },
    handler: async ({ body, request, principal, organizationId, environment, tx }) => {
      if (principal.kind !== "user") throw new Error("unreachable");
      const conversation = await tx((c) => loadConversation(c, organizationId, environment, principal.userId, body.conversation_id));
      const history = await tx(async (c) => {
        const rows = (
          await c.query(
            "SELECT role, text, intent FROM assistant_messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10",
            [conversation.id]
          )
        ).rows.reverse();
        return rows
          .map((row): { role: "user" | "assistant"; content: string } | null => {
            if (row.role === "user" && row.text) return { role: "user", content: String(row.text).slice(0, 500) };
            if (row.role === "assistant" && row.intent) return { role: "assistant", content: `Seti handled that as: ${String(row.intent).replace(/_/g, " ")}.` };
            return null;
          })
          .filter((turn): turn is { role: "user" | "assistant"; content: string } => Boolean(turn));
      });
      const userMessage = await tx((c) => addMessage(c, organizationId, conversation.id, "user", body.text, null, []));
      const ctx: AssistantContext = {
        app,
        cookie: String(request.headers.cookie ?? ""),
        organizationId,
        environment,
        userId: principal.userId,
        can: (p) => can(principal, p),
        tz: safeTimeZone(body.timezone),
        now: new Date(),
        messageId: userMessage.id,
        conversationId: conversation.id,
        pending: conversation.pending as Pending | null,
        history
      };
      const reply = await respond(ctx, body.text, body.choice);
      const saved = await tx(async (c) => {
        await c.query("UPDATE assistant_conversations SET pending = $2, updated_at = now() WHERE id = $1", [conversation.id, reply.pending ? JSON.stringify(reply.pending) : null]);
        return addMessage(c, organizationId, conversation.id, "assistant", "", reply.intent, reply.blocks);
      });
      return { conversation_id: conversation.id, user_message: userMessage, message: saved };
    }
  });

  route(app, {
    method: "POST",
    url: "/v1/assistant/actions/:id",
    summary: "Confirm or cancel an action the Setra Assistant prepared",
    tags: ["assistant"],
    permission: "read",
    sessionOnly: true,
    params: idParam,
    body: actionInput,
    rateLimit: { max: 30, timeWindow: "1 minute" },
    handler: async ({ params, body, request, principal, organizationId, environment, tx, actor }) => {
      if (principal.kind !== "user") throw new Error("unreachable");
      const action = (await tx((c) => c.query("SELECT conversation_id FROM assistant_actions WHERE id = $1", [params.id]))).rows[0] as Row | undefined;
      const conversationId = action?.conversation_id ?? body.conversation_id;
      const note = await tx((c) => addMessageIfConversation(c, organizationId, conversationId, principal.userId, "user", body.decision === "confirm" ? "Confirm" : "Cancel"));
      const ctx: AssistantContext = {
        app,
        cookie: String(request.headers.cookie ?? ""),
        organizationId,
        environment,
        userId: principal.userId,
        can: (p) => can(principal, p),
        tz: safeTimeZone(body.timezone),
        now: new Date(),
        messageId: note?.id ?? params.id,
        conversationId: conversationId ?? "",
        pending: null
      };
      const blocks = await resolveAction(ctx, params.id, body.decision);
      await tx((c) =>
        audit(c, { ...actor, label: `${actor.label} via Setra Assistant` }, {
          organizationId,
          environment,
          action: body.decision === "confirm" ? "assistant_action_confirmed" : "assistant_action_cancelled",
          objectType: "assistant_action",
          objectId: params.id,
          next: { decision: body.decision, outcome: blocks[0]?.type }
        })
      );
      const saved = await tx((c) => addMessageIfConversation(c, organizationId, conversationId, principal.userId, "assistant", "", blocks, body.decision));
      return { conversation_id: conversationId ?? null, message: saved ?? { id: null, role: "assistant", blocks, created_at: new Date().toISOString() } };
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/assistant/conversations/latest",
    summary: "Your most recent Setra Assistant conversation in this workspace and mode",
    tags: ["assistant"],
    permission: "read",
    sessionOnly: true,
    handler: async ({ principal, organizationId, environment, tx }) => {
      if (principal.kind !== "user") throw new Error("unreachable");
      return tx(async (c) => {
        const conv = (
          await c.query("SELECT * FROM assistant_conversations WHERE organization_id = $1 AND environment = $2 AND user_id = $3 ORDER BY updated_at DESC LIMIT 1", [organizationId, environment, principal.userId])
        ).rows[0] as Row | undefined;
        if (!conv) return { conversation_id: null, messages: [] };
        const messages = (await c.query("SELECT id, role, text, blocks, created_at FROM assistant_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 60", [conv.id])).rows.reverse();
        return { conversation_id: conv.id, messages };
      });
    }
  });

  // Seti promised to say when an invoice gets paid ("I'll let you know as soon as they pay"). This
  // keeps that promise: payments for invoices it's watching in this conversation become Seti
  // messages, once each, saved so they're waiting even if the chat was closed when the money came in.
  route(app, {
    method: "GET",
    url: "/v1/assistant/conversations/:id/updates",
    summary: "New Seti messages about payments for invoices it's watching in this conversation",
    tags: ["assistant"],
    permission: "read",
    sessionOnly: true,
    params: idParam,
    rateLimit: { max: 120, timeWindow: "1 minute" },
    handler: async ({ params, principal, organizationId, environment, tx, request }) => {
      if (principal.kind !== "user") throw new Error("unreachable");
      const pending = await tx(async (c) => {
        const conv = (await c.query("SELECT id FROM assistant_conversations WHERE id = $1 AND organization_id = $2 AND environment = $3 AND user_id = $4", [params.id, organizationId, environment, principal.userId])).rows[0];
        if (!conv) return [];
        // Invoices Seti created here, or said it would watch, and from when.
        const watched = (
          await c.query(
            `SELECT inv_id, min(since) AS since FROM (
               SELECT b->'invoice'->>'id' AS inv_id, m.created_at AS since
                 FROM assistant_messages m, jsonb_array_elements(m.blocks) b
                WHERE m.conversation_id = $1 AND m.role = 'assistant' AND b->>'type' = 'payment_request'
               UNION ALL
               SELECT i->>'id', m.created_at
                 FROM assistant_messages m, jsonb_array_elements(m.blocks) b, jsonb_array_elements(b->'items') i
                WHERE m.conversation_id = $1 AND m.role = 'assistant' AND b->>'type' = 'invoices'
                  AND m.blocks::text LIKE '%let you know as soon as a payment comes in%'
             ) w WHERE inv_id IS NOT NULL GROUP BY inv_id`,
            [conv.id]
          )
        ).rows as Array<{ inv_id: string; since: Date }>;
        if (!watched.length) return [];
        const events = (
          await c.query(
            `SELECT fe.id, fe.type, fe.payment_id, fe.invoice_id, fe.data, fe.created_at FROM financial_events fe
              WHERE fe.organization_id = $1 AND fe.environment = $2 AND fe.type IN ('PAYMENT_MATCHED','PARTIALLY_PAID','OVERPAID')
                AND fe.invoice_id = ANY($3::text[])
                AND NOT EXISTS (SELECT 1 FROM assistant_messages m WHERE m.conversation_id = $4 AND m.intent = 'payment_update:' || fe.id)
              ORDER BY fe.created_at`,
            [organizationId, environment, watched.map((w) => w.inv_id), conv.id]
          )
        ).rows as Row[];
        const since = new Map(watched.map((w) => [w.inv_id, new Date(w.since).getTime()]));
        return events.filter((e) => new Date(e.created_at).getTime() >= (since.get(e.invoice_id) ?? Infinity) - 1000);
      });
      if (!pending.length) return { messages: [] };
      const ctx = { app, cookie: String(request.headers.cookie ?? ""), organizationId, environment, userId: principal.userId, can: (p: Parameters<typeof can>[1]) => can(principal, p), tz: "UTC", now: new Date(), messageId: params.id, conversationId: params.id, pending: null } as AssistantContext;
      const messages = [];
      for (const e of pending) {
        const blocks = await paymentUpdate(ctx, e);
        const saved = await tx(async (c) => {
          // Two tabs polling at once must not announce the same payment twice.
          await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`seti-update:${params.id}:${e.id}`]);
          const done = (await c.query("SELECT 1 FROM assistant_messages WHERE conversation_id = $1 AND intent = $2", [params.id, `payment_update:${e.id}`])).rows[0];
          if (done) return null;
          await c.query("UPDATE assistant_conversations SET updated_at = now() WHERE id = $1", [params.id]);
          return addMessage(c, organizationId, params.id, "assistant", "", `payment_update:${e.id}`, blocks);
        });
        if (saved) messages.push(saved);
      }
      return { messages };
    }
  });

  // ── notifications ────────────────────────────────────────────────────────────────────────────

  route(app, {
    method: "GET",
    url: "/v1/notifications",
    summary: "Business-ready payment notifications (from financial events)",
    tags: ["assistant"],
    permission: "read",
    sessionOnly: true,
    query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
    handler: async ({ query, principal, organizationId, environment, tx }) => {
      if (principal.kind !== "user") throw new Error("unreachable");
      return tx(async (c) => {
        const seen = (await c.query("SELECT notifications_seen_at FROM organization_members WHERE organization_id = $1 AND user_id = $2", [organizationId, principal.userId])).rows[0]?.notifications_seen_at ?? null;
        const where = `fe.organization_id = $1 AND fe.environment = $2 AND fe.type = ANY($3) AND (fe.type <> 'PAYMENT_OBSERVED' OR p.status = 'confirming')`;
        const rows = (
          await c.query(
            `SELECT fe.id, fe.type, fe.created_at, fe.payment_id, fe.data, p.status AS payment_status, i.title AS current_title
               FROM financial_events fe JOIN payments p ON p.id = fe.payment_id LEFT JOIN invoices i ON i.id = fe.invoice_id
              WHERE ${where} ORDER BY fe.id DESC LIMIT $4`,
            [organizationId, environment, NOTIFY_TYPES, query.limit]
          )
        ).rows;
        const unread = (
          await c.query(`SELECT count(*)::int AS n FROM financial_events fe JOIN payments p ON p.id = fe.payment_id WHERE ${where} AND ($4::timestamptz IS NULL OR fe.created_at > $4)`, [organizationId, environment, NOTIFY_TYPES, seen])
        ).rows[0].n as number;
        return { object: "list", unread, seen_at: seen, data: rows.map((r) => notification(r, seen)) };
      });
    }
  });

  route(app, {
    method: "POST",
    url: "/v1/notifications/seen",
    summary: "Mark notifications as seen",
    tags: ["assistant"],
    permission: "read",
    sessionOnly: true,
    handler: async ({ principal, organizationId, tx }) => {
      if (principal.kind !== "user") throw new Error("unreachable");
      await tx((c) => c.query("UPDATE organization_members SET notifications_seen_at = now() WHERE organization_id = $1 AND user_id = $2", [organizationId, principal.userId]));
      return { ok: true };
    }
  });
}

async function loadConversation(c: Client, organizationId: string, environment: string, userId: string, id?: string): Promise<Row> {
  if (id) {
    const found = (await c.query("SELECT * FROM assistant_conversations WHERE id = $1 AND organization_id = $2 AND environment = $3 AND user_id = $4", [id, organizationId, environment, userId])).rows[0];
    if (found) return found;
  }
  const newIdValue = newId("assistantConversation");
  return (await c.query("INSERT INTO assistant_conversations (id, organization_id, environment, user_id) VALUES ($1,$2,$3,$4) RETURNING *", [newIdValue, organizationId, environment, userId])).rows[0];
}

async function addMessage(c: Client, organizationId: string, conversationId: string, role: "user" | "assistant", text: string, intent: string | null, blocks: Block[]) {
  const id = newId("assistantMessage");
  const row = (
    await c.query(
      `INSERT INTO assistant_messages (id, organization_id, conversation_id, role, text, intent, blocks) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, role, text, blocks, created_at`,
      [id, organizationId, conversationId, role, text.slice(0, 2000), intent, JSON.stringify(blocks)]
    )
  ).rows[0];
  return row as { id: string; role: string; text: string; blocks: Block[]; created_at: string };
}

async function addMessageIfConversation(c: Client, organizationId: string, conversationId: string | undefined, userId: string, role: "user" | "assistant", text: string, blocks: Block[] = [], intent: string | null = null) {
  if (!conversationId) return null;
  const owned = (await c.query("SELECT 1 FROM assistant_conversations WHERE id = $1 AND user_id = $2", [conversationId, userId])).rows[0];
  if (!owned) return null;
  return addMessage(c, organizationId, conversationId, role, text, intent, blocks);
}

// ── notification cards ───────────────────────────────────────────────────────────────────────────

const NOTIFY_TYPES = ["PAYMENT_OBSERVED", "PAYMENT_MATCHED", "PARTIALLY_PAID", "OVERPAID", "UNKNOWN_PAYMENT", "PAYMENT_REVERSED", "REFUND_OBSERVED", "PAYMENT_UNASSIGNED"];

export interface NotificationCard {
  id: string;
  event_type: string;
  kind: "detected" | "received" | "partial" | "overpaid" | "review" | "duplicate" | "unknown" | "reversed" | "refunded" | "unassigned";
  tone: "success" | "warning" | "info" | "danger";
  title: string;
  headline: string;
  rows: Array<[string, string]>;
  note: string | null;
  href: string;
  test_mode: boolean;
  unread: boolean;
  created_at: string;
}

export function notification(r: Row, seen: string | null): NotificationCard {
  const d = r.data ?? {};
  const pay = d.payment ?? {};
  // Events recorded before purposes existed carry no title in their snapshot; show the invoice's.
  const inv = d.invoice ? { ...d.invoice, title: d.invoice.title ?? r.current_title ?? null } : null;
  const asset = pay.asset ?? "";
  const amount = formatAmount(pay.amount, asset);
  const who = d.customer?.name ?? null;
  const tx = pay.simulated ? "Simulated (no transaction)" : pay.transaction_hash ? `${pay.transaction_hash.slice(0, 10)}…${pay.transaction_hash.slice(-6)}` : "-";
  const base = { id: r.id, event_type: r.type, href: `/app/payments/${r.payment_id}`, test_mode: d.livemode === false, unread: !seen || new Date(r.created_at) > new Date(seen), created_at: new Date(r.created_at).toISOString() };
  const network: [string, string] = ["Network", pay.network_name ?? "-"];
  const txRow: [string, string] = ["Transaction", tx];
  switch (r.type) {
    case "PAYMENT_OBSERVED": {
      const prov = d.provisional_invoice;
      return { ...base, kind: "detected", tone: "info", title: "Payment detected", headline: `${who ?? "A sender"} is paying ${amount}`, rows: [["For", prov?.title ?? "Being identified"], ["Invoice", prov?.number ?? "-"], ["Status", "Detected · confirming"], network, txRow], note: "Not yet final. Nothing is applied until the block is confirmed." };
    }
    case "PAYMENT_MATCHED":
      return { ...base, kind: "received", tone: "success", title: "Payment received", headline: `${who ?? "Customer"} paid ${amount}`, rows: [["For", inv?.title ?? "-"], ["Invoice", inv?.number ?? "-"], ["Status", "Matched & confirmed"], network, txRow], note: null };
    case "PARTIALLY_PAID":
      return {
        ...base,
        kind: "partial",
        tone: "warning",
        title: "Partial payment received",
        headline: `${who ?? "Customer"} paid ${amount}`,
        rows: [["For", inv?.title ?? "-"], ["Invoice", inv?.number ?? "-"], ["Paid so far", formatAmount(inv?.amount_paid, asset)], ["Outstanding", formatAmount(inv?.amount_remaining, asset)], ["Status", "Partially paid"], network],
        note: null
      };
    case "OVERPAID": {
      const due = inv?.amount_due ?? "0";
      const diff = subtract(inv?.amount_paid ?? "0", due);
      return {
        ...base,
        kind: "overpaid",
        tone: "warning",
        title: "Payment requires review",
        headline: `${who ?? "Customer"} sent ${amount}`,
        rows: [["For", inv?.title ?? "-"], ["Invoice", inv?.number ?? "-"], ["Expected", formatAmount(due, asset)], ["Difference", `+${formatAmount(diff, asset)}`], ["Status", "Overpaid"], network],
        note: "The invoice is paid; the extra amount is waiting for your decision (refund or keep as credit)."
      };
    }
    case "UNKNOWN_PAYMENT": {
      const type = d.decision?.exception_type ?? "unknown_payment";
      const candidate = d.decision?.candidates?.[0];
      if (type === "duplicate_payment") {
        return { ...base, kind: "duplicate", tone: "warning", title: "Possible duplicate payment", headline: `${who ?? "A sender"} sent ${amount} again`, rows: [["Original invoice", candidate?.number ?? "-"], ["Status", "Needs review, not applied"], network, txRow], note: "Review it in Setra: refund it, apply it to another invoice, or acknowledge it." };
      }
      const titles: Record<string, string> = { wrong_token: "Unsupported token received", wrong_network: "Payment on the wrong network", late_payment: "Late payment received", ambiguous_match: "Payment could match more than one invoice" };
      return {
        ...base,
        kind: "unknown",
        tone: "warning",
        title: titles[type] ?? "Unidentified payment detected",
        headline: `${amount} received on ${pay.network_name ?? "Monad"}`,
        rows: [["Customer", who ?? "Unknown"], ["Purpose", "Unknown"], ["Wallet", pay.recipient ? `${pay.recipient.slice(0, 8)}…${pay.recipient.slice(-4)}` : "-"], txRow],
        note: "Setra didn't guess. Review this payment in Setra."
      };
    }
    case "PAYMENT_REVERSED":
      return { ...base, kind: "reversed", tone: "danger", title: "Payment reversed", headline: `${amount} is no longer on the canonical chain`, rows: [["Invoice", inv?.number ?? "-"], ["For", inv?.title ?? "-"], network, txRow], note: "Its effect was reversed; the history is kept." };
    case "REFUND_OBSERVED":
      return { ...base, kind: "refunded", tone: "info", title: "Refund recorded", headline: `${formatAmount(d.refund?.amount ?? pay.amount, asset)} sent back${who ? ` to ${who}` : ""}`, rows: [["Refund transaction", d.refund?.transaction_hash ? `${d.refund.transaction_hash.slice(0, 10)}…` : "-"], network], note: null };
    default:
      return { ...base, kind: "unassigned", tone: "info", title: "Payment moved", headline: `${amount} taken off ${d.correction?.from_invoice?.number ?? "an invoice"}`, rows: [["Reason", d.correction?.reason ?? "-"], ["Now", d.correction?.to_invoice ? d.correction.to_invoice.number : "Back in review"]], note: null };
  }
}

function subtract(a: string, b: string): string {
  const units = (v: string) => {
    const [w = "0", f = ""] = v.split(".");
    return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0").slice(0, 6) || "0");
  };
  const diff = units(a) - units(b);
  const abs = diff < 0n ? -diff : diff;
  return `${diff < 0n ? "-" : ""}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
}
