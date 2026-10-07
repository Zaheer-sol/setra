/**
 * Setra's matching engine.
 *
 * Pure, deterministic and explainable: given one observed payment and the business context,
 * it decides which invoice (if any) the payment belongs to and records every check it made.
 * It never guesses. When more than one conclusion is plausible, it returns `needs_review`
 * with the candidates so an operator can decide.
 *
 * There is intentionally no scoring. Each rule either identifies a single invoice or it doesn't.
 * Rule order (highest authority first):
 *   1. Asset must be approved for the receiving wallet.
 *   2. A verified payment-intent reference identifies the invoice outright.
 *   3. A known customer wallet narrows candidates to that customer's open invoices.
 *   4. For unknown senders, an exact remaining amount identifies a unique open invoice.
 *   5. Otherwise: an exception, with candidates explained.
 */

export const MATCH_RULE_VERSION = "match-v1.1";

/** Allowance for clock skew between invoice creation and block timestamps. */
const ISSUE_GRACE_MS = 5 * 60 * 1000;
/** How far back a settled invoice counts when checking for duplicate payments. */
const DUPLICATE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export type Outcome = "matched" | "partial" | "overpaid" | "needs_review";
export type ExceptionKind =
  | "unknown_payment"
  | "ambiguous_match"
  | "partial_payment"
  | "overpayment"
  | "duplicate_payment"
  | "late_payment"
  | "wrong_token"
  | "wrong_network";

export interface ObservedPayment {
  chainId: number;
  /** Human network name for explanations ("Monad", "Monad Testnet"). */
  networkName?: string;
  walletId: string;
  walletName: string;
  walletAddress: string;
  /** Registry asset id, or null when the token is not in Setra's registry for this chain. */
  assetId: string | null;
  assetSymbol: string;
  fromAddress: string;
  amount: bigint;
  timestamp: Date;
  /** Present only when the payment came through the Setra Payment Intent contract and the intent was found. */
  paymentIntent?: PaymentIntentRef | null;
}

export interface PaymentIntentRef {
  id: string;
  invoiceId: string;
  walletId: string;
  assetId: string;
  amount: bigint;
}

export interface InvoiceCandidate {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  chainId: number;
  walletId: string;
  walletAddress: string;
  assetId: string;
  amountDue: bigint;
  amountPaid: bigint;
  amountWrittenOff: bigint;
  status: "open" | "partially_paid" | "paid" | "overpaid" | "expired" | "cancelled";
  issuedAt: Date;
  dueAt: Date | null;
  expiresAt: Date | null;
  paidAt?: Date | null;
}

export interface MatchContext {
  /** Asset ids accepted by the receiving wallet. */
  acceptedAssetIds: string[];
  /** Invoices of this organization and environment that are not cancelled (open, partial, expired, recently paid). */
  invoices: InvoiceCandidate[];
  /** The customer that owns the sender address on this chain, if any. */
  knownSender: { customerId: string; customerName: string } | null;
  /** Human decimals for amount formatting in explanations. */
  decimals: number;
}

export interface Check {
  code: string;
  /** true = passed, false = failed, null = informational. */
  passed: boolean | null;
  label: string;
  detail: string;
}

export interface Candidate {
  invoiceId: string;
  number: string;
  customerId: string;
  customerName: string;
  amountRemaining: string;
  reasons: string[];
}

export interface MatchDecision {
  ruleVersion: typeof MATCH_RULE_VERSION;
  outcome: Outcome;
  invoiceId: string | null;
  customerId: string | null;
  exceptionType: ExceptionKind | null;
  checks: Check[];
  candidates: Candidate[];
  explanation: string;
  /** Amount that will be applied to the invoice (whole payment when matched/partial/overpaid). */
  appliedAmount: bigint;
  /** Invoice balance after applying (negative = excess received). */
  remainingAfter: bigint | null;
}

export const remainingOf = (i: InvoiceCandidate) => i.amountDue - i.amountPaid - i.amountWrittenOff;

