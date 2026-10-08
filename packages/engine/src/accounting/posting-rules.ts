import { networks } from "@setra/config";
import type { Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { log, SYSTEM, type Actor } from "../context";
import { booksSettings, seedChart, systemAccount, valueInReporting, walletAccount, type BooksSettings } from "./chart";
import { postEntry, reverseEntry, type LineInput } from "./ledger";
import { postNetworkFee } from "./network-fees";

type Row = Record<string, any>;

/**
 * Automatic accounting: every business fact Setra records produces its journal entries in the same
 * database transaction, by fixed rules. Nothing here is inferred or estimated.
 *
 *  Payment received (final)      Dr Wallet asset              Cr Payments to Identify
 *    …from one of your wallets   Dr Wallet asset              Cr Transfers to Classify   (internal transfer)
 *  Payment applied to invoice    Dr Payments to Identify      Cr Accounts Receivable     (accrual)
 *                                                             Cr Revenue                 (cash basis)
 *                                                             Cr Customer Credits        (any overpaid excess)
 *  Payment taken off invoice     reversal of its application entry
 *  Payment reversed by reorg     reversal of every entry for the payment
 *  Refund                        Dr Payments to Identify / Customer Credits / Refunds   Cr Transfers to Classify
 *  Stablecoin sent from wallet   Dr Transfers to Classify     Cr Wallet asset
 *  Invoice issued (accrual)      Dr Accounts Receivable       Cr Revenue
 *  Invoice cancelled (accrual)   reversal of the issue entry
 *  Balance written off (accrual) Dr Bad Debts                 Cr Accounts Receivable
 *
 * Money received is never revenue until it's applied to an invoice; money sent is never an expense
 * until it's classified. A duplicate payment stays in Payments to Identify, so it can't double revenue.
 */

const lockKey = (organizationId: string, environment: string) => `books:${organizationId}:${environment}`;

/**
 * Make sure an organization's books exist for a mode: settings, chart of accounts and, the first
 * time, a backfill that posts entries for every invoice, payment and transfer recorded before
 * accounting existed. Safe to call repeatedly.
 */

export async function ensureBooks(client: Client, organizationId: string, environment: Environment): Promise<BooksSettings> {
  const settings = await booksSettings(client, organizationId, environment);
  if (settings.initialized) return settings;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey(organizationId, environment)]);
  const again = await booksSettings(client, organizationId, environment);
  if (again.initialized) return again;
  await seedChart(client, organizationId, environment);
  await backfill(client, organizationId, environment, again);
  await client.query("UPDATE accounting_settings SET books_initialized_at = now(), updated_at = now() WHERE organization_id = $1 AND environment = $2", [organizationId, environment]);
  log().info("books_initialized", { organizationId, environment });
  return { ...again, initialized: true };
}

/** Post (idempotently) everything that should already be in the books. Also used to repair them. */
export async function backfill(client: Client, organizationId: string, environment: Environment, settings?: BooksSettings): Promise<{ posted: number }> {
  const s = settings ?? (await booksSettings(client, organizationId, environment));
  let posted = 0;
  const count = (r: { created: boolean } | null | undefined) => {
    if (r?.created) posted += 1;
  };
  const invoices = (await client.query("SELECT * FROM invoices WHERE organization_id = $1 AND environment = $2 ORDER BY id", [organizationId, environment])).rows as Row[];
  for (const inv of invoices) {
    count(await postInvoiceIssued(client, s, inv));
    if (inv.status === "cancelled") count(await postInvoiceCancelled(client, s, inv));
  }
  const writeOffs = (
    await client.query(
      `SELECT r.*, i.amount_written_off FROM resolutions r JOIN invoices i ON i.id = r.invoice_id
        WHERE r.organization_id = $1 AND r.environment = $2 AND r.action = 'write_off' ORDER BY r.id`,
      [organizationId, environment]
    )
  ).rows as Row[];
  for (const r of writeOffs) {
    const prevWo = BigInt(r.previous_state?.invoice?.amount_written_off ?? 0);
    const newWo = BigInt(r.new_state?.invoice?.amount_written_off ?? r.amount_written_off ?? 0);
    if (newWo > prevWo) count(await postWriteOff(client, s, r.invoice_id, r.id, newWo - prevWo, new Date(r.created_at), SYSTEM));
  }
  const events = (await client.query("SELECT * FROM financial_events WHERE organization_id = $1 AND environment = $2 AND payment_id IS NOT NULL ORDER BY id", [organizationId, environment])).rows as Row[];
  for (const e of events) posted += await postForEventRow(client, s, e);
  const transfers = (await client.query("SELECT * FROM outgoing_transfers WHERE organization_id = $1 AND environment = $2 ORDER BY id", [organizationId, environment])).rows as Row[];
  for (const t of transfers) count(await postOutgoingTransfer(client, s, t));
  const fees = (await client.query("SELECT * FROM network_fees WHERE organization_id = $1 AND environment = $2 AND paid_by_wallet AND fee_native > 0 ORDER BY id", [organizationId, environment])).rows as Row[];
  for (const f of fees) {
    // A fee without a rate yet stays pending (reported as an accounting issue); it never blocks the rest.
    await client.query("SAVEPOINT setra_fee");
    try {
      count(await postNetworkFee(client, s, f));
      await client.query("RELEASE SAVEPOINT setra_fee");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT setra_fee");
      await client.query("RELEASE SAVEPOINT setra_fee");
    }
  }
  return { posted };
}

