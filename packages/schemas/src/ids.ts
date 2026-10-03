/**
 * Public identifiers are prefixed, time-ordered and opaque: `inv_01J9Z3...`.
 * The body is a ULID (48-bit millisecond timestamp + 80 random bits, Crockford base32),
 * so ids sort by creation time and work as stable pagination cursors.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ID_PREFIXES = {
  organization: "org",
  user: "usr",
  session: "ses",
  member: "mem",
  invitation: "invt",
  apiKey: "key",
  wallet: "wal",
  customer: "cus",
  customerAddress: "addr",
  invoice: "inv",
  lineItem: "li",
  paymentIntent: "pi",
  observation: "obs",
  payment: "pay",
  allocation: "alloc",
  matchDecision: "mdec",
  financialEvent: "fevt",
  exception: "exc",
  resolution: "res",
  correction: "corr",
  outgoingTransfer: "out",
  refund: "rfd",
  assistantConversation: "conv",
  assistantMessage: "amsg",
  assistantAction: "act",
  ledgerAccount: "acct",
  accountingPeriod: "per",
  journalEntry: "je",
  journalLine: "jl",
  vendor: "ven",
  vendorAddress: "vaddr",
  bill: "bill",
  billPayment: "bpay",
  expense: "exp",
  classification: "cls",
  accountingIssue: "aiss",
  fxRate: "fx",
  networkFee: "nfee",
  bankImport: "bimp",
  bankLine: "bline",
  bankReconciliation: "brec",
  creditApplication: "capp",
  creditNote: "cn",
  attachment: "att",
  recurringBill: "rbill",
  booksAttestation: "batt",
  webhookEndpoint: "we",
  orderSource: "osrc",
  orderSourceEvent: "osev",
  webhookDelivery: "whd",
  webhookAttempt: "wha",
  auditLog: "aud",
  request: "req",
  backfill: "bf",
  passwordReset: "pwr"
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let random = "";
  for (let i = 0; i < 16; i++) random += ALPHABET[bytes[i]! % 32];
  return time + random;
}

export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

export function hasPrefix(value: string, kind: IdKind): boolean {
  return new RegExp(`^${ID_PREFIXES[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`).test(value);
}
