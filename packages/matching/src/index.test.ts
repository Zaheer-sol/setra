import { describe, expect, it } from "vitest";
import { matchPayment, statusForBalance, type InvoiceCandidate, type MatchContext, type ObservedPayment } from "./index";

const USDC = "asset_monad_usdc";
const USDT = "asset_monad_usdt0";
const WALLET = "wal_main";
const WALLET_ADDRESS = "0x00000000000000000000000000000000000000aa";
const $ = (n: number) => BigInt(Math.round(n * 100)) * 10_000n; // dollars → 6-decimal base units (test helper only)

const now = new Date("2026-10-10T12:00:00Z");

function invoice(overrides: Partial<InvoiceCandidate> & { id: string }): InvoiceCandidate {
  return {
    number: overrides.id.toUpperCase(),
    customerId: "cus_acme",
    customerName: "Acme Ltd",
    chainId: 143,
    walletId: WALLET,
    walletAddress: WALLET_ADDRESS,
    assetId: USDC,
    amountDue: $(2000),
    amountPaid: 0n,
    amountWrittenOff: 0n,
    status: "open",
    issuedAt: new Date("2026-10-01T00:00:00Z"),
    dueAt: new Date("2026-10-15T00:00:00Z"),
    expiresAt: new Date("2026-10-31T00:00:00Z"),
    ...overrides
  };
}

function payment(overrides: Partial<ObservedPayment> = {}): ObservedPayment {
  return {
    chainId: 143,
    walletId: WALLET,
    walletName: "Main Wallet",
    walletAddress: WALLET_ADDRESS,
    assetId: USDC,
    assetSymbol: "USDC",
    fromAddress: "0x9100000000000000000000000000000000000a72",
    amount: $(2000),
    timestamp: now,
    ...overrides
  };
}

function ctx(invoices: InvoiceCandidate[], overrides: Partial<MatchContext> = {}): MatchContext {
  return { acceptedAssetIds: [USDC], invoices, knownSender: null, decimals: 6, ...overrides };
}

const acme = { customerId: "cus_acme", customerName: "Acme Ltd" };

describe("exact, partial and overpayment", () => {
  it("matches an exact payment from an unknown sender when the amount is unique", () => {
    const d = matchPayment(payment(), ctx([invoice({ id: "inv_2041" }), invoice({ id: "inv_2042", amountDue: $(1500), customerId: "cus_nova" })]));
    expect(d.outcome).toBe("matched");
    expect(d.invoiceId).toBe("inv_2041");
    expect(d.exceptionType).toBeNull();
    expect(d.checks.map((c) => c.code)).toEqual(["network", "receiving_wallet", "asset", "sender", "amount", "window", "uniqueness"]);
    expect(d.checks.find((c) => c.code === "amount")?.passed).toBe(true);
  });

  it("applies a partial payment only when the sender is a known customer wallet", () => {
    const d = matchPayment(payment({ amount: $(1500) }), ctx([invoice({ id: "inv_2042" })], { knownSender: acme }));
    expect(d.outcome).toBe("partial");
    expect(d.exceptionType).toBe("partial_payment");
    expect(d.remainingAfter).toBe($(500));
  });

  it("does NOT force a partial payment from an unknown sender onto the only open invoice", () => {
    const d = matchPayment(payment({ amount: $(1500) }), ctx([invoice({ id: "inv_2042" })]));
    expect(d.outcome).toBe("needs_review");
    expect(d.exceptionType).toBe("unknown_payment");
    expect(d.candidates[0]?.invoiceId).toBe("inv_2042");
    expect(d.candidates[0]?.reasons[0]).toContain("partial");
  });

  it("flags overpayment with the excess", () => {
    const d = matchPayment(payment({ amount: $(2500) }), ctx([invoice({ id: "inv_2041" })], { knownSender: acme }));
    expect(d.outcome).toBe("overpaid");
    expect(d.exceptionType).toBe("overpayment");
    expect(d.remainingAfter).toBe(-$(500));
  });

  it("settles a multi-payment invoice when the second payment covers the remaining balance", () => {
    const partiallyPaid = invoice({ id: "inv_2041", amountPaid: $(1000), status: "partially_paid" });
    const d = matchPayment(payment({ amount: $(1000) }), ctx([partiallyPaid]));
    expect(d.outcome).toBe("matched");
    expect(d.remainingAfter).toBe(0n);
  });

  it("uses remaining balance after write-offs", () => {
    const inv = invoice({ id: "inv_1", amountPaid: $(1500), amountWrittenOff: $(400), status: "partially_paid" });
    expect(matchPayment(payment({ amount: $(100) }), ctx([inv])).outcome).toBe("matched");
  });
});

