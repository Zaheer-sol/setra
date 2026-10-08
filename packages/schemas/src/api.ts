import { z } from "zod";
import { EXCEPTION_STATUSES, EXCEPTION_TYPES, INVOICE_STATUSES, PAYMENT_STATUSES, RESOLUTION_ACTIONS, ROLES, WEBHOOK_EVENT_TYPES } from "./domain";

/** API request schemas. Field names are snake_case at the HTTP boundary. */

export const address = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a 20-byte hex address (0x…)")
  .transform((v) => v.toLowerCase() as `0x${string}`);

export const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Must be a 32-byte transaction hash");

/** Decimal money string. Never a JSON number, so no precision is lost in transit. */
export const decimalAmount = z
  .string()
  .trim()
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'Use a decimal string such as "2000.00"');

export const metadata = z
  .record(z.string().max(40), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= 20, "At most 20 metadata keys")
  .default({});

const networkFamily = z.enum(["monad", "base", "local"]);

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  starting_after: z.string().max(64).optional(),
  ending_before: z.string().max(64).optional()
});

export const dateRange = {
  created_gte: z.string().datetime({ offset: true }).optional(),
  created_lte: z.string().datetime({ offset: true }).optional()
};

// ---- auth -------------------------------------------------------------------------------------

export const password = z.string().min(10, "Use at least 10 characters").max(200);

export const signupInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  password,
  business_name: z.string().trim().min(1).max(120).optional()
});

export const loginInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200)
});

export const forgotPasswordInput = z.object({ email: z.string().trim().toLowerCase().email() });
export const resetPasswordInput = z.object({ token: z.string().min(20).max(200), password });
export const acceptInvitationInput = z.object({ token: z.string().min(20).max(200), name: z.string().trim().min(1).max(120).optional(), password: password.optional() });

// ---- organization -----------------------------------------------------------------------------

export const createOrganizationInput = z.object({ name: z.string().trim().min(1).max(120) });
export const updateOrganizationInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  support_email: z.string().trim().email().max(254).nullable().optional(),
  onboarding_completed: z.boolean().optional(),
  /** Look up public labels (Nansen) for the senders of unidentified payments. Sends the address to Nansen. */
  counterparty_intel_enabled: z.boolean().optional()
});
export const inviteMemberInput = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(ROLES).exclude(["owner"]) });
export const updateMemberInput = z.object({ role: z.enum(ROLES).exclude(["owner"]) });

// ---- wallets ----------------------------------------------------------------------------------

export const createWalletInput = z.object({
  name: z.string().trim().min(1).max(80),
  network: networkFamily.default("monad"),
  address,
  assets: z.array(z.string().trim().toUpperCase()).min(1).max(5).default(["USDC"]),
  backfill_from_block: z.coerce.bigint().nonnegative().optional()
});
export const updateWalletInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  monitoring_enabled: z.boolean().optional()
});

// ---- customers --------------------------------------------------------------------------------

export const createCustomerInput = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  external_ref: z.string().trim().max(120).optional(),
  wallet_addresses: z.array(z.object({ address, network: networkFamily.default("monad"), label: z.string().trim().max(80).optional() })).max(20).default([]),
  metadata
});
export const updateCustomerInput = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  external_ref: z.string().trim().max(120).nullable().optional(),
  metadata: metadata.optional()
});
export const addCustomerAddressInput = z.object({ address, network: networkFamily.default("monad"), label: z.string().trim().max(80).optional() });
export const customerListQuery = listQuery.extend({ search: z.string().trim().max(120).optional(), external_ref: z.string().trim().min(1).max(120).optional() });

// ---- invoices ---------------------------------------------------------------------------------

export const lineItemInput = z.object({
  description: z.string().trim().min(1, "Describe the item").max(200),
  quantity: z.number().int().min(1).max(1_000_000).default(1),
  unit_amount: decimalAmount
});

export const createInvoiceInput = z
  .object({
    customer_id: z.string().min(1).max(64),
    number: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Use letters, numbers, dashes, dots or slashes")
      .optional(),
    /** What is this payment for? Shown to the payer and on every payment applied to the invoice. */
    title: z.string().trim().min(1, "Say what this payment is for").max(140),
    /** Optional detail about what is being paid for. */
    purpose: z.string().trim().min(1).max(500).optional(),
    /** Optional itemization. Items must add up to the amount; if the amount is omitted it is their total. */
    line_items: z.array(lineItemInput).min(1).max(50).optional(),
    amount: decimalAmount.optional(),
    /** The part of the amount that is sales tax or VAT (already included, never added on top). Booked to Taxes Payable, not revenue. */
    tax: decimalAmount.optional(),
    currency: z.literal("USD").default("USD"),
    asset: z.string().trim().toUpperCase().default("USDC"),
    network: networkFamily.default("monad"),
    wallet_id: z.string().max(64).optional(),
    due_at: z.string().datetime({ offset: true }).optional(),
    expires_at: z.string().datetime({ offset: true }).optional(),
    metadata
  })
  .refine((v) => v.amount !== undefined || (v.line_items?.length ?? 0) > 0, { message: "Enter an amount or add line items", path: ["amount"] })
  .refine((v) => !v.due_at || !v.expires_at || new Date(v.expires_at) >= new Date(v.due_at), {
    message: "Expiration must be on or after the due date",
    path: ["expires_at"]
  });