// ── Safety wrapper ─────────────────────────────────────────────────────────────────────────────

/**
 * Run an automatic posting without ever blocking the business fact that triggered it. If the posting
 * fails, it's rolled back to a savepoint, recorded as an accounting issue (shown in reconciliation
 * and retried by "repair books"), and the payment/invoice still goes through.
 */

export async function accountSafely(client: Client, ctx: { organizationId: string; environment: Environment; sourceKey: string; sourceType: string; sourceId?: string | null }, fn: (settings: BooksSettings) => Promise<unknown>): Promise<boolean> {
  await client.query("SAVEPOINT setra_accounting");
  try {
    const settings = await ensureBooks(client, ctx.organizationId, ctx.environment);
    await fn(settings);
    await client.query("RELEASE SAVEPOINT setra_accounting");
    await client.query("UPDATE accounting_issues SET resolved_at = now(), updated_at = now() WHERE organization_id = $1 AND environment = $2 AND source_key = $3 AND resolved_at IS NULL", [
      ctx.organizationId,
      ctx.environment,
      ctx.sourceKey
    ]);
    return true;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT setra_accounting");
    await client.query("RELEASE SAVEPOINT setra_accounting");
    const message = error instanceof Error ? error.message : String(error);
    await client.query(
      `INSERT INTO accounting_issues (id, organization_id, environment, source_key, source_type, source_id, message) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (organization_id, environment, source_key) DO UPDATE SET message = EXCLUDED.message, resolved_at = NULL, updated_at = now()`,
      [newId("accountingIssue"), ctx.organizationId, ctx.environment, ctx.sourceKey, ctx.sourceType, ctx.sourceId ?? null, message.slice(0, 1000)]
    );
    log().warn("accounting_posting_failed", { organizationId: ctx.organizationId, sourceKey: ctx.sourceKey, error: message });
    return false;
  }
}

// ── Financial events ───────────────────────────────────────────────────────────────────────────

/** Post the accounting for one financial event (called when the event is created). */
export async function accountForFinancialEvent(client: Client, eventId: string): Promise<void> {
  const e = (await client.query("SELECT * FROM financial_events WHERE id = $1", [eventId])).rows[0] as Row | undefined;
  if (!e || !e.payment_id) return;
  await accountSafely(client, { organizationId: e.organization_id, environment: e.environment, sourceKey: `event:${e.id}`, sourceType: "financial_event", sourceId: e.id }, (s) => postForEventRow(client, s, e));
}