describe("unknown and ambiguous payments", () => {
  it("returns unknown for an amount that matches nothing", () => {
    const d = matchPayment(payment({ amount: $(740) }), ctx([invoice({ id: "inv_2041" })]));
    expect(d.outcome).toBe("needs_review");
    expect(d.exceptionType).toBe("unknown_payment");
    expect(d.appliedAmount).toBe(0n);
  });

  it("refuses to choose between two invoices with the same amount for different customers", () => {
    const d = matchPayment(payment(), ctx([invoice({ id: "inv_a" }), invoice({ id: "inv_b", customerId: "cus_nova", customerName: "Nova Systems" })]));
    expect(d.exceptionType).toBe("ambiguous_match");
    expect(d.candidates.map((c) => c.invoiceId).sort()).toEqual(["inv_a", "inv_b"]);
  });

  it("requires review for identical invoices belonging to the same known customer", () => {
    const older = invoice({ id: "inv_old", dueAt: new Date("2026-10-05T00:00:00Z") });
    const newer = invoice({ id: "inv_new", dueAt: new Date("2026-10-20T00:00:00Z") });
    const d = matchPayment(payment(), ctx([newer, older], { knownSender: acme }));
    expect(d.outcome).toBe("needs_review");
    expect(d.exceptionType).toBe("ambiguous_match");
    expect(d.invoiceId).toBeNull();
    expect(d.appliedAmount).toBe(0n);
    expect(d.customerId).toBe(acme.customerId);
    expect(d.candidates.map((c) => c.invoiceId)).toEqual(["inv_old", "inv_new"]);
    expect(d.checks.find((c) => c.code === "uniqueness")?.passed).toBe(false);
  });

  it("asks for review when a known customer has several open invoices and none match the amount", () => {
    const d = matchPayment(payment({ amount: $(123) }), ctx([invoice({ id: "inv_a" }), invoice({ id: "inv_b", amountDue: $(900) })], { knownSender: acme }));
    expect(d.exceptionType).toBe("ambiguous_match");
    expect(d.customerId).toBe("cus_acme");
  });

  it("does not auto-match when the sender belongs to a different customer than the exact-amount invoice", () => {
    const d = matchPayment(payment(), ctx([invoice({ id: "inv_nova", customerId: "cus_nova", customerName: "Nova" })], { knownSender: acme }));
    expect(d.outcome).toBe("needs_review");
    expect(d.exceptionType).toBe("ambiguous_match");
  });
});

describe("rails: token, network, wallet, window", () => {
  it("never lets an unsupported asset satisfy an invoice", () => {
    const d = matchPayment(payment({ assetId: USDT, assetSymbol: "USDT0" }), ctx([invoice({ id: "inv_2041" })], { knownSender: acme }));
    expect(d.exceptionType).toBe("wrong_token");
    expect(d.invoiceId).toBeNull();
  });

  it("treats unknown tokens as wrong token", () => {
    expect(matchPayment(payment({ assetId: null, assetSymbol: "0xdead…beef" }), ctx([invoice({ id: "i" })])).exceptionType).toBe("wrong_token");
  });

  it("ignores invoices expecting a different wallet", () => {
    const d = matchPayment(payment(), ctx([invoice({ id: "inv_other", walletId: "wal_other" })]));
    expect(d.exceptionType).toBe("unknown_payment");
  });

  it("detects a payment on the wrong network for the same address", () => {
    const d = matchPayment(payment({ chainId: 8453, walletId: "wal_base" }), ctx([invoice({ id: "inv_2041" })]));
    expect(d.exceptionType).toBe("wrong_network");
    expect(d.candidates[0]?.invoiceId).toBe("inv_2041");
  });

  it("flags late payments instead of settling expired invoices", () => {
    const expired = invoice({ id: "inv_old", status: "expired", expiresAt: new Date("2026-10-05T00:00:00Z") });
    expect(matchPayment(payment(), ctx([expired])).exceptionType).toBe("late_payment");
    expect(matchPayment(payment(), ctx([expired], { knownSender: acme })).exceptionType).toBe("late_payment");
  });

  it("treats an open invoice past its expiry timestamp as late (expiry job may not have run yet)", () => {
    const stale = invoice({ id: "inv_stale", expiresAt: new Date("2026-10-09T00:00:00Z") });
    expect(matchPayment(payment(), ctx([stale])).exceptionType).toBe("late_payment");
  });

  it("never applies a payment to a cancelled invoice, and says so", () => {
    const cancelled = invoice({ id: "inv_cxl", status: "cancelled" });
    const unknown = matchPayment(payment(), ctx([cancelled]));
    expect(unknown.exceptionType).toBe("late_payment");
    expect(unknown.explanation).toContain("cancelled");
    expect(unknown.candidates[0]?.reasons).toContain("Invoice cancelled");
    const known = matchPayment(payment(), ctx([cancelled], { knownSender: acme }));
    expect(known.exceptionType).toBe("late_payment");
    expect(known.invoiceId).toBeNull();
  });

  it("does not match a payment made before the invoice existed", () => {
    const future = invoice({ id: "inv_future", issuedAt: new Date("2026-10-11T00:00:00Z") });
    expect(matchPayment(payment(), ctx([future])).outcome).toBe("needs_review");
  });

  it("flags possible duplicates for a known customer with nothing open", () => {
    const paid = invoice({ id: "inv_paid", status: "paid", amountPaid: $(2000), paidAt: new Date("2026-10-09T00:00:00Z") });
    const d = matchPayment(payment(), ctx([paid], { knownSender: acme }));
    expect(d.exceptionType).toBe("duplicate_payment");
    expect(d.candidates[0]?.reasons).toContain("Same amount");
  });
});

