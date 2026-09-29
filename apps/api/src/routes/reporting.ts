import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { networks } from "@setra/config";
import { withGlobal, type Client } from "@setra/database";
import { decimalString, serializeException } from "@setra/engine";
import { paymentListQuery, reconciliationQuery } from "@setra/schemas";
import { toCsv } from "../lib/csv";
import { route } from "../lib/route";
import { PAYMENT_COLUMNS, PAYMENT_FROM, paymentFilter, presentPayment } from "./payments";
import { walletSync } from "./wallets";

type Row = Record<string, any>;

/** USD value of base units, computed exactly in PostgreSQL numeric. */
const USD = (col: string, assetAlias = "a") => `(${col} / power(10::numeric, ${assetAlias}.decimals))`;
/** For totals: only USD-pegged stablecoins add up as dollars. Other currencies are valued in the books, with rates. */
const USDSUM = (col: string, assetAlias = "a") => `(CASE WHEN ${assetAlias}.peg_currency = 'USD' THEN ${col} / power(10::numeric, ${assetAlias}.decimals) ELSE 0 END)`;

function periodBounds(q: { period_start?: string; period_end?: string }) {
  const now = new Date();
  const start = q.period_start ? new Date(q.period_start) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = q.period_end ? new Date(q.period_end) : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end };
}

function railFilter(q: { network?: string; asset?: string }, params: unknown[], chainCol: string, assetCol: string) {
  let sql = "";
  if (q.network) {
    params.push(networks().all.filter((n) => n.family === q.network).map((n) => n.chainId));
    sql += ` AND ${chainCol} = ANY($${params.length})`;
  }
  if (q.asset) {
    params.push(networks().all.flatMap((n) => n.assets.filter((a) => a.symbol === q.asset).map((a) => a.id)));
    sql += ` AND ${assetCol} = ANY($${params.length})`;
  }
  return sql;
}

async function coverage(c: Client, organizationId: string, environment: string, end: Date) {
  const wallets = (await c.query("SELECT * FROM wallets WHERE organization_id = $1 AND environment = $2 AND archived_at IS NULL", [organizationId, environment])).rows;
  const sync = await walletSync(wallets, c);
  const statuses = [...sync.values()];
  const cursors = (await withGlobal((g) => g.query("SELECT chain_id, updated_at FROM chain_cursors WHERE stage = 'settled' AND chain_id = ANY($1)", [[...new Set(wallets.map((w) => Number(w.chain_id)))]]))).rows;
  const syncedThrough = cursors.length ? new Date(Math.min(...cursors.map((r) => new Date(r.updated_at).getTime()))) : null;
  const behind = statuses.some((s) => ["delayed", "error", "starting"].includes(s.status));
  return {
    complete: !behind && syncedThrough !== null && syncedThrough >= end,
    in_progress: end > new Date(),
    synced_through: syncedThrough?.toISOString() ?? null,
    wallets_monitored: wallets.filter((w) => w.monitoring_enabled).length,
    warning: behind
      ? "Monitoring is behind or failing for at least one wallet. Totals may be incomplete until it catches up."
      : wallets.length === 0
        ? "No receiving wallets are monitored."
        : null
  };
}

