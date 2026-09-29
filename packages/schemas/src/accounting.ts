import { z } from "zod";
import { address, decimalAmount } from "./api";

/** Accounting request schemas (chart of accounts, journal, periods, vendors, bills, expenses, reports). */

const id = z.string().min(1).max(64);
export const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-09-30");
const reason = (msg: string) => z.string().trim().min(3, msg).max(1000);

export const LEDGER_ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "cogs", "expense"] as const;

export const createLedgerAccountInput = z.object({
  code: z.string().trim().regex(/^[0-9]{3,6}$/, "Account codes are 3 to 6 digits"),
  name: z.string().trim().min(1).max(120),
  type: z.enum(LEDGER_ACCOUNT_TYPES),
  subtype: z.string().trim().max(40).optional(),
  description: z.string().trim().max(500).nullable().optional()
});

export const updateLedgerAccountInput = z.object({
  code: z.string().trim().regex(/^[0-9]{3,6}$/, "Account codes are 3 to 6 digits").optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  archived: z.boolean().optional()
});

export const ledgerAccountListQuery = z.object({
  include_archived: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  as_of: isoDateString.optional()
});

const journalLineInput = z
  .object({
    account_id: id,
    debit: decimalAmount.optional(),
    credit: decimalAmount.optional(),
    memo: z.string().trim().max(500).optional(),
    customer_id: id.optional(),
    vendor_id: id.optional()
  })
  .refine((l) => !!l.debit !== !!l.credit, { message: "Each line is either a debit or a credit", path: ["debit"] });

export const createJournalEntryInput = z.object({
  date: isoDateString,
  description: z.string().trim().min(1, "Describe the entry").max(500),
  memo: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(journalLineInput).min(2, "An entry needs at least two lines").max(200),
  /** Post immediately instead of saving a draft. */
  post: z.boolean().default(false)
});

export const updateJournalEntryInput = z.object({
  date: isoDateString.optional(),
  description: z.string().trim().min(1).max(500).optional(),
  memo: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(journalLineInput).min(2).max(200).optional()
});

export const reverseJournalEntryInput = z.object({ reason: reason("Say why it's being reversed"), date: isoDateString.optional() });
export const voidJournalEntryInput = z.object({ reason: reason("Say why it's being discarded") });

export const journalListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  status: z.enum(["draft", "approved", "posted", "void"]).optional(),
  source_type: z.string().max(40).optional(),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
  search: z.string().trim().max(200).optional()
});

export const generalLedgerQuery = z.object({
  account_id: id.optional(),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
  customer_id: id.optional(),
  vendor_id: id.optional(),
  source_type: z.string().max(40).optional(),
  entry_id: id.optional(),
  payment_id: id.optional(),
  invoice_id: id.optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  format: z.enum(["json", "csv"]).default("json")
});

export const periodInput = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, "Use a month like 2026-09") });
export const reopenPeriodInput = periodInput.extend({ reason: reason("Say why the period is being reopened") });

export const accountingSettingsInput = z.object({ method: z.enum(["accrual", "cash"]) });

export const reportRangeQuery = z.object({
  from: isoDateString.optional(),
  to: isoDateString.optional(),
  format: z.enum(["json", "csv"]).default("json")
});
export const reportAsOfQuery = z.object({
  as_of: isoDateString.optional(),
  format: z.enum(["json", "csv"]).default("json")
});

export const createVendorInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(254).nullable().optional(),
  external_ref: z.string().trim().max(100).nullable().optional(),
  default_account_id: id.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  wallet_addresses: z
    .array(z.object({ address, network: z.enum(["monad", "base", "local"]).default("monad"), label: z.string().trim().max(80).optional() }))
    .max(20)
    .default([])
});
export const updateVendorInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  default_account_id: id.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  archived: z.boolean().optional()
});

export const createBillInput = z
  .object({
    vendor_id: id,
    number: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1, "Say what the bill is for").max(140),
    description: z.string().trim().max(2000).nullable().optional(),
    amount: decimalAmount,
    account_id: id.nullable().optional(),
    bill_date: isoDateString,
    due_date: isoDateString.nullable().optional(),
    approve: z.boolean().default(false)
  })
  .refine((b) => !b.due_date || b.due_date >= b.bill_date, { message: "The due date is before the bill date", path: ["due_date"] });

export const payBillInput = z
  .object({
    outgoing_transfer_id: id.nullable().optional(),
    paid_from_account_id: id.nullable().optional(),
    amount: decimalAmount.optional(),
    paid_on: isoDateString.optional(),
    reference: z.string().trim().max(200).nullable().optional(),
    memo: z.string().trim().max(500).nullable().optional()
  })
  .refine((p) => !p.outgoing_transfer_id !== !p.paid_from_account_id, { message: "Link the onchain transfer, or choose the account it was paid from", path: ["outgoing_transfer_id"] });

export const createExpenseInput = z
  .object({
    title: z.string().trim().min(1, "Say what the expense was").max(140),
    description: z.string().trim().max(2000).nullable().optional(),
    amount: decimalAmount.optional(),
    account_id: id.nullable().optional(),
    vendor_id: id.nullable().optional(),
    expense_date: isoDateString.optional(),
    reference: z.string().trim().max(200).nullable().optional(),
    outgoing_transfer_id: id.nullable().optional(),
    paid_from_account_id: id.nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    approve: z.boolean().default(false)
  })
  .refine((x) => !x.outgoing_transfer_id !== !x.paid_from_account_id, { message: "Link the onchain transfer, or choose the account it was paid from", path: ["outgoing_transfer_id"] })
  .refine((x) => !!x.outgoing_transfer_id || !!x.amount, { message: "Enter the amount", path: ["amount"] });