describe("payment intents", () => {
  const intent = { id: "pi_1", invoiceId: "inv_2041", walletId: WALLET, assetId: USDC, amount: $(2000) };

  it("identifies the invoice from the onchain reference, even when amounts collide", () => {
    const d = matchPayment(payment({ paymentIntent: intent }), ctx([invoice({ id: "inv_2041" }), invoice({ id: "inv_x", customerId: "cus_nova" })]));
    expect(d.outcome).toBe("matched");
    expect(d.invoiceId).toBe("inv_2041");
    expect(d.checks.find((c) => c.code === "payment_intent")?.passed).toBe(true);
  });

  it("reports a duplicate when the referenced invoice was already paid", () => {
    const d = matchPayment(payment({ paymentIntent: intent }), ctx([invoice({ id: "inv_2041", status: "paid", amountPaid: $(2000) })]));
    expect(d.exceptionType).toBe("duplicate_payment");
  });

  it("rejects intents whose terms don't match what arrived", () => {
    const d = matchPayment(payment({ paymentIntent: { ...intent, amount: $(1) } }), ctx([invoice({ id: "inv_2041" })]));
    expect(d.outcome).toBe("needs_review");
  });

  it("does not let a referenced payment settle an expired invoice", () => {
    const expired = invoice({ id: "inv_2041", status: "expired", expiresAt: new Date("2026-10-05T00:00:00Z") });
    const d = matchPayment(payment({ paymentIntent: intent }), ctx([expired]));
    expect(d.outcome).toBe("needs_review");
    expect(d.exceptionType).toBe("late_payment");
    expect(d.appliedAmount).toBe(0n);
    expect(d.checks.find((c) => c.code === "window")?.passed).toBe(false);
  });

  it("checks the payment timestamp even before the expiry job updates invoice status", () => {
    const stale = invoice({ id: "inv_2041", expiresAt: new Date("2026-10-05T00:00:00Z") });
    expect(matchPayment(payment({ paymentIntent: intent }), ctx([stale])).exceptionType).toBe("late_payment");
  });

  it("does not accept a reference to a different network or receiving wallet", () => {
    const otherRail = invoice({ id: "inv_2041", chainId: 8453, walletId: "wal_base" });
    const d = matchPayment(payment({ paymentIntent: intent }), ctx([otherRail]));
    expect(d.outcome).toBe("needs_review");
    expect(d.checks.find((c) => c.code === "payment_intent")?.passed).toBe(false);
  });
});

describe("determinism", () => {
  it("returns identical decisions regardless of candidate order", () => {
    const invoices = [invoice({ id: "inv_a", amountDue: $(10) }), invoice({ id: "inv_b" }), invoice({ id: "inv_c", customerId: "cus_x", amountDue: $(99) })];
    const a = matchPayment(payment(), ctx(invoices));
    const b = matchPayment(payment(), ctx([...invoices].reverse()));
    expect(b).toEqual(a);
  });
});

describe("statusForBalance", () => {
  it("derives invoice status from balances", () => {
    expect(statusForBalance(100n, 0n, 0n, false)).toBe("open");
    expect(statusForBalance(100n, 0n, 0n, true)).toBe("expired");
    expect(statusForBalance(100n, 40n, 0n, true)).toBe("partially_paid");
    expect(statusForBalance(100n, 100n, 0n, false)).toBe("paid");
    expect(statusForBalance(100n, 60n, 40n, false)).toBe("paid");
    expect(statusForBalance(100n, 150n, 0n, false)).toBe("overpaid");
  });
});