export async function reconciliation(c: Client, organizationId: string, environment: string, q: z.infer<typeof reconciliationQuery>) {
  const { start, end } = periodBounds(q);
  const ip: unknown[] = [organizationId, environment, start, end];
  const invoiceRail = railFilter(q, ip, "i.chain_id", "i.asset_id");
  const inv = (
    await c.query(
      `SELECT
         COUNT(*)::int AS count,
         COALESCE(SUM(${USDSUM("i.amount_due")}), 0)::text AS expected,
         COALESCE(SUM(${USDSUM("LEAST(i.amount_paid, i.amount_due)")}), 0)::text AS collected,
         COALESCE(SUM(${USDSUM("i.amount_written_off")}), 0)::text AS written_off,
         COALESCE(SUM(${USDSUM("GREATEST(i.amount_due - i.amount_paid - i.amount_written_off, 0)")}) FILTER (WHERE i.status IN ('open','partially_paid','expired')), 0)::text AS outstanding,
         COALESCE(SUM(${USDSUM("GREATEST(i.amount_paid - i.amount_due, 0)")}), 0)::text AS overpaid,
         COUNT(*) FILTER (WHERE i.status = 'paid')::int AS paid_count,
         COUNT(*) FILTER (WHERE i.status = 'partially_paid')::int AS partial_count,
         COUNT(*) FILTER (WHERE i.status = 'overpaid')::int AS overpaid_count,
         COUNT(*) FILTER (WHERE i.status = 'open')::int AS open_count,
         COUNT(*) FILTER (WHERE i.status = 'expired')::int AS expired_count
       FROM invoices i JOIN assets a ON a.id = i.asset_id
      WHERE i.organization_id = $1 AND i.environment = $2 AND i.issued_at >= $3 AND i.issued_at < $4 AND i.status <> 'cancelled'${invoiceRail}`,
      ip
    )
  ).rows[0] as Row;

  const pp: unknown[] = [organizationId, environment, start, end];
  const paymentRail = railFilter(q, pp, "p.chain_id", "p.asset_id");
  const pay = (
    await c.query(
      `SELECT
         COUNT(*) FILTER (WHERE p.status <> 'reversed')::int AS count,
         COALESCE(SUM(${USDSUM("p.amount")}) FILTER (WHERE p.status IN ('matched','partial','overpaid','needs_review','dismissed','refunded')), 0)::text AS received,
         COALESCE(SUM(${USDSUM("p.amount")}) FILTER (WHERE p.status IN ('matched','partial','overpaid')), 0)::text AS applied,
         COALESCE(SUM(${USDSUM("p.amount")}) FILTER (WHERE p.status = 'needs_review'), 0)::text AS needs_review,
         COALESCE(SUM(${USDSUM("p.amount")}) FILTER (WHERE p.status = 'dismissed'), 0)::text AS set_aside,
         COALESCE(SUM(${USDSUM("p.amount")}) FILTER (WHERE p.status = 'confirming'), 0)::text AS confirming,
         COALESCE(SUM(${USDSUM("p.amount")}) FILTER (WHERE p.status = 'reversed'), 0)::text AS reversed,
         COUNT(*) FILTER (WHERE p.status IN ('matched','partial','overpaid'))::int AS applied_count,
         COUNT(*) FILTER (WHERE p.status = 'needs_review')::int AS needs_review_count,
         COUNT(*) FILTER (WHERE p.source = 'simulated')::int AS simulated_count
       FROM payments p LEFT JOIN assets a ON a.id = p.asset_id
      WHERE p.organization_id = $1 AND p.environment = $2 AND p.block_timestamp >= $3 AND p.block_timestamp < $4 AND p.asset_id IS NOT NULL${paymentRail}`,
      pp
    )
  ).rows[0] as Row;

  const refunded = (
    await c.query(
      `SELECT COALESCE(SUM(${USDSUM("r.amount")}), 0)::text AS total, COUNT(*)::int AS count
         FROM refunds r JOIN outgoing_transfers o ON o.id = r.outgoing_transfer_id JOIN payments p ON p.id = r.payment_id JOIN assets a ON a.id = p.asset_id
        WHERE r.organization_id = $1 AND r.environment = $2 AND o.block_timestamp >= $3 AND o.block_timestamp < $4 AND o.canonical`,
      [organizationId, environment, start, end]
    )
  ).rows[0] as Row;

  const unsupported = (
    await c.query(
      `SELECT COUNT(*)::int AS count FROM payments p WHERE p.organization_id = $1 AND p.environment = $2 AND p.block_timestamp >= $3 AND p.block_timestamp < $4 AND p.asset_id IS NULL`,
      [organizationId, environment, start, end]
    )
  ).rows[0] as Row;

  const exceptions = (
    await c.query(
      `SELECT e.*, c.name AS customer_name, i.number AS invoice_number, i.title AS invoice_title FROM exceptions e JOIN payments p ON p.id = e.payment_id
         LEFT JOIN customers c ON c.id = e.customer_id LEFT JOIN invoices i ON i.id = e.invoice_id
        WHERE e.organization_id = $1 AND e.environment = $2 AND e.status = 'open' AND p.block_timestamp >= $3 AND p.block_timestamp < $4
        ORDER BY e.id DESC LIMIT 100`,
      [organizationId, environment, start, end]
    )
  ).rows;

  const outstanding = (
    await c.query(
      `SELECT i.id, i.number, i.title, i.status, i.due_at, i.issued_at, c.name AS customer_name,
              ${USD("i.amount_due")}::text AS amount_due, ${USD("GREATEST(i.amount_due - i.amount_paid - i.amount_written_off, 0)")}::text AS amount_remaining
         FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN assets a ON a.id = i.asset_id
        WHERE i.organization_id = $1 AND i.environment = $2 AND i.issued_at >= $3 AND i.issued_at < $4 AND i.status IN ('open','partially_paid','expired')${invoiceRail}
        ORDER BY i.due_at NULLS LAST, i.id LIMIT 100`,
      ip
    )
  ).rows;

  const settledInvoices = (
    await c.query(
      `SELECT i.id, i.number, i.title, i.status, i.paid_at, c.name AS customer_name,
              ${USD("i.amount_due")}::text AS amount_due, ${USD("i.amount_paid")}::text AS amount_paid,
              (SELECT count(*) FROM payments p WHERE p.invoice_id = i.id AND p.status <> 'reversed')::int AS payment_count
         FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN assets a ON a.id = i.asset_id
        WHERE i.organization_id = $1 AND i.environment = $2 AND i.issued_at >= $3 AND i.issued_at < $4 AND i.status IN ('paid','overpaid','partially_paid')${invoiceRail}
        ORDER BY i.paid_at DESC NULLS LAST, i.id DESC LIMIT 100`,
      ip
    )
  ).rows;

  const d = decimalString;
  return {
    object: "reconciliation",
    period: { start: start.toISOString(), end: end.toISOString() },
    filters: { network: q.network ?? null, asset: q.asset ?? null },
    currency: "USD",
    summary: {
      expected: d(inv.expected),
      received: d(pay.received),
      applied: d(pay.applied),
      needs_review: d(pay.needs_review),
      set_aside: d(pay.set_aside),
      refunded: d(refunded.total),
      confirming: d(pay.confirming),
      reversed: d(pay.reversed),
      outstanding: d(inv.outstanding),
      collected_on_period_invoices: d(inv.collected),
      written_off: d(inv.written_off),
      overpaid: d(inv.overpaid)
    },
    invoices: {
      count: inv.count,
      paid: inv.paid_count,
      partially_paid: inv.partial_count,
      overpaid: inv.overpaid_count,
      open: inv.open_count,
      expired: inv.expired_count
    },
    payments: { count: pay.count, applied: pay.applied_count, needs_review: pay.needs_review_count, refunds: refunded.count, simulated: pay.simulated_count, unsupported_tokens: unsupported.count },
    exceptions: exceptions.map((e) => serializeException(e, { customer: e.customer_id ? { id: e.customer_id, name: e.customer_name } : null, invoice: e.invoice_id ? { id: e.invoice_id, number: e.invoice_number, title: e.invoice_title } : null })),
    settled_invoices: settledInvoices.map((i) => ({
      id: i.id,
      number: i.number,
      title: i.title ?? null,
      status: i.status,
      customer_name: i.customer_name,
      expected: d(i.amount_due),
      received: d(i.amount_paid),
      payments: i.payment_count,
      paid_at: i.paid_at
    })),
    outstanding_invoices: outstanding.map((i) => ({ id: i.id, number: i.number, title: i.title ?? null, status: i.status, customer_name: i.customer_name, due_at: i.due_at, issued_at: i.issued_at, amount_due: d(i.amount_due), amount_remaining: d(i.amount_remaining) })),
    coverage: await coverage(c, organizationId, environment, end)
  };
}