export const reasonInput = z.object({ reason: reason("Give a short reason") });

export const classifyTransactionInput = z
  .object({
    payment_id: id.nullable().optional(),
    outgoing_transfer_id: id.nullable().optional(),
    account_id: id,
    reason: reason("Say what this money was")
  })
  .refine((c) => !c.payment_id !== !c.outgoing_transfer_id, { message: "Classify either a received payment or an outgoing transfer", path: ["payment_id"] });

export const accountingListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  status: z.string().max(40).optional(),
  vendor_id: id.optional(),
  search: z.string().trim().max(200).optional()
});

export type CreateJournalEntryInput = z.infer<typeof createJournalEntryInput>;
export type CreateBillInput = z.infer<typeof createBillInput>;
export type CreateExpenseInput = z.infer<typeof createExpenseInput>;

// ── Exchange rates, bank reconciliation, credits, opening balances ──────────────────────────────

export const fxRateInput = z.object({
  base: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/, "Use a currency or token code, like EUR or MON"),
  quote: z.string().trim().toUpperCase().length(3).default("USD"),
  rate_date: isoDateString,
  rate: z.string().trim().regex(/^\d+(\.\d{1,18})?$/, "Enter the rate as a decimal, like 1.0842"),
  note: z.string().trim().max(300).nullable().optional()
});

export const bankImportInput = z.object({
  filename: z.string().trim().max(200).nullable().optional(),
  csv: z.string().min(1, "The file is empty").max(900_000, "Import at most about 900 KB at a time"),
  mapping: z.object({
    date: z.string().min(1).max(100),
    description: z.string().min(1).max(100),
    amount: z.string().max(100).optional(),
    money_in: z.string().max(100).optional(),
    money_out: z.string().max(100).optional(),
    reference: z.string().max(100).optional()
  }),
  date_format: z.enum(["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "DD.MM.YYYY"]).default("YYYY-MM-DD"),
  has_header: z.boolean().default(true)
});
export const bankMatchInput = z.object({ journal_line_id: z.string().min(1).max(64) });
export const bankCreateEntryInput = z.object({ account_id: z.string().min(1).max(64), memo: z.string().trim().max(500).nullable().optional() });
export const bankReconcileQuery = z.object({ date: isoDateString, statement_balance: z.string().trim().max(40).optional() });
export const bankReconcileInput = z.object({ statement_date: isoDateString, statement_balance: z.string().trim().min(1).max(40) });
export const bankLinesQuery = z.object({ status: z.enum(["unmatched", "matched", "excluded"]).optional() });

export const applyCreditInput = z.object({ invoice_id: z.string().min(1).max(64), amount: decimalAmount.optional(), reason: z.string().trim().max(500).nullable().optional() });
export const creditNoteInput = z.object({ amount: decimalAmount, reason: z.string().trim().min(3, "Say why").max(1000), account_id: z.string().max(64).nullable().optional() });

export const openingBalancesInput = z.object({
  date: isoDateString,
  lines: z
    .array(z.object({ account_id: z.string().min(1).max(64), amount: z.string().trim().regex(/^-?(0|[1-9]\d*)(\.\d{1,6})?$/, "Enter an amount like 1250.00"), memo: z.string().trim().max(300).nullable().optional() }))
    .min(1)
    .max(200)
});
export const yearParam = z.object({ year: z.coerce.number().int().min(2000).max(2100) });

// ── Exports, attachments, recurring bills ───────────────────────────────────────────────────────

export const journalExportQuery = z.object({
  format: z.enum(["quickbooks", "xero", "setra"]).default("setra"),
  from: isoDateString,
  to: isoDateString,
  date_format: z.enum(["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"]).optional(),
  tax_rate: z.string().trim().max(60).optional(),
  include_closing: z.enum(["true", "false"]).default("false").transform((v) => v === "true")
});
export const chartExportQuery = z.object({ format: z.enum(["quickbooks", "xero", "setra"]).default("setra"), tax_rate: z.string().trim().max(60).optional() });

export const attachmentInput = z.object({
  object_type: z.enum(["bill", "expense", "journal_entry", "vendor"]),
  object_id: z.string().min(1).max(64),
  filename: z.string().trim().min(1).max(200),
  content_type: z.enum(["application/pdf", "image/png", "image/jpeg", "image/webp", "text/csv", "text/plain"]),
  data_base64: z.string().min(4).max(14_000_000)
});
export const attachmentListQuery = z.object({ object_type: z.enum(["bill", "expense", "journal_entry", "vendor"]), object_id: z.string().min(1).max(64) });

export const recurringBillInput = z
  .object({
    vendor_id: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(140),
    amount: decimalAmount,
    account_id: z.string().max(64).nullable().optional(),
    frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
    start_date: isoDateString,
    end_date: isoDateString.nullable().optional(),
    due_days: z.number().int().min(0).max(365).default(14),
    auto_approve: z.boolean().default(false),
    number_prefix: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,20}$/, "Letters, numbers, dots and dashes").nullable().optional()
  })
  .refine((r) => !r.end_date || r.end_date >= r.start_date, { message: "The end date is before the start date", path: ["end_date"] });
export const recurringStatusInput = z.object({ status: z.enum(["active", "paused", "ended"]) });
