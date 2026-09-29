import type { FastifyInstance } from "fastify";
import { networks } from "@setra/config";
import type { Client } from "@setra/database";
import { amount, correctPayment, decimalString, decimalsFor, explorerTx, recordRefund, refundCandidates, resolveException, serializeLineItems, serializeDecision, serializeException, serializeObservation, serializePayment, serializePaymentIntent, serializeResolution } from "@setra/engine";
import { ALLOWED_RESOLUTIONS, correctPaymentInput, exceptionListQuery, paymentListQuery, recordRefundInput, resolveExceptionInput, type ExceptionType } from "@setra/schemas";
import { notFound } from "../lib/errors";
import { page } from "../lib/pagination";
import { idParam, route } from "../lib/route";

type Row = Record<string, any>;

/**
 * Payments joined with their business context: the invoice they were applied to or, while still
 * confirming, the invoice they provisionally matched. Shared by lists, detail, dashboard and exports
 * so purpose is identical everywhere.
 */
export const PAYMENT_COLUMNS = `p.*, c.name AS customer_name, i.id AS ctx_invoice_id, i.number AS invoice_number, i.status AS invoice_status,
  i.title AS invoice_title, i.purpose AS invoice_purpose, w.name AS wallet_name`;
export const PAYMENT_FROM = `FROM payments p LEFT JOIN customers c ON c.id = p.customer_id
  LEFT JOIN invoices i ON i.id = COALESCE(p.invoice_id, CASE WHEN p.status = 'confirming' THEN p.provisional_invoice_id END)
  JOIN wallets w ON w.id = p.wallet_id`;
const PAYMENT_SELECT = `SELECT ${PAYMENT_COLUMNS} ${PAYMENT_FROM}`;

export const presentPayment = (row: Row) =>
  serializePayment(row, {
    customer: row.customer_id ? { id: row.customer_id, name: row.customer_name } : null,
    invoice: row.ctx_invoice_id
      ? { id: row.ctx_invoice_id, number: row.invoice_number, status: row.invoice_status, title: row.invoice_title, purpose: row.invoice_purpose }
      : null,
    wallet: { id: row.wallet_id, name: row.wallet_name }
  });

/** Shared by the list endpoint and CSV export so both apply identical filters. */
export function paymentFilter(query: Record<string, any>, organizationId: string, environment: string) {
  const params: unknown[] = [organizationId, environment];
  let where = "p.organization_id = $1 AND p.environment = $2";
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where += ` AND ${sql.replaceAll("?", `$${params.length}`)}`;
  };
  if (query.status === "settled") where += " AND p.status IN ('matched','partial','overpaid')";
  else if (query.status) add("p.status = ?", query.status);
  if (query.customer_id) add("p.customer_id = ?", query.customer_id);
  if (query.invoice_id) add("(p.invoice_id = ? OR p.provisional_invoice_id = ?)", query.invoice_id);
  if (query.wallet_id) add("p.wallet_id = ?", query.wallet_id);
  if (query.network) {
    const chainIds = networks().all.filter((n) => n.family === query.network).map((n) => n.chainId);
    add("p.chain_id = ANY(?)", chainIds);
  }
  if (query.asset) {
    const assetIds = networks().all.flatMap((n) => n.assets.filter((a) => a.symbol === query.asset).map((a) => a.id));
    add("p.asset_id = ANY(?)", assetIds);
  }
  if (query.created_gte) add("p.block_timestamp >= ?", query.created_gte);
  if (query.created_lte) add("p.block_timestamp <= ?", query.created_lte);
  if (query.search) {
    const s = query.search.trim().toLowerCase();
    if (/^pay_[0-9a-z]{20,32}$/i.test(query.search.trim())) add("p.id = ?", query.search.trim());
    else if (/^0x[0-9a-f]{64}$/.test(s)) add("p.transaction_hash = ?", s);
    else if (/^0x[0-9a-f]{40}$/.test(s)) add("p.from_address = ?", s);
    else add("(c.name ILIKE ? OR i.number ILIKE ? OR i.title ILIKE ? OR i.purpose ILIKE ? OR p.transaction_hash LIKE ? OR p.from_address LIKE ?)", `%${s.replace(/[%_\\]/g, "\\$&")}%`);
  }
  return { where, params };
}