export function reportingRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/overview",
    summary: "What is happening with my money, dashboard summary",
    tags: ["reporting"],
    permission: "read",
    query: z.object({ period: z.enum(["today", "7d", "30d"]).default("today") }),
    handler: async ({ query, tx, organizationId, environment }) =>
      tx(async (c) => {
        const now = new Date();
        const start =
          query.period === "today" ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) : new Date(now.getTime() - (query.period === "7d" ? 7 : 30) * 86_400_000);
        const metrics = (
          await c.query(
            `SELECT
               COALESCE(SUM(${USDSUM("p.amount")}) FILTER (WHERE p.status IN ('matched','partial','overpaid','needs_review','dismissed','refunded')), 0)::text AS received,
               COUNT(*) FILTER (WHERE p.status IN ('matched','partial','overpaid','needs_review','dismissed','refunded'))::int AS payments,
               COUNT(*) FILTER (WHERE p.status IN ('matched','partial','overpaid'))::int AS matched,
               COUNT(*) FILTER (WHERE p.status = 'confirming')::int AS confirming
             FROM payments p LEFT JOIN assets a ON a.id = p.asset_id
            WHERE p.organization_id = $1 AND p.environment = $2 AND p.block_timestamp >= $3`,
            [organizationId, environment, start]
          )
        ).rows[0] as Row;
        const attention = (
          await c.query(
            `SELECT COUNT(*)::int AS open, COUNT(*) FILTER (WHERE type IN ('unknown_payment','ambiguous_match'))::int AS unknown,
                    COALESCE(SUM(${USDSUM("e.amount")}), 0)::text AS amount
               FROM exceptions e LEFT JOIN assets a ON a.id = e.asset_id WHERE e.organization_id = $1 AND e.environment = $2 AND e.status = 'open'`,
            [organizationId, environment]
          )
        ).rows[0] as Row;
        const outstanding = (
          await c.query(
            `SELECT COUNT(*)::int AS count, COALESCE(SUM(${USDSUM("GREATEST(i.amount_due - i.amount_paid - i.amount_written_off, 0)")}), 0)::text AS amount
               FROM invoices i JOIN assets a ON a.id = i.asset_id WHERE i.organization_id = $1 AND i.environment = $2 AND i.status IN ('open','partially_paid')`,
            [organizationId, environment]
          )
        ).rows[0] as Row;
        const recent = (
          await c.query(
            `SELECT ${PAYMENT_COLUMNS} ${PAYMENT_FROM}
              WHERE p.organization_id = $1 AND p.environment = $2 ORDER BY p.id DESC LIMIT 8`,
            [organizationId, environment]
          )
        ).rows;
        const needs = (
          await c.query(
            `SELECT e.*, c.name AS customer_name, i.number AS invoice_number, i.title AS invoice_title FROM exceptions e LEFT JOIN customers c ON c.id = e.customer_id LEFT JOIN invoices i ON i.id = e.invoice_id
              WHERE e.organization_id = $1 AND e.environment = $2 AND e.status = 'open' ORDER BY e.id DESC LIMIT 6`,
            [organizationId, environment]
          )
        ).rows;
        const counts = (
          await c.query(
            `SELECT (SELECT COUNT(*) FROM wallets WHERE organization_id = $1 AND environment = $2 AND archived_at IS NULL)::int AS wallets,
                    (SELECT COUNT(*) FROM customers WHERE organization_id = $1 AND environment = $2 AND archived_at IS NULL)::int AS customers,
                    (SELECT COUNT(*) FROM invoices WHERE organization_id = $1 AND environment = $2)::int AS invoices,
                    (SELECT COUNT(*) FROM payments WHERE organization_id = $1 AND environment = $2)::int AS payments,
                    (SELECT COUNT(*) FROM webhook_endpoints WHERE organization_id = $1 AND environment = $2 AND archived_at IS NULL)::int AS webhooks`,
            [organizationId, environment]
          )
        ).rows[0];
        const wallets = (await c.query("SELECT * FROM wallets WHERE organization_id = $1 AND environment = $2 AND archived_at IS NULL", [organizationId, environment])).rows;
        const sync = await walletSync(wallets, c);
        return {
          period: { name: query.period, start: start.toISOString() },
          metrics: {
            received: decimalString(metrics.received),
            payments: metrics.payments,
            matched: metrics.matched,
            confirming: metrics.confirming,
            needs_attention: attention.open,
            needs_attention_amount: decimalString(attention.amount),
            unknown: attention.unknown,
            outstanding: decimalString(outstanding.amount),
            outstanding_invoices: outstanding.count
          },
          recent_activity: recent.map(presentPayment),
          needs_attention: needs.map((e) => serializeException(e, { customer: e.customer_id ? { id: e.customer_id, name: e.customer_name } : null, invoice: e.invoice_id ? { id: e.invoice_id, number: e.invoice_number, title: e.invoice_title } : null })),
          monitoring: wallets.map((w) => ({ wallet_id: w.id, name: w.name, address: w.address, network: networks().byChainId(Number(w.chain_id))?.name, ...sync.get(w.id) })),
          setup: counts
        };
      })
  });

  route(app, {
    method: "GET",
    url: "/v1/reconciliation",
    summary: "Expected vs. received vs. applied for a period",
    tags: ["reporting"],
    permission: "read",
    query: reconciliationQuery,
    handler: async ({ query, tx, organizationId, environment }) => tx((c) => reconciliation(c, organizationId, environment, query))
  });

  route(app, {
    method: "GET",
    url: "/v1/exports/payments.csv",
    summary: "Export payments as CSV (same filters as GET /v1/payments)",
    tags: ["reporting"],
    permission: "read",
    query: paymentListQuery.omit({ limit: true, starting_after: true, ending_before: true, sort: true }),
    handler: async ({ query, tx, organizationId, environment, reply }) => {
      const rows = await tx(async (c) => {
        const { where, params } = paymentFilter(query, organizationId, environment);
        return (
          await c.query(
            `SELECT ${PAYMENT_COLUMNS}, w.address AS wallet_address, md.rule_version
               ${PAYMENT_FROM}
               LEFT JOIN match_decisions md ON md.id = p.latest_decision_id
              WHERE ${where} ORDER BY p.block_timestamp, p.id LIMIT 50000`,
            params
          )
        ).rows;
      });
      const csv = toCsv(
        [
          "payment_id", "date", "status", "customer", "invoice", "invoice_title", "purpose", "purpose_status", "context_source",
          "amount", "asset", "network", "chain_id", "sender", "recipient_wallet", "wallet_name", "transaction_hash", "block_number", "matched_at", "rule_version", "source"
        ],
        rows.map((r) => {
          const p = presentPayment(r);
          const b = p.business_object;
          return [
            p.id, p.paid_at, p.status, r.customer_name, b?.number ?? null, b?.title ?? null, b?.purpose ?? null, p.purpose_status, p.context_source,
            p.amount, p.asset.symbol, p.network_name, p.chain_id, p.sender, r.wallet_address, r.wallet_name, p.transaction_hash, p.block_number, p.finalized_at, r.rule_version, p.source
          ];
        })
      );
      reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="setra-payments-${environment}-${new Date().toISOString().slice(0, 10)}.csv"`);
      return csv;
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/exports/reconciliation.csv",
    summary: "Export a period's reconciliation (every invoice and every unapplied payment) as CSV",
    tags: ["reporting"],
    permission: "read",
    query: reconciliationQuery,
    handler: async ({ query, tx, organizationId, environment, reply }) => {
      const { start, end } = periodBounds(query);
      const { invoices, unapplied } = await tx(async (c) => {
        const ip: unknown[] = [organizationId, environment, start, end];
        const rail = railFilter(query, ip, "i.chain_id", "i.asset_id");
        const invoices = (
          await c.query(
            `SELECT i.number, i.title, i.purpose, c.name AS customer_name, i.issued_at, i.due_at, i.status, i.currency, a.symbol, i.chain_id,
                    ${USD("i.amount_due")}::text AS amount_due, ${USD("i.amount_paid")}::text AS amount_paid, ${USD("i.amount_written_off")}::text AS written_off,
                    ${USD("GREATEST(i.amount_due - i.amount_paid - i.amount_written_off, 0)")}::text AS remaining,
                    (SELECT string_agg(p.transaction_hash, ';' ORDER BY p.block_timestamp) FROM payments p WHERE p.invoice_id = i.id AND p.status <> 'reversed') AS tx_hashes,
                    (SELECT string_agg(p.id, ';' ORDER BY p.block_timestamp) FROM payments p WHERE p.invoice_id = i.id AND p.status <> 'reversed') AS payment_ids,
                    (SELECT max(p.block_timestamp) FROM payments p WHERE p.invoice_id = i.id AND p.status <> 'reversed') AS last_payment_at
               FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN assets a ON a.id = i.asset_id
              WHERE i.organization_id = $1 AND i.environment = $2 AND i.issued_at >= $3 AND i.issued_at < $4 AND i.status <> 'cancelled'${rail}
              ORDER BY i.issued_at, i.number`,
            ip
          )
        ).rows;
        const pp: unknown[] = [organizationId, environment, start, end];
        const prail = railFilter(query, pp, "p.chain_id", "p.asset_id");
        const unapplied = (
          await c.query(
            `SELECT p.id, p.block_timestamp, p.status, p.transaction_hash, p.chain_id, p.from_address, a.symbol, ${USD("p.amount")}::text AS amount, c.name AS customer_name,
                    COALESCE(
                      (SELECT 'Refunded in ' || string_agg(o.transaction_hash, ';') FROM refunds r JOIN outgoing_transfers o ON o.id = r.outgoing_transfer_id WHERE r.payment_id = p.id),
                      (SELECT e.summary FROM exceptions e WHERE e.payment_id = p.id ORDER BY e.id DESC LIMIT 1)
                    ) AS note
               FROM payments p LEFT JOIN assets a ON a.id = p.asset_id LEFT JOIN customers c ON c.id = p.customer_id
              WHERE p.organization_id = $1 AND p.environment = $2 AND p.block_timestamp >= $3 AND p.block_timestamp < $4 AND p.status IN ('needs_review','dismissed','refunded') AND p.asset_id IS NOT NULL${prail}
              ORDER BY p.block_timestamp`,
            pp
          )
        ).rows;
        return { invoices, unapplied };
      });
      const net = (id: number) => networks().byChainId(Number(id))?.name ?? String(id);
      const csv = toCsv(
        ["record_type", "invoice_number", "invoice_title", "purpose", "customer", "date", "due_date", "status", "currency", "amount_due", "amount_received", "amount_written_off", "amount_remaining", "asset", "network", "transaction_hashes", "payment_ids", "sender", "notes"],
        [
          ...invoices.map((i) => ["invoice", i.number, i.title, i.purpose, i.customer_name, iso(i.issued_at), iso(i.due_at), i.status, i.currency, decimalString(i.amount_due), decimalString(i.amount_paid), decimalString(i.written_off), decimalString(i.remaining), i.symbol, net(i.chain_id), i.tx_hashes, i.payment_ids, null, i.last_payment_at ? `Last payment ${iso(i.last_payment_at)}` : null]),
          ...unapplied.map((p) => ["unapplied_payment", null, null, "Unknown", p.customer_name, iso(p.block_timestamp), null, p.status, "USD", null, decimalString(p.amount), null, null, p.symbol, net(p.chain_id), p.transaction_hash, p.id, p.from_address, p.note])
        ]
      );
      reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="setra-reconciliation-${start.toISOString().slice(0, 10)}.csv"`);
      return csv;
    }
  });
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