export const invoiceListQuery = listQuery.extend({
  status: z.enum(INVOICE_STATUSES).optional(),
  /** `unpaid`: open or partially paid. `overdue`: unpaid and past its due date. */
  state: z.enum(["unpaid", "overdue"]).optional(),
  customer_id: z.string().max(64).optional(),
  external_id: z.string().trim().min(1).max(120).optional(),
  search: z.string().trim().max(120).optional(),
  ...dateRange
});

/**
 * An order from the merchant's own system (store, checkout, payment processor or backend). Setra keeps it
 * as an invoice keyed by the merchant's order ID, so the merchant never creates invoices by hand. Sending
 * the same order again is harmless; a changed amount replaces the order while nothing has been paid.
 */
export const orderInput = z
  .object({
    external_id: z.string().trim().min(1).max(120),
    /** Shown on the order and in exports. Defaults to Setra's own numbering. */
    number: z
      .string()
      .trim()
      .max(40)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Use letters, numbers, dashes, dots or slashes")
      .optional(),
    status: z.enum(["open", "cancelled"]).default("open"),
    customer_id: z.string().max(64).optional(),
    customer: z
      .object({
        external_ref: z.string().trim().min(1).max(120).optional(),
        name: z.string().trim().min(1).max(160).optional(),
        email: z.string().trim().toLowerCase().email().max(254).optional(),
        wallet_addresses: z.array(z.object({ address, network: networkFamily.default("monad") })).max(20).default([])
      })
      .optional(),
    title: z.string().trim().min(1).max(140).optional(),
    purpose: z.string().trim().min(1).max(500).optional(),
    line_items: z.array(lineItemInput).min(1).max(50).optional(),
    amount: decimalAmount.optional(),
    /** The part of the amount that is sales tax or VAT (already included, never added on top). Booked to Taxes Payable, not revenue. */
    tax: decimalAmount.optional(),
    currency: z.literal("USD").default("USD"),
    asset: z.string().trim().toUpperCase().default("USDC"),
    network: networkFamily.default("monad"),
    wallet_id: z.string().max(64).optional(),
    due_at: z.string().datetime({ offset: true }).optional(),
    expires_at: z.string().datetime({ offset: true }).optional(),
    metadata
  })
  .refine((v) => v.status === "cancelled" || v.amount !== undefined || (v.line_items?.length ?? 0) > 0, { message: "Enter an amount or add line items", path: ["amount"] })
  .refine((v) => v.status === "cancelled" || v.customer_id || v.customer?.external_ref || v.customer?.email, {
    message: "Say who the customer is: customer_id, customer.external_ref or customer.email",
    path: ["customer"]
  });
export type OrderInput = z.infer<typeof orderInput>;

export const createOrderSourceInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("generic"), name: z.string().trim().min(1).max(80) }),
  /** Shopify signs order webhooks with the store's own signing secret, shown under Settings → Notifications → Webhooks. */
  z.object({ kind: z.literal("shopify"), name: z.string().trim().min(1).max(80), secret: z.string().trim().min(16).max(200) }),
  /** WooCommerce signs with whatever secret is pasted into its webhook settings, so Setra generates one. */
  z.object({ kind: z.literal("woocommerce"), name: z.string().trim().min(1).max(80) })
]);

export const cancelInvoiceInput = z.object({ reason: z.string().trim().max(500).optional() }).default({});

// ---- payments ---------------------------------------------------------------------------------

export const paymentListQuery = listQuery.extend({
  status: z.union([z.enum(PAYMENT_STATUSES), z.literal("settled")]).optional(),
  customer_id: z.string().max(64).optional(),
  invoice_id: z.string().max(64).optional(),
  wallet_id: z.string().max(64).optional(),
  network: networkFamily.optional(),
  asset: z.string().trim().toUpperCase().max(12).optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.enum(["newest", "oldest", "amount_desc", "amount_asc"]).default("newest"),
  ...dateRange
});

// ---- exceptions -------------------------------------------------------------------------------