export function paymentRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/payments",
    summary: "List payments that arrived at your wallets",
    tags: ["payments"],
    permission: "read",
    query: paymentListQuery,
    handler: async ({ query, tx, organizationId, environment }) =>
      tx(async (c) => {
        const { where: base, params } = paymentFilter(query, organizationId, environment);
        let where = base;
        const sort = {
          newest: { order: "p.id DESC", key: "p.id", dir: "<" },
          oldest: { order: "p.id ASC", key: "p.id", dir: ">" },
          amount_desc: { order: "p.amount DESC, p.id DESC", key: "(p.amount, p.id)", dir: "<" },
          amount_asc: { order: "p.amount ASC, p.id ASC", key: "(p.amount, p.id)", dir: ">" }
        }[query.sort];
        if (query.starting_after) {
          params.push(query.starting_after);
          const ref = `$${params.length}`;
          where += sort.key === "p.id" ? ` AND p.id ${sort.dir} ${ref}` : ` AND ${sort.key} ${sort.dir} ((SELECT amount FROM payments WHERE id = ${ref}), ${ref})`;
        }
        params.push(query.limit + 1);
        const rows = (await c.query(`${PAYMENT_SELECT} WHERE ${where} ORDER BY ${sort.order} LIMIT $${params.length}`, params)).rows;
        return page(rows, query.limit, presentPayment);
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/payments/summary",
    summary: "Counts and totals for payments matching the same filters as GET /v1/payments",
    tags: ["payments"],
    permission: "read",
    query: paymentListQuery.omit({ limit: true, starting_after: true, ending_before: true, sort: true }),
    handler: async ({ query, tx, organizationId, environment }) =>
      tx(async (c) => {
        const { where, params } = paymentFilter(query, organizationId, environment);
        const usd = "(CASE WHEN a.peg_currency = 'USD' THEN p.amount / power(10::numeric, a.decimals) ELSE 0 END)";
        const r = (
          await c.query(
            `SELECT
               count(*) FILTER (WHERE p.status <> 'reversed')::int AS count,
               count(*) FILTER (WHERE p.status = 'matched')::int AS matched,
               count(*) FILTER (WHERE p.status = 'partial')::int AS partial,
               count(*) FILTER (WHERE p.status = 'overpaid')::int AS overpaid,
               count(*) FILTER (WHERE p.status = 'needs_review')::int AS needs_review,
               count(*) FILTER (WHERE p.status = 'confirming')::int AS confirming,
               count(*) FILTER (WHERE p.status = 'dismissed')::int AS dismissed,
               count(*) FILTER (WHERE p.status = 'refunded')::int AS refunded,
               count(*) FILTER (WHERE p.status = 'reversed')::int AS reversed,
               count(*) FILTER (WHERE p.asset_id IS NULL)::int AS unsupported_tokens,
               COALESCE(sum(${usd}) FILTER (WHERE p.status IN ('matched','partial','overpaid','needs_review','dismissed','refunded')), 0)::text AS received,
               COALESCE(sum(${usd}) FILTER (WHERE p.status IN ('matched','partial','overpaid')), 0)::text AS applied,
               COALESCE(sum(${usd}) FILTER (WHERE p.status = 'needs_review'), 0)::text AS needs_review_amount,
               COALESCE(sum(${usd}) FILTER (WHERE p.status = 'confirming'), 0)::text AS confirming_amount,
               count(*) FILTER (WHERE p.source = 'simulated' AND p.status <> 'reversed')::int AS simulated
             ${PAYMENT_FROM} LEFT JOIN assets a ON a.id = p.asset_id WHERE ${where}`,
            params
          )
        ).rows[0];
        const byAsset = (
          await c.query(
            `SELECT a.symbol, COALESCE(sum(${usd}), 0)::text AS received, count(*)::int AS count
               ${PAYMENT_FROM} JOIN assets a ON a.id = p.asset_id
              WHERE ${where} AND p.status IN ('matched','partial','overpaid','needs_review','dismissed','refunded')
              GROUP BY a.symbol ORDER BY a.symbol`,
            params
          )
        ).rows;
        return {
          object: "payment_summary",
          currency: "USD",
          count: r.count,
          by_status: {
            matched: r.matched,
            partial: r.partial,
            overpaid: r.overpaid,
            needs_review: r.needs_review,
            confirming: r.confirming,
            dismissed: r.dismissed,
            refunded: r.refunded,
            reversed: r.reversed
          },
          received: decimalString(r.received),
          applied: decimalString(r.applied),
          needs_review_amount: decimalString(r.needs_review_amount),
          confirming_amount: decimalString(r.confirming_amount),
          by_asset: byAsset.map((b) => ({ asset: b.symbol, received: decimalString(b.received), count: b.count })),
          unsupported_tokens: r.unsupported_tokens,
          simulated: r.simulated
        };
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/payments/:id",
    summary: "Retrieve a payment with its evidence, decision and history",
    tags: ["payments"],
    permission: "read",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment }) => tx((c) => paymentDetail(c, params.id, organizationId, environment))
  });

  route(app, {
    method: "POST",
    url: "/v1/payments/:id/corrections",
    summary: "Correct an applied payment: move it to another invoice, or take it back to review",
    tags: ["payments"],
    permission: "exceptions:resolve",
    params: idParam,
    body: correctPaymentInput,
    handler: async ({ params, body, tx, organizationId, environment, actor }) =>
      tx(async (c) => {
        await paymentDetail(c, params.id, organizationId, environment); // 404 across tenants/modes
        await correctPayment(c, organizationId, params.id, body, actor);
        return paymentDetail(c, params.id, organizationId, environment);
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/payments/:id/refund-candidates",
    summary: "Outgoing transfers from the receiving wallet that could be this payment's refund",
    tags: ["payments"],
    permission: "read",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment }) =>
      tx(async (c) => {
        const p = await paymentDetail(c, params.id, organizationId, environment);
        return { object: "list", data: (await refundCandidates(c, params.id)).map(presentOutgoing), refundable: p.refunds_summary.refundable };
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/payments/:id/refunds",
    summary: "Record a refund of this payment, proven by an outgoing transfer from your wallet",
    tags: ["payments"],
    permission: "exceptions:resolve",
    params: idParam,
    body: recordRefundInput,
    handler: async ({ params, body, tx, organizationId, environment, actor, reply }) =>
      tx(async (c) => {
        await paymentDetail(c, params.id, organizationId, environment);
        await recordRefund(c, organizationId, params.id, body, actor);
        reply.code(201);
        return paymentDetail(c, params.id, organizationId, environment);
      })
  });

  // ── exceptions ─────────────────────────────────────────────────────────────────────────────

  route(app, {
    method: "GET",
    url: "/v1/exceptions",
    summary: "List exceptions (the review queue)",
    tags: ["exceptions"],
    permission: "read",
    query: exceptionListQuery,
    handler: async ({ query, tx, organizationId, environment }) =>
      tx(async (c) => {
        const params: unknown[] = [organizationId, environment];
        let where = "e.organization_id = $1 AND e.environment = $2";
        if (query.status) {
          params.push(query.status);
          where += ` AND e.status = $${params.length}`;
        }
        if (query.type) {
          params.push(query.type);
          where += ` AND e.type = $${params.length}`;
        }
        if (query.starting_after) {
          params.push(query.starting_after);
          where += ` AND e.id < $${params.length}`;
        }
        params.push(query.limit + 1);
        const rows = (
          await c.query(
            `SELECT e.*, c.name AS customer_name, i.number AS invoice_number, i.title AS invoice_title FROM exceptions e LEFT JOIN customers c ON c.id = e.customer_id LEFT JOIN invoices i ON i.id = e.invoice_id
              WHERE ${where} ORDER BY e.id DESC LIMIT $${params.length}`,
            params
          )
        ).rows;
        return page(rows, query.limit, (e) =>
          serializeException(e, { customer: e.customer_id ? { id: e.customer_id, name: e.customer_name } : null, invoice: e.invoice_id ? { id: e.invoice_id, number: e.invoice_number, title: e.invoice_title } : null })
        );
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/exceptions/:id",
    summary: "Retrieve an exception with its payment and candidates",
    tags: ["exceptions"],
    permission: "read",
    params: idParam,
    handler: async ({ params, tx, organizationId, environment }) =>
      tx(async (c) => {
        const e = (await c.query("SELECT * FROM exceptions WHERE id = $1 AND organization_id = $2 AND environment = $3", [params.id, organizationId, environment])).rows[0];
        if (!e) throw notFound("exception");
        return exceptionDetail(c, e, organizationId, environment);
      })
  });

  route(app, {
    method: "POST",
    url: "/v1/exceptions/:id/resolve",
    summary: "Resolve an exception",
    tags: ["exceptions"],
    permission: "exceptions:resolve",
    params: idParam,
    body: resolveExceptionInput,
    handler: async ({ params, body, tx, organizationId, environment, actor }) =>
      tx(async (c) => {
        const e = (await c.query("SELECT id FROM exceptions WHERE id = $1 AND organization_id = $2 AND environment = $3", [params.id, organizationId, environment])).rows[0];
        if (!e) throw notFound("exception");
        const { exception } = await resolveException(c, organizationId, params.id, body, actor);
        return exceptionDetail(c, exception, organizationId, environment);
      })
  });
}

async function exceptionDetail(c: Client, e: Row, organizationId: string, environment: string) {
  const customer = e.customer_id ? (await c.query("SELECT id, name FROM customers WHERE id = $1", [e.customer_id])).rows[0] : null;
  const invoice = e.invoice_id ? (await c.query("SELECT id, number, title FROM invoices WHERE id = $1", [e.invoice_id])).rows[0] : null;
  // Business context of every candidate invoice, and for a possible duplicate, what already paid it.
  const candidateIds = [...new Set<string>((e.candidates ?? []).map((x: Row) => x.invoiceId).filter(Boolean))];
  const candidateInvoices = candidateIds.length
    ? (await c.query("SELECT i.id, i.number, i.title, i.purpose, i.status, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ANY($1)", [candidateIds])).rows
    : [];
  const priorPayments =
    e.type === "duplicate_payment" && candidateIds.length
      ? (
          await c.query(
            `SELECT p.id, p.invoice_id, p.amount, p.asset_id, p.transaction_hash, p.block_timestamp, p.status, p.source FROM payments p
              WHERE p.invoice_id = ANY($1) AND p.id <> $2 AND p.status IN ('matched','partial','overpaid') ORDER BY p.block_timestamp`,
            [candidateIds, e.payment_id]
          )
        ).rows
      : [];
  const resolution = e.resolution_id ? (await c.query("SELECT * FROM resolutions WHERE id = $1", [e.resolution_id])).rows[0] : null;
  const payment = await paymentDetail(c, e.payment_id, organizationId, environment);
  // Open invoices the operator could assign this payment to, most relevant first (candidates, then same asset/network).
  const assignable = (
    await c.query(
      `SELECT i.id, i.number, i.title, i.status, i.amount_due, i.amount_paid, i.amount_written_off, i.asset_id, i.chain_id, c.name AS customer_name
         FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE i.organization_id = $1 AND i.environment = $2 AND i.status IN ('open','partially_paid','expired')
        ORDER BY (i.customer_id = $3) DESC NULLS LAST, i.id DESC LIMIT 50`,
      [organizationId, environment, e.customer_id]
    )
  ).rows;
  const refundAllowed = e.status === "open" && ALLOWED_RESOLUTIONS[e.type as ExceptionType].includes("refund");
  const candidatesForRefund = refundAllowed ? (await refundCandidates(c, e.payment_id)).map(presentOutgoing) : [];
  const base = serializeException(e, { customer, invoice, resolution });
  return {
    ...base,
    invoice: base.invoice ? { ...base.invoice, title: invoice?.title ?? null } : null,
    candidates: base.candidates.map((cand: Row) => {
      const inv = candidateInvoices.find((x) => x.id === cand.invoice_id);
      return { ...cand, title: inv?.title ?? null, purpose: inv?.purpose ?? null, status: inv?.status ?? null };
    }),
    duplicate_of: priorPayments.map((p) => {
      const inv = candidateInvoices.find((x) => x.id === p.invoice_id)!;
      return {
        payment_id: p.id,
        amount: amount(p.amount, decimalsFor(p.asset_id)),
        transaction_hash: p.transaction_hash,
        paid_at: p.block_timestamp,
        simulated: p.source === "simulated",
        invoice: { id: inv.id, number: inv.number, title: inv.title ?? null, customer_name: inv.customer_name }
      };
    }),
    allowed_actions: e.status === "open" ? ALLOWED_RESOLUTIONS[e.type as ExceptionType] : [],
    refund_candidates: candidatesForRefund,
    payment,
    assignable_invoices: assignable.map((i) => ({
      id: i.id,
      number: i.number,
      title: i.title ?? null,
      status: i.status,
      customer_name: i.customer_name,
      amount_remaining: amount(BigInt(i.amount_due) - BigInt(i.amount_paid) - BigInt(i.amount_written_off), decimalsFor(i.asset_id)),
      network: networks().byChainId(Number(i.chain_id))?.family ?? null
    }))
  };
}

export async function paymentDetail(c: Client, id: string, organizationId: string, environment: string) {
  const row = (await c.query(`${PAYMENT_SELECT} WHERE p.id = $1 AND p.organization_id = $2 AND p.environment = $3`, [id, organizationId, environment])).rows[0];
  if (!row) throw notFound("payment");
  const observations = (await c.query("SELECT * FROM source_observations WHERE id = ANY($1) ORDER BY log_index", [[row.observation_id, row.supporting_observation_id].filter(Boolean)])).rows;
  const stateChanges = (await c.query("SELECT * FROM observation_state_changes WHERE observation_id = $1 ORDER BY id", [row.observation_id])).rows;
  const decisions = (await c.query("SELECT * FROM match_decisions WHERE payment_id = $1 ORDER BY id", [row.id])).rows;
  const events = (await c.query("SELECT id, type, created_at, rule_version, reverses_event_id, resolution_id FROM financial_events WHERE payment_id = $1 ORDER BY id", [row.id])).rows;
  const exceptions = (await c.query("SELECT * FROM exceptions WHERE payment_id = $1 ORDER BY id", [row.id])).rows;
  const resolutions = exceptions.length ? (await c.query("SELECT * FROM resolutions WHERE exception_id = ANY($1) ORDER BY id", [exceptions.map((e) => e.id)])).rows : [];
  const intent = row.payment_intent_id ? (await c.query("SELECT * FROM payment_intents WHERE id = $1", [row.payment_intent_id])).rows[0] : null;
  const contextInvoiceId = row.ctx_invoice_id as string | null;
  const invoice = contextInvoiceId
    ? (await c.query("SELECT id, number, title, purpose, status, amount_due, amount_paid, amount_written_off, currency, asset_id, due_at FROM invoices WHERE id = $1", [contextInvoiceId])).rows[0]
    : null;
  const lineItems = invoice ? (await c.query("SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position", [invoice.id])).rows : [];
  const corrections = (
    await c.query(
      `SELECT pc.*, f.number AS from_number, f.title AS from_title, t.number AS to_number, t.title AS to_title FROM payment_corrections pc
         JOIN invoices f ON f.id = pc.from_invoice_id LEFT JOIN invoices t ON t.id = pc.to_invoice_id WHERE pc.payment_id = $1 ORDER BY pc.id`,
      [row.id]
    )
  ).rows;
  const refunds = (await c.query("SELECT r.*, o.transaction_hash, o.to_address, o.block_number, o.block_timestamp, o.chain_id FROM refunds r JOIN outgoing_transfers o ON o.id = r.outgoing_transfer_id WHERE r.payment_id = $1 ORDER BY r.id", [row.id])).rows;
  const refundedUnits = refunds.reduce((sum, r) => sum + BigInt(r.amount), 0n);
  const dec = decimalsFor(row.asset_id);
  let refundableUnits = 0n;
  if (["needs_review", "dismissed"].includes(row.status)) refundableUnits = BigInt(row.amount) - refundedUnits;
  else if (row.status === "overpaid" && invoice) {
    const excess = BigInt(invoice.amount_paid) - BigInt(invoice.amount_due);
    refundableUnits = (excess < BigInt(row.amount) ? excess : BigInt(row.amount)) - refundedUnits;
  }
  const finalDecision = [...decisions].reverse().find((d) => d.stage === "final") ?? null;
  const primary = observations.find((o) => o.id === row.observation_id)!;
  const presented = presentPayment(row);
  return {
    ...presented,
    invoice_detail: invoice
      ? {
          id: invoice.id,
          number: invoice.number,
          title: invoice.title ?? null,
          purpose: invoice.purpose ?? null,
          line_items: serializeLineItems(lineItems, decimalsFor(invoice.asset_id)),
          status: invoice.status,
          currency: invoice.currency,
          amount_due: amount(invoice.amount_due, decimalsFor(invoice.asset_id)),
          amount_paid: amount(invoice.amount_paid, decimalsFor(invoice.asset_id)),
          amount_remaining: amount(BigInt(invoice.amount_due) - BigInt(invoice.amount_paid) - BigInt(invoice.amount_written_off), decimalsFor(invoice.asset_id)),
          due_at: invoice.due_at
        }
      : null,
    context_history: await contextHistory(c, decisions, resolutions, events, corrections, refunds),
    corrections: corrections.map((k) => ({
      id: k.id,
      action: k.action,
      reason: k.reason,
      from_invoice: { id: k.from_invoice_id, number: k.from_number, title: k.from_title ?? null },
      to_invoice: k.to_invoice_id ? { id: k.to_invoice_id, number: k.to_number, title: k.to_title ?? null } : null,
      actor: { type: k.actor_type, id: k.actor_id ?? null, label: k.actor_label ?? null },
      created_at: k.created_at
    })),
    refunds: refunds.map((r) => ({
      id: r.id,
      amount: amount(r.amount, dec),
      reason: r.reason,
      to: r.to_address,
      transaction_hash: r.transaction_hash,
      block_number: String(r.block_number),
      explorer_url: explorerTx(Number(r.chain_id), r.transaction_hash),
      sent_at: r.block_timestamp,
      actor: { type: r.actor_type, id: r.actor_id ?? null, label: r.actor_label ?? null },
      created_at: r.created_at
    })),
    refunds_summary: { refunded: amount(refundedUnits, dec), refundable: amount(refundableUnits > 0n ? refundableUnits : 0n, dec) },
    correctable: ["matched", "partial", "overpaid"].includes(row.status) && !row.payment_intent_id && refunds.length === 0,
    detection: await detection(c, primary, decisions),
    evidence: serializeObservation(primary),
    supporting_evidence: observations.filter((o) => o.id !== row.observation_id).map(serializeObservation),
    confirmation_history: stateChanges.map((s) => ({ from: s.from_state, to: s.to_state, canonical: s.canonical, reason: s.reason, at: s.created_at })),
    decision: serializeDecision(finalDecision ?? decisions[decisions.length - 1]),
    decisions: decisions.map(serializeDecision),
    financial_events: events,
    exceptions: exceptions.map((e) => serializeException(e)),
    resolutions: resolutions.map(serializeResolution),
    payment_intent: intent ? serializePaymentIntent(intent) : null
  };
}

/**
 * How this payment's business context developed, oldest first: each decision (provisional and final),
 * each operator resolution, and any reversal. Nothing is rewritten: a payment that was unknown and
 * later assigned shows both steps.
 */
async function contextHistory(c: Client, decisions: Row[], resolutions: Row[], events: Row[], corrections: Row[] = [], refunds: Row[] = []) {
  const invoiceIds = [...new Set([...decisions.map((d) => d.invoice_id), ...resolutions.map((r) => r.invoice_id), ...corrections.map((k) => k.to_invoice_id)].filter(Boolean))];
  const invoices = invoiceIds.length ? (await c.query("SELECT id, number, title FROM invoices WHERE id = ANY($1)", [invoiceIds])).rows : [];
  const ref = (id: string | null) => {
    const i = id ? invoices.find((x) => x.id === id) : null;
    return i ? { id: i.id, number: i.number, title: i.title ?? null } : null;
  };
  const steps = [
    ...decisions.map((d) => ({
      at: d.created_at,
      kind: d.stage === "final" ? "decision" : "provisional_decision",
      outcome: d.outcome,
      exception_type: d.exception_type ?? null,
      summary: d.explanation,
      invoice: ref(d.invoice_id),
      actor: "Setra"
    })),
    ...resolutions.map((r) => ({
      at: r.created_at,
      kind: "resolution",
      outcome: r.action,
      exception_type: null,
      summary: r.reason,
      invoice: ref(r.invoice_id),
      actor: r.actor_label ?? r.actor_type
    })),
    ...corrections.map((k) => ({
      at: k.created_at,
      kind: "correction",
      outcome: k.action,
      exception_type: null,
      summary: k.reason,
      invoice: k.to_invoice_id ? ref(k.to_invoice_id) : null,
      from_invoice: { id: k.from_invoice_id, number: k.from_number, title: k.from_title ?? null },
      actor: k.actor_label ?? k.actor_type
    })),
    ...refunds.map((r) => ({
      at: r.created_at,
      kind: "refund",
      outcome: "refunded",
      exception_type: null,
      summary: r.reason,
      invoice: null,
      transaction_hash: r.transaction_hash,
      actor: r.actor_label ?? r.actor_type
    })),
    ...events
      .filter((e) => e.type === "PAYMENT_REVERSED")
      .map((e) => ({ at: e.created_at, kind: "reversal", outcome: "reversed", exception_type: null, summary: "The block containing this payment was replaced; its effect was reversed.", invoice: null, actor: "Setra" }))
  ];
  return steps.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

/**
 * How and how fast this payment was detected, from recorded timestamps only: when the EVM executed
 * it (execution events), when each path first saw it, when Setra identified the invoice, and when
 * the canonical chain finalized it. Nothing is estimated; missing steps are null.
 */
async function detection(c: Client, obs: Row, decisions: Row[]) {
  const sightings = (await c.query("SELECT source, stage, seen_at FROM observation_sightings WHERE observation_id = $1 ORDER BY seen_at", [obs.id])).rows;
  const seen = (source: string, stage: string) => sightings.find((x) => x.source === source && x.stage === stage)?.seen_at ?? null;
  const first = sightings.find((x) => x.stage === "tip")?.seen_at ?? sightings[0]?.seen_at ?? null;
  const provisional = decisions.find((d) => d.stage === "provisional")?.created_at ?? null;
  const ms = (a: unknown, b: unknown) => (a && b ? new Date(b as string).getTime() - new Date(a as string).getTime() : null);
  const execTip = seen("execution_events", "tip");
  const rpcTip = seen("rpc", "tip");
  // The provisional match is written in the same transaction as the first sighting; its created_at is
  // the transaction start, slightly before the sighting's wall-clock time. Report that as 0, simultaneous.
  const toMatch = ms(first, provisional);
  return {
    source: obs.detection_source ?? "rpc",
    business_match_same_transaction: toMatch !== null && toMatch <= 0,
    executed_at: obs.executed_at ?? null,
    sightings: sightings.map((x) => ({ source: x.source, stage: x.stage, seen_at: x.seen_at })),
    timings_ms: {
      execution_to_detection: ms(obs.executed_at, execTip),
      detection_to_business_match: toMatch === null ? null : Math.max(toMatch, 0),
      detection_to_confirmation: ms(first, obs.finalized_at),
      execution_events_lead_over_rpc: execTip && rpcTip ? ms(execTip, rpcTip) : null
    }
  };
}

/** An outgoing transfer from a monitored wallet (refund evidence). */
export function presentOutgoing(o: Row) {
  return {
    id: o.id,
    object: "outgoing_transfer",
    amount: amount(o.amount, decimalsFor(o.asset_id)),
    asset: o.asset_id ? networks().asset(o.asset_id)?.asset.symbol ?? null : null,
    to: o.to_address,
    wallet_id: o.wallet_id,
    transaction_hash: o.transaction_hash,
    block_number: String(o.block_number),
    explorer_url: explorerTx(Number(o.chain_id), o.transaction_hash),
    sent_at: o.block_timestamp
  };
}