async function postForEventRow(client: Client, s: BooksSettings, e: Row): Promise<number> {
  let posted = 0;
  const count = (r: { created: boolean } | null | undefined) => {
    if (r?.created) posted += 1;
  };
  switch (e.type) {
    case "PAYMENT_MATCHED":
    case "PARTIALLY_PAID":
    case "OVERPAID":
      count(await postReceipt(client, s, e.payment_id, e.id));
      count(await postApplication(client, s, e));
      break;
    case "UNKNOWN_PAYMENT":
    case "PAYMENT_DISMISSED":
      count(await postReceipt(client, s, e.payment_id, e.id));
      break;
    case "PAYMENT_UNASSIGNED":
      posted += await postUnapplication(client, e);
      break;
    case "PAYMENT_REVERSED":
      posted += await reversePaymentEntries(client, e);
      break;
    case "REFUND_OBSERVED":
      count(await postReceipt(client, s, e.payment_id, e.id));
      count(await postRefund(client, s, e));
      break;
    default:
      break;
  }
  return posted;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const assetSymbol = (assetId: string | null) => (assetId ? networks().asset(assetId)?.asset.symbol ?? "tokens" : "tokens");

function fmt(amount: bigint, assetId: string | null): string {
  const d = (assetId && networks().asset(assetId)?.asset.decimals) || 6;
  const base = 10n ** BigInt(d);
  const frac = (amount % base).toString().padStart(d, "0").slice(0, 2);
  return `${(amount / base).toLocaleString("en-US")}.${frac}`;
}

/** Money arriving in a monitored wallet, once final. Credits Payments to Identify (or Transfers to Classify for an internal transfer). */
async function postReceipt(client: Client, s: BooksSettings, paymentId: string, eventId: string | null): Promise<{ created: boolean } | null> {
  const p = (await client.query("SELECT * FROM payments WHERE id = $1", [paymentId])).rows[0] as Row | undefined;
  if (!p || !p.asset_id) return null; // unsupported tokens have no accounting value; reconciliation lists them
  const key = `pay-receipt:${p.id}`;
  const existing = (await client.query("SELECT id FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND source_key = $3", [p.organization_id, p.environment, key])).rows[0];
  if (existing) return { created: false };
  const { amount, rateSource } = valueInReporting(p.asset_id, BigInt(p.amount), s.reportingCurrency);
  const wallet = await walletAccount(client, p.organization_id, p.environment, p.wallet_id, p.asset_id);
  const ownSender = (
    await client.query("SELECT name FROM wallets WHERE organization_id = $1 AND environment = $2 AND chain_id = $3 AND address = $4 AND id <> $5 LIMIT 1", [p.organization_id, p.environment, p.chain_id, p.from_address, p.wallet_id])
  ).rows[0] as Row | undefined;
  const counter = await systemAccount(client, p.organization_id, p.environment, ownSender ? "transfers_to_classify" : "payments_to_identify");
  const customer = p.customer_id ? ((await client.query("SELECT name FROM customers WHERE id = $1", [p.customer_id])).rows[0] as Row | undefined) : undefined;
  const walletName = (await client.query("SELECT name FROM wallets WHERE id = $1", [p.wallet_id])).rows[0]?.name ?? "wallet";
  const what = `${fmt(BigInt(p.amount), p.asset_id)} ${assetSymbol(p.asset_id)}`;
  const description = ownSender
    ? `Internal transfer: ${what} received from ${ownSender.name}`
    : `Payment received: ${what} ${customer ? `from ${customer.name}` : `from ${short(p.from_address)}`} into ${walletName}`;
  const common: Partial<LineInput> = { paymentId: p.id, observationId: p.observation_id, financialEventId: eventId, customerId: p.customer_id ?? null, assetId: p.asset_id, assetAmount: BigInt(p.amount), rateSource };
  return postEntry(client, {
    organizationId: p.organization_id,
    environment: p.environment,
    date: new Date(p.block_timestamp),
    description,
    memo: `Transaction ${p.transaction_hash}${p.source === "simulated" ? " (simulated in test mode)" : ""}`,
    sourceType: "payment",
    sourceId: p.id,
    sourceKey: key,
    actor: SYSTEM,
    lines: [
      { ...common, accountId: wallet.id, debit: amount, memo: "Stablecoin received" },
      { ...common, accountId: counter.id, credit: amount, memo: ownSender ? "From another of your wallets" : "Not yet tied to an invoice" }
    ]
  });
}

/** The account the payment's receipt credited (normally Payments to Identify). */
async function unappliedAccountFor(client: Client, p: Row): Promise<string> {
  const row = (
    await client.query(
      `SELECT l.account_id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
        WHERE e.organization_id = $1 AND e.environment = $2 AND e.source_key = $3 AND l.credit > 0 LIMIT 1`,
      [p.organization_id, p.environment, `pay-receipt:${p.id}`]
    )
  ).rows[0] as Row | undefined;
  if (row) return row.account_id;
  return (await systemAccount(client, p.organization_id, p.environment, "payments_to_identify")).id;
}

/** Allocation created by a settlement event. */
async function allocationForEvent(client: Client, e: Row): Promise<Row | undefined> {
  const correctionId = e.data?.correction_id ?? null;
  const q = correctionId
    ? ["SELECT * FROM allocations WHERE payment_id = $1 AND kind <> 'reversal' AND correction_id = $2 ORDER BY id DESC LIMIT 1", [e.payment_id, correctionId]]
    : e.resolution_id
      ? ["SELECT * FROM allocations WHERE payment_id = $1 AND kind <> 'reversal' AND resolution_id = $2 ORDER BY id DESC LIMIT 1", [e.payment_id, e.resolution_id]]
      : e.match_decision_id
        ? ["SELECT * FROM allocations WHERE payment_id = $1 AND kind <> 'reversal' AND match_decision_id = $2 ORDER BY id DESC LIMIT 1", [e.payment_id, e.match_decision_id]]
        : ["SELECT * FROM allocations WHERE payment_id = $1 AND kind <> 'reversal' ORDER BY id DESC LIMIT 1", [e.payment_id]];
  return (await client.query(q[0] as string, q[1] as unknown[])).rows[0] as Row | undefined;
}

/**
 * A payment applied to an invoice. The receivable portion is what the invoice still owed before this
 * allocation (from the allocation ledger, in order); anything beyond it is a customer credit.
 */

async function postApplication(client: Client, s: BooksSettings, e: Row): Promise<{ created: boolean } | null> {
  const p = (await client.query("SELECT * FROM payments WHERE id = $1", [e.payment_id])).rows[0] as Row;
  if (!p.asset_id) return null;
  const alloc = await allocationForEvent(client, e);
  if (!alloc) return null;
  const key = `pay-apply:${alloc.id}`;
  const existing = (await client.query("SELECT id FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND source_key = $3", [p.organization_id, p.environment, key])).rows[0];
  if (existing) return { created: false };
  const inv = (await client.query("SELECT * FROM invoices WHERE id = $1", [alloc.invoice_id])).rows[0] as Row;
  const customer = (await client.query("SELECT id, name FROM customers WHERE id = $1", [inv.customer_id])).rows[0] as Row;
  const capacity = BigInt(inv.amount_due) - BigInt(inv.amount_written_off);
  const before = BigInt((await client.query<{ s: string }>("SELECT COALESCE(sum(amount), 0)::text AS s FROM allocations WHERE invoice_id = $1 AND id < $2", [inv.id, alloc.id])).rows[0]!.s);
  const allocAmount = BigInt(alloc.amount);
  let owed = capacity - before;
  if (owed < 0n) owed = 0n;
  const toReceivable = allocAmount < owed ? allocAmount : owed;
  const excess = allocAmount - toReceivable;
  const value = (v: bigint) => valueInReporting(p.asset_id, v, s.reportingCurrency);
  const total = value(allocAmount);
  const recv = value(toReceivable);
  const credit = total.amount - recv.amount; // keeps the entry exactly balanced after rounding

  const unapplied = await unappliedAccountFor(client, p);
  const settleAccount =
    s.method === "accrual"
      ? (await systemAccount(client, p.organization_id, p.environment, "accounts_receivable")).id
      : inv.revenue_account_id ?? (await systemAccount(client, p.organization_id, p.environment, "sales")).id;
  const credits = excess > 0n ? (await systemAccount(client, p.organization_id, p.environment, "customer_credits")).id : null;
  const refs: Partial<LineInput> = { paymentId: p.id, invoiceId: inv.id, customerId: customer.id, financialEventId: e.id, observationId: p.observation_id, assetId: p.asset_id, rateSource: total.rateSource };
  // Cash books recognise sales tax as it's received: each application carries its share of the
  // invoice's tax, worked out cumulatively so partial payments add up to the exact tax.
  const taxShare = s.method === "cash" ? taxPortion(inv, before, toReceivable) : 0n;
  const taxValue = taxShare > 0n ? value(taxShare).amount : 0n;
  const lines: LineInput[] = [
    { ...refs, accountId: unapplied, debit: total.amount, assetAmount: allocAmount, memo: "Payment applied" },
    { ...refs, accountId: settleAccount, credit: recv.amount - taxValue, assetAmount: toReceivable - taxShare, memo: s.method === "accrual" ? `Settles ${inv.number}` : `Revenue: ${inv.title ?? inv.number}` }
  ];
  if (taxValue > 0n) {
    const taxes = await systemAccount(client, p.organization_id, p.environment, "taxes_payable");
    lines.push({ ...refs, accountId: taxes.id, credit: taxValue, assetAmount: taxShare, memo: `Tax collected on ${inv.number}` });
  }
  if (credits && credit > 0n) lines.push({ ...refs, accountId: credits, credit, assetAmount: excess, memo: `Paid beyond ${inv.number}` });
  return postEntry(client, {
    organizationId: p.organization_id,
    environment: p.environment,
    date: new Date(e.occurred_at ?? p.block_timestamp),
    description: `${customer.name} paid ${inv.number}${inv.title ? `: ${inv.title}` : ""}${alloc.kind === "manual" ? " (assigned by an operator)" : ""}`,
    memo: excess > 0n ? `Overpaid by ${fmt(excess, p.asset_id)} ${assetSymbol(p.asset_id)}` : null,
    sourceType: "payment",
    sourceId: p.id,
    sourceKey: key,
    actor: SYSTEM,
    lines
  });
}

/** A payment taken off its invoice: reverse the application entry of each compensated allocation. */
async function postUnapplication(client: Client, e: Row): Promise<number> {
  const correctionId = e.data?.correction?.id ?? null;
  if (!correctionId) return 0;
  const reversed = (await client.query("SELECT reverses_allocation_id FROM allocations WHERE correction_id = $1 AND kind = 'reversal'", [correctionId])).rows as Row[];
  let n = 0;
  for (const r of reversed) {
    const apply = (await client.query("SELECT id FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND source_key = $3", [e.organization_id, e.environment, `pay-apply:${r.reverses_allocation_id}`])).rows[0] as Row | undefined;
    if (!apply) continue;
    const res = await reverseEntry(client, e.organization_id, e.environment, apply.id, {
      reason: `Payment taken off its invoice by an operator: ${e.data?.correction?.reason ?? ""}`.trim(),
      actor: SYSTEM,
      date: new Date(e.occurred_at),
      sourceKey: `pay-unapply:${r.reverses_allocation_id}`,
      automatic: true
    });
    if (res.created) n += 1;
  }
  return n;
}

/** The blockchain reversed a settled payment: reverse every entry for it. Nothing is deleted. */
async function reversePaymentEntries(client: Client, e: Row): Promise<number> {
  const entries = (
    await client.query(
      `SELECT e.id FROM journal_entries e
        WHERE e.organization_id = $1 AND e.environment = $2 AND e.source_type = 'payment' AND e.source_id = $3 AND e.status = 'posted' AND e.reverses_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id AND r.status <> 'void')
        ORDER BY e.id DESC`,
      [e.organization_id, e.environment, e.payment_id]
    )
  ).rows as Row[];
  let n = 0;
  for (const entry of entries) {
    const res = await reverseEntry(client, e.organization_id, e.environment, entry.id, {
      reason: `The blockchain reversed this payment: ${e.data?.reversal?.reason ?? "no longer canonical"}`,
      actor: SYSTEM,
      date: new Date(e.occurred_at),
      sourceKey: `pay-reverse:${entry.id}`,
      automatic: true
    });
    if (res.created) n += 1;
  }
  return n;
}

/**
 * Money sent back to a payer. What it reduces follows the refund's basis: an unapplied payment
 * (Payments to Identify), an overpaid excess (Customer Credits), or a refund through the payment-intent
 * contract of an applied payment (Refunds & Returns). The outgoing transfer itself already credited the
 * wallet into Transfers to Classify, so the refund clears it.
 */

async function postRefund(client: Client, s: BooksSettings, e: Row): Promise<{ created: boolean } | null> {
  const p = (await client.query("SELECT * FROM payments WHERE id = $1", [e.payment_id])).rows[0] as Row;
  if (!p.asset_id) return null;
  const refund = e.data?.refund ?? {};
  const amountBase = BigInt(refund.amount_base_units ?? 0);
  if (amountBase <= 0n) return null;
  const { amount, rateSource } = valueInReporting(p.asset_id, amountBase, s.reportingCurrency);
  let debitAccount: string;
  if (refund.covers === "overpaid_amount") debitAccount = (await systemAccount(client, p.organization_id, p.environment, "customer_credits")).id;
  else if (refund.covers === "payment") debitAccount = await unappliedAccountFor(client, p);
  else {
    // Intent refunds: an applied payment reduces revenue; an unapplied one reduces Payments to Identify.
    const applied = e.data?.payment?.status && ["matched", "partial", "overpaid"].includes(e.data.payment.status);
    debitAccount = applied ? (await systemAccount(client, p.organization_id, p.environment, "refunds")).id : await unappliedAccountFor(client, p);
  }
  const clearing = await systemAccount(client, p.organization_id, p.environment, "transfers_to_classify");
  const out = refund.id ? ((await client.query("SELECT outgoing_transfer_id FROM refunds WHERE id = $1", [refund.id])).rows[0] as Row | undefined) : undefined;
  const refs: Partial<LineInput> = { paymentId: p.id, customerId: p.customer_id ?? null, invoiceId: p.invoice_id ?? null, financialEventId: e.id, outgoingTransferId: out?.outgoing_transfer_id ?? null, assetId: p.asset_id, assetAmount: amountBase, rateSource };
  return postEntry(client, {
    organizationId: p.organization_id,
    environment: p.environment,
    date: new Date(e.occurred_at),
    description: `Refund: ${fmt(amountBase, p.asset_id)} ${assetSymbol(p.asset_id)} returned to ${short(refund.to ?? refund.recipient ?? p.from_address)}`,
    memo: refund.reason ?? null,
    sourceType: "payment",
    sourceId: p.id,
    sourceKey: `refund:${e.id}`,
    actor: SYSTEM,
    lines: [
      { ...refs, accountId: debitAccount, debit: amount, memo: "Refunded" },
      { ...refs, accountId: clearing.id, credit: amount, memo: refund.transaction_hash ? `Refund transaction ${refund.transaction_hash}` : "Refund transfer" }
    ]
  });
}

// ── Outgoing transfers ─────────────────────────────────────────────────────────────────────────

/** Stablecoin sent from a monitored wallet: out of the wallet account, into Transfers to Classify. */
export async function postOutgoingTransfer(client: Client, s: BooksSettings, t: Row): Promise<{ created: boolean } | null> {
  if (!t.asset_id || !t.canonical) return null;
  const { amount, rateSource } = valueInReporting(t.asset_id, BigInt(t.amount), s.reportingCurrency);
  const wallet = await walletAccount(client, t.organization_id, t.environment, t.wallet_id, t.asset_id);
  const clearing = await systemAccount(client, t.organization_id, t.environment, "transfers_to_classify");
  const own = (await client.query("SELECT name FROM wallets WHERE organization_id = $1 AND environment = $2 AND chain_id = $3 AND address = $4 LIMIT 1", [t.organization_id, t.environment, t.chain_id, t.to_address])).rows[0] as Row | undefined;
  const vendor = (
    await client.query("SELECT v.id, v.name FROM vendor_addresses a JOIN vendors v ON v.id = a.vendor_id WHERE a.organization_id = $1 AND a.chain_id = $2 AND a.address = $3 LIMIT 1", [t.organization_id, t.chain_id, t.to_address])
  ).rows[0] as Row | undefined;
  const walletName = (await client.query("SELECT name FROM wallets WHERE id = $1", [t.wallet_id])).rows[0]?.name ?? "wallet";
  const what = `${fmt(BigInt(t.amount), t.asset_id)} ${assetSymbol(t.asset_id)}`;
  const refs: Partial<LineInput> = { outgoingTransferId: t.id, vendorId: vendor?.id ?? null, assetId: t.asset_id, assetAmount: BigInt(t.amount), rateSource };
  return postEntry(client, {
    organizationId: t.organization_id,
    environment: t.environment,
    date: new Date(t.block_timestamp),
    description: own ? `Internal transfer: ${what} sent from ${walletName} to ${own.name}` : `Sent ${what} from ${walletName} to ${vendor ? vendor.name : short(t.to_address)}`,
    memo: `Transaction ${t.transaction_hash}`,
    sourceType: "outgoing_transfer",
    sourceId: t.id,
    sourceKey: `out:${t.id}`,
    actor: SYSTEM,
    lines: [
      { ...refs, accountId: clearing.id, debit: amount, memo: own ? "To another of your wallets" : "Awaiting classification" },
      { ...refs, accountId: wallet.id, credit: amount, memo: "Stablecoin sent" }
    ]
  });
}

export async function accountForOutgoingTransfer(client: Client, transferId: string): Promise<void> {
  const t = (await client.query("SELECT * FROM outgoing_transfers WHERE id = $1", [transferId])).rows[0] as Row | undefined;
  if (!t) return;
  await accountSafely(client, { organizationId: t.organization_id, environment: t.environment, sourceKey: `out:${t.id}`, sourceType: "outgoing_transfer", sourceId: t.id }, (s) => postOutgoingTransfer(client, s, t));
}

// ── Invoices ───────────────────────────────────────────────────────────────────────────────────

async function postInvoiceIssued(client: Client, s: BooksSettings, inv: Row): Promise<{ created: boolean } | null> {
  if (s.method !== "accrual") return null;
  const { amount, rateSource } = valueInReporting(inv.asset_id, BigInt(inv.amount_due), s.reportingCurrency);
  const ar = await systemAccount(client, inv.organization_id, inv.environment, "accounts_receivable");
  const revenue = inv.revenue_account_id ?? (await systemAccount(client, inv.organization_id, inv.environment, "sales")).id;
  const customer = (await client.query("SELECT name FROM customers WHERE id = $1", [inv.customer_id])).rows[0] as Row;
  const refs: Partial<LineInput> = { invoiceId: inv.id, customerId: inv.customer_id, assetId: inv.asset_id, assetAmount: BigInt(inv.amount_due), rateSource };
  const taxUnits = BigInt(inv.tax_amount ?? 0);
  const tax = taxUnits > 0n ? valueInReporting(inv.asset_id, taxUnits, s.reportingCurrency).amount : 0n;
  const taxLine: LineInput[] = tax > 0n ? [{ ...refs, accountId: (await systemAccount(client, inv.organization_id, inv.environment, "taxes_payable")).id, credit: tax, assetAmount: taxUnits, memo: `Tax on ${inv.number}` }] : [];
  return postEntry(client, {
    organizationId: inv.organization_id,
    environment: inv.environment,
    date: new Date(inv.issued_at ?? inv.created_at),
    description: `Invoice ${inv.number} issued to ${customer.name}${inv.title ? `: ${inv.title}` : ""}`,
    memo: inv.purpose ?? null,
    sourceType: "invoice",
    sourceId: inv.id,
    sourceKey: `inv-issue:${inv.id}`,
    actor: SYSTEM,
    lines: [
      { ...refs, accountId: ar.id, debit: amount, memo: `${customer.name} owes ${inv.number}` },
      { ...refs, accountId: revenue, credit: amount - tax, assetAmount: BigInt(inv.amount_due) - taxUnits, memo: inv.title ?? "Revenue" },
      ...taxLine
    ]
  });
}

/**
 * The share of an invoice's tax in one application, in asset units. Cumulative rounding: the tax on
 * everything applied so far, minus the tax on what was applied before, so the parts always sum to the
 * invoice's tax once it's fully paid.
 */
export function taxPortion(inv: Row, appliedBefore: bigint, applying: bigint): bigint {
  const tax = BigInt(inv.tax_amount ?? 0);
  const gross = BigInt(inv.amount_due);
  if (tax <= 0n || gross <= 0n || applying <= 0n) return 0n;
  const cap = (v: bigint) => (v > gross ? gross : v < 0n ? 0n : v);
  return (cap(appliedBefore + applying) * tax) / gross - (cap(appliedBefore) * tax) / gross;
}

async function postInvoiceCancelled(client: Client, s: BooksSettings, inv: Row): Promise<{ created: boolean } | null> {
  if (s.method !== "accrual") return null;
  const issue = (await client.query("SELECT id FROM journal_entries WHERE organization_id = $1 AND environment = $2 AND source_key = $3", [inv.organization_id, inv.environment, `inv-issue:${inv.id}`])).rows[0] as Row | undefined;
  if (!issue) return null;
  // Credit notes on the invoice go with it, so the receivable nets to zero.
  const notes = (await client.query("SELECT e.id, e.source_id FROM journal_entries e WHERE e.organization_id = $1 AND e.environment = $2 AND e.source_type = 'credit_note' AND e.status = 'posted' AND e.id IN (SELECT l.entry_id FROM journal_lines l WHERE l.invoice_id = $3)", [inv.organization_id, inv.environment, inv.id])).rows as Row[];
  for (const n of notes) await reverseEntry(client, inv.organization_id, inv.environment, n.id, { reason: `Invoice ${inv.number} cancelled`, actor: SYSTEM, date: new Date(inv.cancelled_at ?? Date.now()), sourceKey: `credit-note-cancel:${n.source_id}`, automatic: true });
  return reverseEntry(client, inv.organization_id, inv.environment, issue.id, {
    reason: `Invoice ${inv.number} cancelled${inv.cancel_reason ? `: ${inv.cancel_reason}` : ""}`,
    actor: SYSTEM,
    date: new Date(inv.cancelled_at ?? Date.now()),
    sourceKey: `inv-cancel:${inv.id}`,
    automatic: true
  });
}

async function postWriteOff(client: Client, s: BooksSettings, invoiceId: string, resolutionId: string, amountBase: bigint, at: Date, actor: Actor): Promise<{ created: boolean } | null> {
  if (s.method !== "accrual" || amountBase <= 0n) return null;
  const inv = (await client.query("SELECT * FROM invoices WHERE id = $1", [invoiceId])).rows[0] as Row;
  const { amount, rateSource } = valueInReporting(inv.asset_id, amountBase, s.reportingCurrency);
  const ar = await systemAccount(client, inv.organization_id, inv.environment, "accounts_receivable");
  const bad = await systemAccount(client, inv.organization_id, inv.environment, "bad_debt");
  const refs: Partial<LineInput> = { invoiceId: inv.id, customerId: inv.customer_id, assetId: inv.asset_id, assetAmount: amountBase, rateSource };
  return postEntry(client, {
    organizationId: inv.organization_id,
    environment: inv.environment,
    date: at,
    description: `Remaining balance of ${inv.number} written off`,
    sourceType: "resolution",
    sourceId: resolutionId,
    sourceKey: `writeoff:${resolutionId}`,
    actor,
    lines: [
      { ...refs, accountId: bad.id, debit: amount, memo: "Uncollectable" },
      { ...refs, accountId: ar.id, credit: amount, memo: `Clears the rest of ${inv.number}` }
    ]
  });
}

export async function accountInvoiceIssued(client: Client, invoiceId: string): Promise<void> {
  const inv = (await client.query("SELECT * FROM invoices WHERE id = $1", [invoiceId])).rows[0] as Row | undefined;
  if (!inv) return;
  await accountSafely(client, { organizationId: inv.organization_id, environment: inv.environment, sourceKey: `inv-issue:${inv.id}`, sourceType: "invoice", sourceId: inv.id }, (s) => postInvoiceIssued(client, s, inv));
}

export async function accountInvoiceCancelled(client: Client, invoiceId: string): Promise<void> {
  const inv = (await client.query("SELECT * FROM invoices WHERE id = $1", [invoiceId])).rows[0] as Row | undefined;
  if (!inv) return;
  await accountSafely(client, { organizationId: inv.organization_id, environment: inv.environment, sourceKey: `inv-cancel:${inv.id}`, sourceType: "invoice", sourceId: inv.id }, (s) => postInvoiceCancelled(client, s, inv));
}

export async function accountWriteOff(client: Client, invoiceId: string, resolutionId: string, amountBase: bigint, actor: Actor): Promise<void> {
  const inv = (await client.query("SELECT organization_id, environment FROM invoices WHERE id = $1", [invoiceId])).rows[0] as Row | undefined;
  if (!inv) return;
  await accountSafely(client, { organizationId: inv.organization_id, environment: inv.environment, sourceKey: `writeoff:${resolutionId}`, sourceType: "resolution", sourceId: resolutionId }, (s) =>
    postWriteOff(client, s, invoiceId, resolutionId, amountBase, new Date(), actor)
  );
}
