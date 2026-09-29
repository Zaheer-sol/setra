/** Shared domain vocabulary. These strings are part of Setra's public contract, change them only with a versioned migration. */

export const ENVIRONMENTS = ["test", "live"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const ROLES = ["owner", "admin", "operator", "accountant", "developer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const INVOICE_STATUSES = ["open", "partially_paid", "paid", "overpaid", "expired", "cancelled"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * A payment is money that actually arrived at a merchant wallet.
 * - confirming: observed on chain, not yet final. No economic effect yet.
 * - matched / partial / overpaid: final and applied to an invoice.
 * - needs_review: final, but Setra could not safely decide where it belongs.
 * - reversed: the source observation is no longer canonical; any effect was compensated.
 * - dismissed: an operator decided it is not a customer payment (history preserved).
 */
export const PAYMENT_STATUSES = ["confirming", "matched", "partial", "overpaid", "needs_review", "reversed", "dismissed", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const CONFIRMATION_STATES = ["observed", "confirmed", "finalized", "dropped"] as const;
export type ConfirmationState = (typeof CONFIRMATION_STATES)[number];

export const EXCEPTION_TYPES = [
  "unknown_payment",
  "ambiguous_match",
  "partial_payment",
  "overpayment",
  "duplicate_payment",
  "late_payment",
  "wrong_token",
  "wrong_network",
  "reversal"
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

export const EXCEPTION_STATUSES = ["open", "resolved"] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

export const RESOLUTION_ACTIONS = ["assign", "dismiss", "acknowledge", "write_off", "refund"] as const;
export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number];

/** Which resolution actions make sense for each exception type. Enforced server-side. */
export const ALLOWED_RESOLUTIONS: Record<ExceptionType, ResolutionAction[]> = {
  unknown_payment: ["assign", "refund", "dismiss"],
  ambiguous_match: ["assign", "refund", "dismiss"],
  duplicate_payment: ["assign", "refund", "acknowledge", "dismiss"],
  late_payment: ["assign", "refund", "dismiss"],
  wrong_network: ["assign", "refund", "dismiss"],
  partial_payment: ["acknowledge", "write_off"],
  overpayment: ["refund", "acknowledge"],
  wrong_token: ["dismiss", "acknowledge"],
  reversal: ["acknowledge"]
};

export const FINANCIAL_EVENT_TYPES = [
  "PAYMENT_OBSERVED",
  "PAYMENT_MATCHED",
  "PARTIALLY_PAID",
  "OVERPAID",
  "UNKNOWN_PAYMENT",
  "PAYMENT_REVERSED",
  "REFUND_OBSERVED",
  "PAYMENT_DISMISSED",
  "PAYMENT_UNASSIGNED"
] as const;
export type FinancialEventType = (typeof FINANCIAL_EVENT_TYPES)[number];

/** Webhook/topic names derived from financial event types. */
export const WEBHOOK_EVENT_NAMES: Record<FinancialEventType, string> = {
  PAYMENT_OBSERVED: "payment.observed",
  PAYMENT_MATCHED: "payment.matched",
  PARTIALLY_PAID: "payment.partially_paid",
  OVERPAID: "payment.overpaid",
  UNKNOWN_PAYMENT: "payment.unknown",
  PAYMENT_REVERSED: "payment.reversed",
  REFUND_OBSERVED: "payment.refunded",
  PAYMENT_DISMISSED: "payment.dismissed",
  PAYMENT_UNASSIGNED: "payment.unassigned"
};
/** Business activity recorded as financial events (not tied to a payment). */
export const BUSINESS_EVENT_TYPES = ["RECEIVABLE_CREATED", "PAYABLE_CREATED", "PAYABLE_SETTLED", "EXPENSE_RECORDED", "JOURNAL_ENTRY_POSTED", "JOURNAL_ENTRY_REVERSED"] as const;
export type BusinessEventType = (typeof BUSINESS_EVENT_TYPES)[number];
export const BUSINESS_EVENT_NAMES: Record<BusinessEventType, string> = {
  RECEIVABLE_CREATED: "receivable.created",
  PAYABLE_CREATED: "payable.created",
  PAYABLE_SETTLED: "payable.settled",
  EXPENSE_RECORDED: "expense.recorded",
  JOURNAL_ENTRY_POSTED: "journal_entry.posted",
  JOURNAL_ENTRY_REVERSED: "journal_entry.reversed"
};
export const WEBHOOK_EVENT_TYPES = [...Object.values(WEBHOOK_EVENT_NAMES), ...Object.values(BUSINESS_EVENT_NAMES), "webhook.test"] as const;

export const PAYMENT_INTENT_STATUSES = ["open", "paid", "expired", "cancelled", "refunded"] as const;
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

export const SOURCE_TYPES = ["erc20_transfer", "payment_intent_event", "simulated"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Human copy for statuses, the console and hosted page never show raw enum names. */
export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  open: "Awaiting payment",
  partially_paid: "Partially paid",
  paid: "Paid",
  overpaid: "Overpaid",
  expired: "Expired",
  cancelled: "Cancelled"
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  confirming: "Confirming",
  matched: "Paid",
  partial: "Partially paid",
  overpaid: "Overpaid",
  needs_review: "Needs review",
  reversed: "Reversed",
  dismissed: "Dismissed",
  refunded: "Refunded"
};

export const EXCEPTION_TYPE_LABEL: Record<ExceptionType, string> = {
  unknown_payment: "Unknown payment",
  ambiguous_match: "Ambiguous match",
  partial_payment: "Partial payment",
  overpayment: "Overpayment",
  duplicate_payment: "Possible duplicate",
  late_payment: "Late payment",
  wrong_token: "Wrong token",
  wrong_network: "Wrong network",
  reversal: "Payment reversed"
};
