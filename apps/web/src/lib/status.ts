import { EXCEPTION_TYPE_LABEL, INVOICE_STATUS_LABEL, PAYMENT_STATUS_LABEL } from "@setra/schemas";

export type Tone = "success" | "warning" | "danger" | "info" | "accent" | "neutral";

export const paymentTone: Record<string, Tone> = {
  confirming: "info",
  matched: "success",
  partial: "warning",
  overpaid: "accent",
  needs_review: "warning",
  reversed: "danger",
  dismissed: "neutral",
  refunded: "neutral"
};

export const invoiceTone: Record<string, Tone> = {
  open: "neutral",
  partially_paid: "warning",
  paid: "success",
  overpaid: "accent",
  expired: "neutral",
  cancelled: "neutral"
};

export const exceptionTone: Record<string, Tone> = {
  unknown_payment: "warning",
  ambiguous_match: "warning",
  partial_payment: "info",
  overpayment: "accent",
  duplicate_payment: "warning",
  late_payment: "warning",
  wrong_token: "danger",
  wrong_network: "danger",
  reversal: "danger"
};

export const paymentLabel = (s: string) => PAYMENT_STATUS_LABEL[s as keyof typeof PAYMENT_STATUS_LABEL] ?? s;
export const invoiceLabel = (s: string) => INVOICE_STATUS_LABEL[s as keyof typeof INVOICE_STATUS_LABEL] ?? s;
export const exceptionLabel = (s: string) => EXCEPTION_TYPE_LABEL[s as keyof typeof EXCEPTION_TYPE_LABEL] ?? s;

export const eventLabel: Record<string, string> = {
  PAYMENT_OBSERVED: "Payment detected",
  PAYMENT_MATCHED: "Payment matched",
  PARTIALLY_PAID: "Partially paid",
  OVERPAID: "Overpaid",
  UNKNOWN_PAYMENT: "Needs review",
  PAYMENT_REVERSED: "Payment reversed",
  REFUND_OBSERVED: "Refund recorded",
  PAYMENT_DISMISSED: "Not applied",
  PAYMENT_UNASSIGNED: "Taken off invoice",
  RECEIVABLE_CREATED: "Receivable created",
  PAYABLE_CREATED: "Bill approved",
  PAYABLE_SETTLED: "Bill paid",
  EXPENSE_RECORDED: "Expense recorded",
  JOURNAL_ENTRY_POSTED: "Journal entry posted",
  JOURNAL_ENTRY_REVERSED: "Journal entry reversed"
};