export const exceptionListQuery = listQuery.extend({
  status: z.enum(EXCEPTION_STATUSES).optional(),
  type: z.enum(EXCEPTION_TYPES).optional()
});

export const resolveExceptionInput = z
  .object({
    action: z.enum(RESOLUTION_ACTIONS),
    invoice_id: z.string().max(64).optional(),
    reason: z.string().trim().min(3, "Explain the decision in a few words").max(1000),
    remember_sender: z.boolean().default(false),
    /** For `refund`: the outgoing transfer from your wallet that sent the money back. */
    outgoing_transfer_id: z.string().max(64).optional()
  })
  .refine((v) => v.action !== "assign" || !!v.invoice_id, { message: "Choose the invoice to assign this payment to", path: ["invoice_id"] })
  .refine((v) => v.action !== "refund" || !!v.outgoing_transfer_id, { message: "Choose the transfer that refunded this payment", path: ["outgoing_transfer_id"] });

/** Correct how an applied payment is allocated: move it to another invoice, or take it back to review. */
export const correctPaymentInput = z
  .object({
    action: z.enum(["reassign", "unassign"]),
    invoice_id: z.string().max(64).optional(),
    reason: z.string().trim().min(3, "Explain the correction in a few words").max(1000)
  })
  .refine((v) => v.action !== "reassign" || !!v.invoice_id, { message: "Choose the invoice to move this payment to", path: ["invoice_id"] });

/** Record that a payment's money was sent back, proven by an outgoing transfer from your wallet. */
export const recordRefundInput = z.object({
  outgoing_transfer_id: z.string().min(1).max(64),
  reason: z.string().trim().min(3, "Say why it was refunded").max(1000)
});

/** Email a payment request to the customer. */
export const sendInvoiceInput = z
  .object({
    to: z.string().trim().email("Enter a valid email address").max(254).optional(),
    message: z.string().trim().max(1000).optional()
  })
  .default({});

// ---- reconciliation ---------------------------------------------------------------------------

export const reconciliationQuery = z.object({
  period_start: z.string().datetime({ offset: true }).optional(),
  period_end: z.string().datetime({ offset: true }).optional(),
  network: networkFamily.optional(),
  asset: z.string().trim().toUpperCase().max(12).optional()
});

// ---- events -----------------------------------------------------------------------------------

export const financialEventListQuery = listQuery.extend({
  type: z.string().max(40).optional(),
  invoice_id: z.string().max(64).optional(),
  payment_id: z.string().max(64).optional()
});

// ---- payment intents --------------------------------------------------------------------------

export const createPaymentIntentInput = z.object({
  invoice_id: z.string().max(64),
  expires_in_seconds: z.coerce.number().int().min(300).max(60 * 60 * 24 * 90).optional()
});

// ---- webhooks ---------------------------------------------------------------------------------

export const createWebhookEndpointInput = z.object({
  url: z.string().trim().url().max(2000),
  description: z.string().trim().max(200).optional(),
  event_types: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).default(["payment.matched", "payment.partially_paid", "payment.overpaid", "payment.unknown", "payment.reversed"])
});
export const updateWebhookEndpointInput = z.object({
  url: z.string().trim().url().max(2000).optional(),
  description: z.string().trim().max(200).nullable().optional(),
  event_types: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).optional(),
  enabled: z.boolean().optional()
});
export const webhookDeliveryListQuery = listQuery.extend({
  endpoint_id: z.string().max(64).optional(),
  status: z.enum(["pending", "delivering", "retrying", "delivered", "failed"]).optional(),
  event_id: z.string().max(64).optional()
});

// ---- API keys ---------------------------------------------------------------------------------

export const createApiKeyInput = z.object({
  name: z.string().trim().min(1).max(80),
  mode: z.enum(["test", "live"]).optional(),
  scope: z.enum(["read_write", "read_only"]).default("read_write")
});

// ---- test mode simulator ----------------------------------------------------------------------

export const simulatePaymentInput = z.object({
  scenario: z.enum(["exact", "partial", "overpaid", "unknown", "wrong_token", "wrong_network", "duplicate"]).default("exact"),
  invoice_id: z.string().max(64).optional(),
  wallet_id: z.string().max(64).optional(),
  amount: decimalAmount.optional(),
  from_address: address.optional(),
  finalize: z.boolean().default(true)
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceInput>;
export type CreateCustomerInput = z.infer<typeof createCustomerInput>;
export type CreateWalletInput = z.infer<typeof createWalletInput>;
export type ResolveExceptionInput = z.infer<typeof resolveExceptionInput>;
export type CorrectPaymentInput = z.infer<typeof correctPaymentInput>;
export type RecordRefundInput = z.infer<typeof recordRefundInput>;
export type SimulatePaymentInput = z.infer<typeof simulatePaymentInput>;