function fmt(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (abs % base).toString().padStart(decimals, "0").slice(0, 2).padEnd(2, "0");
  return `${negative ? "-" : ""}$${whole}.${fraction}`;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const day = (d: Date) => d.toISOString().slice(0, 10);

function isOpen(i: InvoiceCandidate) {
  return i.status === "open" || i.status === "partially_paid";
}

function isLateFor(i: InvoiceCandidate, at: Date) {
  return i.status === "expired" || (i.expiresAt !== null && at.getTime() > i.expiresAt.getTime());
}

function inWindow(i: InvoiceCandidate, at: Date) {
  return at.getTime() >= i.issuedAt.getTime() - ISSUE_GRACE_MS && !isLateFor(i, at);
}

function byOldest(a: InvoiceCandidate, b: InvoiceCandidate) {
  const ad = (a.dueAt ?? a.issuedAt).getTime();
  const bd = (b.dueAt ?? b.issuedAt).getTime();
  return ad - bd || a.issuedAt.getTime() - b.issuedAt.getTime() || a.id.localeCompare(b.id);
}

export function matchPayment(payment: ObservedPayment, ctx: MatchContext): MatchDecision {
  const d = ctx.decimals;
  const checks: Check[] = [];
  const toCandidate = (i: InvoiceCandidate, reasons: string[]): Candidate => ({
    invoiceId: i.id,
    number: i.number,
    customerId: i.customerId,
    customerName: i.customerName,
    amountRemaining: remainingOf(i).toString(),
    reasons
  });
  const review = (exceptionType: ExceptionKind, explanation: string, candidates: Candidate[] = [], customerId: string | null = null): MatchDecision => ({
    ruleVersion: MATCH_RULE_VERSION,
    outcome: "needs_review",
    invoiceId: null,
    customerId,
    exceptionType,
    checks,
    candidates: candidates.slice(0, 5),
    explanation,
    appliedAmount: 0n,
    remainingAfter: null
  });

  // 1. Network and receiving wallet. Ingestion only observes monitored wallets on their own chain,
  //    so these pass by construction; they are recorded because they are part of the explanation.
  checks.push({ code: "network", passed: true, label: "Supported network", detail: `Observed on ${payment.networkName ?? `chain ${payment.chainId}`}, the network this wallet is monitored on` });
  checks.push({ code: "receiving_wallet", passed: true, label: "Correct receiving wallet", detail: `Sent to ${payment.walletName} (${short(payment.walletAddress)})` });

  // 2. Asset.
  const assetApproved = payment.assetId !== null && ctx.acceptedAssetIds.includes(payment.assetId);
  checks.push({
    code: "asset",
    passed: assetApproved,
    label: assetApproved ? "Approved asset" : "Asset not accepted",
    detail: assetApproved ? `${payment.assetSymbol} is accepted by this wallet` : `${payment.assetSymbol} is not enabled for this wallet, so it cannot settle an invoice`
  });
  if (!assetApproved) {
    return review("wrong_token", `Received ${payment.assetSymbol}, which this wallet does not accept. Unsupported assets never settle invoices automatically.`);
  }

  const sameRail = (i: InvoiceCandidate) => i.walletId === payment.walletId && i.assetId === payment.assetId;

  // 3. Explicit payment intent, the reference is inside the transaction itself.
  if (payment.paymentIntent) {
    const intent = payment.paymentIntent;
    const invoice = ctx.invoices.find((i) => i.id === intent.invoiceId);
    const termsMatch = intent.amount === payment.amount && intent.assetId === payment.assetId && intent.walletId === payment.walletId &&
      !!invoice && invoice.chainId === payment.chainId && invoice.walletId === payment.walletId && invoice.assetId === payment.assetId;
    checks.push({
      code: "payment_intent",
      passed: termsMatch && !!invoice,
      label: "Payment intent reference",
      detail: termsMatch ? "The transaction carries a verified Setra payment-intent reference" : "The payment-intent terms do not match what arrived"
    });
    if (!termsMatch || !invoice) {
      return review("unknown_payment", "The transaction referenced a payment intent, but its terms or invoice could not be verified.");
    }
    if (invoice.status === "paid" || invoice.status === "overpaid") {
      return review("duplicate_payment", `${invoice.number} was already settled when this payment arrived.`, [toCandidate(invoice, ["Payment intent reference", "Invoice already paid"])], invoice.customerId);
    }
    if (invoice.status === "cancelled") {
      return review("late_payment", `${invoice.number} was cancelled before this payment arrived.`, [toCandidate(invoice, ["Payment intent reference", "Invoice cancelled"])], invoice.customerId);
    }
    if (isLateFor(invoice, payment.timestamp)) {
      checks.push({ code: "window", passed: false, label: "Outside payment window", detail: `${invoice.number} had expired when the payment arrived` });
      return review("late_payment", `${invoice.number} had expired before this payment arrived.`, [toCandidate(invoice, ["Payment intent reference", "Invoice expired"])], invoice.customerId);
    }
    if (!inWindow(invoice, payment.timestamp)) {
      checks.push({ code: "window", passed: false, label: "Outside payment window", detail: `${invoice.number} had not been issued when the payment arrived` });
      return review("unknown_payment", `${invoice.number} had not been issued when this payment arrived.`, [toCandidate(invoice, ["Payment intent reference", "Payment predates invoice"])], invoice.customerId);
    }
    return apply(invoice, "Referenced by a verified payment intent");
  }

  // 4. Known customer wallet.
  const eligible = ctx.invoices.filter((i) => sameRail(i) && isOpen(i) && inWindow(i, payment.timestamp));
  if (ctx.knownSender) {
    const sender = ctx.knownSender;
    checks.push({ code: "sender", passed: true, label: "Known customer wallet", detail: `${short(payment.fromAddress)} belongs to ${sender.customerName}` });
    const mine = eligible.filter((i) => i.customerId === sender.customerId).sort(byOldest);
    if (mine.length === 1) return apply(mine[0]!, `Only open invoice for ${sender.customerName}`);
    if (mine.length > 1) {
      const exact = mine.filter((i) => remainingOf(i) === payment.amount);
      if (exact.length === 1) {
        return apply(exact[0]!, `Only open ${sender.customerName} invoice with this exact amount`);
      }
      if (exact.length > 1) {
        checks.push({ code: "uniqueness", passed: false, label: "More than one candidate", detail: `${exact.length} open ${sender.customerName} invoices are due exactly ${fmt(payment.amount, d)}` });
        return review(
          "ambiguous_match",
          `${exact.length} open invoices for ${sender.customerName} have the same remaining amount. The sender and amount do not identify which one was paid.`,
          exact.map((i) => toCandidate(i, ["Known customer wallet", "Exact amount", "Within payment window"])),
          sender.customerId
        );
      }
      checks.push({ code: "uniqueness", passed: false, label: "More than one candidate", detail: `${sender.customerName} has ${mine.length} open invoices and none match ${fmt(payment.amount, d)} exactly` });
      return review(
        "ambiguous_match",
        `${sender.customerName} has ${mine.length} open invoices and this amount doesn't identify one of them.`,
        mine.map((i) => toCandidate(i, ["Known customer wallet", `Remaining ${fmt(remainingOf(i), d)}`])),
        sender.customerId
      );
    }
    // Known sender, no open invoice for them.
    const lateAll = ctx.invoices.filter(
      (i) => sameRail(i) && i.customerId === sender.customerId && (i.status === "expired" || i.status === "cancelled" || (isOpen(i) && isLateFor(i, payment.timestamp)))
    );
    if (lateAll.length) {
      const cancelledOnly = lateAll.every((i) => i.status === "cancelled");
      return review(
        "late_payment",
        cancelledOnly ? `${sender.customerName} paid an invoice that had been cancelled.` : `${sender.customerName} paid after their invoice expired.`,
        lateAll.map((i) => toCandidate(i, ["Known customer wallet", closedReason(i)])),
        sender.customerId
      );
    }
    const settled = recentlySettled(ctx.invoices, payment, sameRail).filter((i) => i.customerId === sender.customerId);
    if (settled.length) {
      return review("duplicate_payment", `${sender.customerName} has no open invoice. This may be a duplicate of a payment already received.`, settled.map((i) => toCandidate(i, ["Known customer wallet", "Already paid", ...(i.amountDue === payment.amount ? ["Same amount"] : [])])), sender.customerId);
    }
    const exactOthers = eligible.filter((i) => remainingOf(i) === payment.amount);
    return review(
      exactOthers.length ? "ambiguous_match" : "unknown_payment",
      exactOthers.length
        ? `The sender belongs to ${sender.customerName}, but the only exact-amount invoice belongs to another customer.`
        : `${sender.customerName} has no open invoice on this wallet.`,
      exactOthers.map((i) => toCandidate(i, ["Exact amount", "Different customer"])),
      sender.customerId
    );
  }

  checks.push({ code: "sender", passed: null, label: "Sender not on file", detail: `${short(payment.fromAddress)} is not linked to a customer yet` });

  // 5. Unknown sender: only an exact, unique remaining amount is deterministic.
  const exact = eligible.filter((i) => remainingOf(i) === payment.amount);
  if (exact.length === 1) return apply(exact[0]!, "Only open invoice with this exact amount");
  if (exact.length > 1) {
    checks.push({ code: "uniqueness", passed: false, label: "More than one candidate", detail: `${exact.length} open invoices are due exactly ${fmt(payment.amount, d)}` });
    return review("ambiguous_match", `${exact.length} open invoices match this amount exactly, so Setra won't pick one.`, exact.sort(byOldest).map((i) => toCandidate(i, ["Exact amount", "Within payment window"])));
  }

  const lateExact = ctx.invoices.filter(
    (i) => sameRail(i) && (i.status === "expired" || i.status === "cancelled" || (isOpen(i) && isLateFor(i, payment.timestamp))) && remainingOf(i) === payment.amount
  );
  if (lateExact.length) {
    const cancelledOnly = lateExact.every((i) => i.status === "cancelled");
    return review(
      "late_payment",
      cancelledOnly ? "The amount matches an invoice that was cancelled. Cancelled invoices never accept payment automatically." : "The amount matches an invoice that had already expired.",
      lateExact.map((i) => toCandidate(i, ["Exact amount", closedReason(i)]))
    );
  }

  const otherNetwork = ctx.invoices.filter(
    (i) => isOpen(i) && i.chainId !== payment.chainId && i.walletAddress === payment.walletAddress && remainingOf(i) === payment.amount
  );
  if (otherNetwork.length) {
    return review("wrong_network", "The amount matches an invoice that expects payment on a different network.", otherNetwork.map((i) => toCandidate(i, ["Exact amount", "Invoice expects another network"])));
  }

  // Suggestions for the operator, ranked: amounts that fit inside a remaining balance, then paid duplicates.
  const partialFits = eligible
    .filter((i) => payment.amount < remainingOf(i))
    .sort((a, b) => (remainingOf(a) - payment.amount < remainingOf(b) - payment.amount ? -1 : 1))
    .map((i) => toCandidate(i, [`Could be a partial payment of ${fmt(remainingOf(i), d)}`, "Within payment window"]));
  const dupes = recentlySettled(ctx.invoices, payment, sameRail)
    .filter((i) => i.amountDue === payment.amount)
    .map((i) => toCandidate(i, ["Same amount as an invoice already paid"]));
  checks.push({ code: "uniqueness", passed: false, label: "No deterministic match", detail: "No open invoice is identified by a reference, a known wallet or an exact amount" });
  return review("unknown_payment", "Setra received this payment but couldn't safely tell which customer or invoice it belongs to.", [...partialFits, ...dupes]);

  function apply(invoice: InvoiceCandidate, why: string): MatchDecision {
    const remaining = remainingOf(invoice);
    const after = remaining - payment.amount;
    const outcome: Outcome = after === 0n ? "matched" : after > 0n ? "partial" : "overpaid";
    checks.push({
      code: "amount",
      passed: outcome === "matched" ? true : null,
      label: outcome === "matched" ? "Exact amount" : outcome === "partial" ? "Partial amount" : "More than the amount due",
      detail:
        outcome === "matched"
          ? `${fmt(payment.amount, d)} equals the ${fmt(remaining, d)} due`
          : outcome === "partial"
            ? `${fmt(payment.amount, d)} of ${fmt(remaining, d)} due, ${fmt(after, d)} remaining`
            : `${fmt(payment.amount, d)} received for ${fmt(remaining, d)} due, ${fmt(-after, d)} extra`
    });
    const windowOk = inWindow(invoice, payment.timestamp);
    checks.push({
      code: "window",
      passed: windowOk,
      label: windowOk ? "Valid payment window" : "Outside payment window",
      detail: invoice.expiresAt ? `Issued ${day(invoice.issuedAt)}, payable until ${day(invoice.expiresAt)}` : `Issued ${day(invoice.issuedAt)}, no expiry`
    });
    checks.push({ code: "uniqueness", passed: true, label: "One deterministic candidate", detail: why });
    return {
      ruleVersion: MATCH_RULE_VERSION,
      outcome,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      exceptionType: outcome === "partial" ? "partial_payment" : outcome === "overpaid" ? "overpayment" : null,
      checks,
      candidates: [toCandidate(invoice, [why])],
      explanation:
        outcome === "matched"
          ? `Matched to ${invoice.number} for ${invoice.customerName}. ${why}.`
          : outcome === "partial"
            ? `Applied to ${invoice.number} for ${invoice.customerName}; ${fmt(after, d)} is still due.`
            : `Applied to ${invoice.number} for ${invoice.customerName}; ${fmt(-after, d)} more than was due.`,
      appliedAmount: payment.amount,
      remainingAfter: after
    };
  }
}

function closedReason(i: InvoiceCandidate): string {
  if (i.status === "cancelled") return "Invoice cancelled";
  return i.expiresAt ? `Expired ${day(i.expiresAt)}` : "Expired";
}

function recentlySettled(invoices: InvoiceCandidate[], payment: ObservedPayment, sameRail: (i: InvoiceCandidate) => boolean) {
  return invoices.filter(
    (i) =>
      sameRail(i) &&
      (i.status === "paid" || i.status === "overpaid") &&
      (!i.paidAt || payment.timestamp.getTime() - i.paidAt.getTime() < DUPLICATE_LOOKBACK_MS)
  );
}

/** Invoice status implied by its balance. Terminal states (cancelled) are handled by callers. */
export function statusForBalance(amountDue: bigint, amountPaid: bigint, amountWrittenOff: bigint, expired: boolean): "open" | "partially_paid" | "paid" | "overpaid" | "expired" {
  if (amountPaid > amountDue) return "overpaid";
  if (amountPaid + amountWrittenOff >= amountDue) return "paid";
  if (amountPaid > 0n) return "partially_paid";
  return expired ? "expired" : "open";
}
