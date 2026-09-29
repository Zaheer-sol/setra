/**
 * Setra Assistant: plain language → a typed intent.
 *
 * Deterministic on purpose. The parser only recognizes what a merchant asks about payments and
 * payment requests and extracts fields (amount, customer, purpose, due date, period, references). It
 * never executes anything: the intent goes to the orchestrator, which resolves names against the
 * workspace's real data, asks for anything missing, and requires an explicit confirmation before any
 * action that creates or changes a financial record. Text inside a message (or inside a customer's
 * name or a purpose) cannot instruct the assistant to do anything else.
 */

export type Period = "today" | "yesterday" | "week" | "month";

export type DueSpec =
  | { type: "today" }
  | { type: "tomorrow" }
  | { type: "in_days"; days: number }
  | { type: "weekday"; day: number } // 0 = Sunday
  | { type: "date"; year?: number; month: number; day: number };

export type ReviewFilter = "all" | "wrong_amount" | "unknown" | "duplicate";

/** Accounting periods for financial questions (calendar periods in the merchant's time zone). */
export type FinPeriod = "month" | "last_month" | "quarter" | "year" | "last_year";

export type Intent =
  | { kind: "create_request"; amount?: string; asset?: string; customer?: string; purpose?: string; due?: DueSpec; loose?: string }
  | { kind: "payment_status"; customer?: string; invoice?: string }
  | { kind: "summary"; period: Period; customer?: string; asset?: string }
  | { kind: "outstanding"; customer?: string }
  | { kind: "overdue" }
  | { kind: "review"; filter: ReviewFilter }
  | { kind: "latest" }
  | { kind: "history"; customer: string }
  | { kind: "find"; query: string }
  | { kind: "accounting"; customer?: string; invoice?: string; payment?: string; tx?: string }
  | { kind: "correction"; customer?: string; payment?: string; target: string }
  | { kind: "fin_pl"; period: FinPeriod; focus: "profit" | "revenue" | "expenses" }
  | { kind: "fin_compare"; period: FinPeriod }
  | { kind: "fin_spend"; category: string; period: FinPeriod }
  | { kind: "fin_cash" }
  | { kind: "fin_payables" }
  | { kind: "fin_health" }
  | { kind: "fin_unclassified" }
  | { kind: "record_expense"; amount?: string; title?: string; vendor?: string; paidFrom?: "bank" | "owner" }
  | { kind: "close_period"; month?: number; year?: number; last?: boolean }
  | { kind: "record_bill"; amount?: string; vendor?: string; title?: string; number?: string; due?: DueSpec }
  | { kind: "help" }
  | { kind: "unknown" };

export const MAX_MESSAGE = 2000;

const INVOICE_RE = /\b(inv-\d{1,9})\b/i;
const PAYMENT_RE = /\b(pay_[0-9a-z]{20,32})\b/i;
const TX_RE = /\b(0x[0-9a-f]{64})\b/i;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Amount with an explicit money marker ($, USDC, USDT0, USD, dollars). Bare numbers are never amounts. */
const AMOUNT_RE = /(\$\s?)?\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,6}))?(\s?k)?\b\s*(usdc|usdt0|usdt|usd|dollars?)?/gi;

const DUE_RE =
  /\b(?:due|payable|by)\s+(?:on\s+|by\s+)?(today|tomorrow|next week|in\s+(\d{1,3})\s+days?|(sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?|(\d{4})-(\d{2})-(\d{2})|([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?|(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})(?:\s+(\d{4}))?)\b/i;

export function normalizeAmount(whole: string, fraction: string | undefined, thousands: boolean): string | null {
  const digits = whole.replace(/,/g, "");
  let units = BigInt(digits) * 1_000_000n + BigInt((fraction ?? "").padEnd(6, "0") || "0");
  if (thousands) units *= 1000n;
  if (units <= 0n) return null;
  const w = units / 1_000_000n;
  const f = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return f ? `${w}.${f.padEnd(2, "0")}` : `${w}.00`;
}

export function findAmount(text: string): { amount: string; asset?: string; span: [number, number] } | null {
  for (const m of text.matchAll(AMOUNT_RE)) {
    const dollar = Boolean(m[1]);
    const unit = m[5]?.toLowerCase();
    if (!dollar && !unit) continue; // "INV-2061", "due 30", "3 invoices" are not amounts
    const amount = normalizeAmount(m[2]!, m[3], Boolean(m[4]));
    if (!amount) continue;
    const asset = unit === "usdc" ? "USDC" : unit === "usdt0" || unit === "usdt" ? "USDT0" : undefined;
    return { amount, asset, span: [m.index!, m.index! + m[0].length] };
  }
  return null;
}

function parseDue(text: string): { due: DueSpec; span: [number, number] } | null {
  const m = DUE_RE.exec(text);
  if (!m) return null;
  const span: [number, number] = [m.index, m.index + m[0].length];
  const word = m[1]!.toLowerCase();
  if (word === "today") return { due: { type: "today" }, span };
  if (word === "tomorrow") return { due: { type: "tomorrow" }, span };
  if (word === "next week") return { due: { type: "in_days", days: 7 }, span };
  if (m[2]) return { due: { type: "in_days", days: Math.min(Number(m[2]), 365) }, span };
  if (m[3]) return { due: { type: "weekday", day: WEEKDAYS.indexOf(m[3].toLowerCase().slice(0, 3)) }, span };
  if (m[4]) return { due: { type: "date", year: Number(m[4]), month: Number(m[5]), day: Number(m[6]) }, span };
  const monthIndex = (s: string | undefined) => (s ? MONTHS.indexOf(s.toLowerCase().slice(0, 3)) : -1);
  if (m[7] && monthIndex(m[7]) >= 0) return { due: { type: "date", month: monthIndex(m[7]) + 1, day: Number(m[8]), year: m[9] ? Number(m[9]) : undefined }, span };
  if (m[10] && monthIndex(m[11]) >= 0) return { due: { type: "date", month: monthIndex(m[11]) + 1, day: Number(m[10]), year: m[12] ? Number(m[12]) : undefined }, span };
  return null;
}

const cut = (text: string, span: [number, number] | undefined) => (span ? `${text.slice(0, span[0])} ${text.slice(span[1])}` : text);

/** Tidy a name or purpose extracted from free text. */
export function clean(value: string | undefined, max = 140): string | undefined {
  if (!value) return undefined;
  const v = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;'"-]+|[\s,.:;!?'"-]+$/g, "")
    .replace(/^(the|a|an)\s+/i, "")
    .trim();
  if (!v) return undefined;
  return v.length > max ? v.slice(0, max).trim() : v;
}

const stripPossessive = (s: string | undefined) => s?.replace(/['’]s\b/i, "").trim();

/** "website development" → "Website Development"; text the merchant already capitalized is kept. */
export function titleCase(s: string): string {
  // Only plain lowercase words; anything the merchant capitalized or that isn't prose is kept verbatim.
  if (/[A-Z]/.test(s) || /[^\p{L}\p{N}\s,.'’&-]/u.test(s)) return s;
  const small = new Set(["and", "or", "for", "of", "the", "a", "an", "to", "in", "on", "at", "by", "with"]);
  return s
    .split(" ")
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

const CREATE_VERB = /\b(create|make|generate|send|raise|issue|new|draft|prepare|set up|bill|charge|request)\b/i;
const CREATE_OBJECT = /\b(payment request|payment link|pay link|request|invoice|link|bill)\b/i;

function parseCreate(original: string): Intent {
  const amount = findAmount(original);
  let rest = cut(original, amount?.span);
  const due = parseDue(rest);
  rest = cut(rest, due?.span);
  rest = rest.replace(/\b(in|on|using|via|with)\s+(usdc|usdt0|usdt)\b/gi, " ").replace(/\b(on|via)\s+monad\b/gi, " ");

  // "Send Sarah a $500 payment request for …" / "Bill Acme for …" / "… request to John for …"
  const direct = /^\s*(?:please\s+)?(?:send|bill|charge|invoice)\s+([A-Za-z][\w&.'’ -]{0,60}?)\s+(?:a|an|for)\b/i.exec(rest);
  const to = /\b(?:to|from)\s+([A-Za-z][\w&.'’ -]{0,60}?)\s+(?:for|due)\b/i.exec(rest);
  const segments = rest
    .split(/\bfor\b/i)
    .slice(1)
    .map((s) => clean(s))
    .filter((s): s is string => Boolean(s));

  let customer = clean(stripPossessive(direct?.[1] ?? to?.[1]), 80);
  let purpose: string | undefined;
  let loose: string | undefined;
  if (customer) {
    purpose = segments.filter((s) => s.toLowerCase() !== customer!.toLowerCase()).join(" for ") || undefined;
  } else if (segments.length >= 2) {
    customer = clean(stripPossessive(segments[0]), 80);
    purpose = segments.slice(1).join(" for ");
  } else if (segments.length === 1) {
    // "Create a payment request for Acme" or "… for website development": the orchestrator checks
    // whether this names a customer before treating it as the purpose.
    loose = segments[0];
  }
  return {
    kind: "create_request",
    amount: amount?.amount,
    asset: amount?.asset ?? (/\busdt0?\b/i.test(original) ? "USDT0" : /\busdc\b/i.test(original) ? "USDC" : undefined),
    customer,
    purpose: purpose ? titleCase(clean(purpose)!) : undefined,
    due: due?.due,
    loose
  };
}

function period(t: string): Period | null {
  if (/\btoday\b|\bthis morning\b/.test(t)) return "today";
  if (/\byesterday\b/.test(t)) return "yesterday";
  if (/\b(this|past|last)\s+week\b|\bweekly\b/.test(t)) return "week";
  if (/\b(this|past|last)\s+month\b|\bmonthly\b/.test(t)) return "month";
  return null;
}

/** "Did John pay?" / "Has Acme Ltd paid INV-2061?" → "John" / "Acme Ltd". */
function subjectBetween(t: string, before: RegExp, after: RegExp): string | undefined {
  const m = new RegExp(`${before.source}\\s+(.+?)\\s+${after.source}`, "i").exec(t);
  return clean(stripPossessive(m?.[1]), 80);
}

export function parseIntent(input: string): Intent {
  const original = input.slice(0, MAX_MESSAGE).replace(/\s+/g, " ").trim();
  const t = original.toLowerCase();
  if (!t) return { kind: "unknown" };
  const invoice = INVOICE_RE.exec(original)?.[1]?.toUpperCase();
  const payment = PAYMENT_RE.exec(original)?.[1];
  const tx = TX_RE.exec(original)?.[1]?.toLowerCase();

  if (/^\/?(help|\?)$|^(what can you do|how does this work|what do you do)\b|^(hi|hello|hey)\b[\s!.?]*$/.test(t)) return { kind: "help" };

  // Corrections: "The payment from John is actually for the website project" / "Move John's payment to INV-2051"
  if (/\b(actually|should (?:have been|be)|was meant for|belongs to|reassign|move)\b/.test(t) && /\bpayment\b/.test(t)) {
    const target = /\b(?:actually\s+for|meant\s+for|should\s+(?:have\s+been|be)\s+(?:for|applied to)|belongs\s+to|to)\s+(?:the\s+)?(.+?)[.!?]*$/i.exec(original)?.[1];
    const customer = /\bpayment\s+from\s+(.+?)\s+(?:is|was|should|belongs|to)\b/i.exec(original)?.[1] ?? /\b(?:move|reassign)\s+(.+?)['’]s\s+payment\b/i.exec(original)?.[1];
    if (target) return { kind: "correction", customer: clean(customer, 80), payment, target: clean(target)! };
  }

  const fin = parseFinancial(original, t);
  if (fin) return fin;

  if (/\baccounting\b|\baccounting-ready\b|\b(record|details|evidence|proof)\s+(for|of)\b/.test(t)) {
    const who = /\b(?:for|of)\s+(.+?)['’]s\s+payment\b/i.exec(original)?.[1] ?? /\b(?:for|of)\s+(?:the\s+)?payment\s+from\s+(.+?)[.!?]*$/i.exec(original)?.[1];
    return { kind: "accounting", customer: clean(who, 80), invoice, payment, tx };
  }

  if (CREATE_VERB.test(t) && CREATE_OBJECT.test(t) && !/\b(show|list|which|what|how many|any)\b/.test(t)) return parseCreate(original);

  if (/\bwrong amount|underpa(?:id|y)|overpa(?:id|y)|short ?paid|partial(?:ly)? paid\b/.test(t)) return { kind: "review", filter: "wrong_amount" };
  if (/\bduplicates?\b|\bpaid twice\b/.test(t)) return { kind: "review", filter: "duplicate" };
  if (/\b(unknown|unidentified|unmatched)\b/.test(t)) return { kind: "review", filter: "unknown" };
  if (/\b(review|exceptions?|needs? attention|flagged|problems?|issues?)\b/.test(t)) return { kind: "review", filter: "all" };

  if (!/\bhow much\b/.test(t) && /\b(did|has|have)\b.+\b(pay|paid)\b|\bpayment status\b|\bstatus of\b|\bis\s+.+\s+paid\b/.test(t)) {
    if (/\b(anyone|anybody|someone)\b/.test(t)) return { kind: "summary", period: period(t) ?? "today" };
    const customer = subjectBetween(original, /\b(?:did|has|have)/, /(?:already\s+)?(?:pay|paid)\b/) ?? /\bstatus of\s+(.+?)['’]?s?\s*(?:payment|invoice)?[.?!]*$/i.exec(original)?.[1];
    return { kind: "payment_status", customer: invoice ? undefined : clean(customer, 80), invoice };
  }

  if (/\boverdue\b|\bpast due\b|\blate invoices\b/.test(t)) return { kind: "overdue" };
  if (/\b(outstanding|unpaid|owed|owes|owe us|still open|open invoices|not (?:yet )?paid|pending invoices|receivables)\b/.test(t)) {
    const who = /\b(?:does|do)\s+(.+?)\s+owe\b/i.exec(original)?.[1] ?? /\b(?:from|for)\s+([A-Z][\w&.'’ -]{0,60})\b/.exec(original)?.[1];
    return { kind: "outstanding", customer: clean(who, 80) };
  }

  if (/\b(latest|last|most recent|newest)\b.*\bpayment\b/.test(t)) return { kind: "latest" };

  if (/\bhistory\b|\bpayments? from\b|\b(?:what|how much) (?:has|have) .+ paid\b/.test(t) && !period(t)) {
    const who = /\b(?:show|see|view)?\s*(.+?)['’]s\s+(?:payment\s+)?history\b/i.exec(original)?.[1] ?? /\bpayments?\s+from\s+(.+?)[.?!]*$/i.exec(original)?.[1] ?? /\bhistory\s+(?:for|of)\s+(.+?)[.?!]*$/i.exec(original)?.[1];
    const customer = clean(who?.replace(/^(show|see|view|me)\s+/i, ""), 80);
    if (customer) return { kind: "history", customer };
  }

  const p = period(t);
  if (p || /\bhow much\b.*\b(receive|received|collect|collected|paid|pay|made)\b|\bwhat did we (?:receive|get|collect)\b/.test(t)) {
    const customer = subjectBetween(original, /\bhow much (?:did|has)/, /(?:pay|paid)\b/);
    const asset = /\busdc\b/i.test(original) ? "USDC" : /\busdt0?\b/i.test(original) ? "USDT0" : undefined;
    return { kind: "summary", period: p ?? "month", customer, asset };
  }

  if (/\b(find|search|look ?up|where is|which payment)\b/.test(t)) {
    const q = /\b(?:payment|invoice)s?\s+(?:for|about|from)\s+(.+?)[.?!]*$/i.exec(original)?.[1] ?? /\b(?:find|search(?: for)?|look ?up)\s+(.+?)[.?!]*$/i.exec(original)?.[1];
    const query = clean(q?.replace(/^(the|a)\s+/i, ""), 120);
    if (query) return { kind: "find", query };
  }

  if (/^\/?(payments|today)$/.test(t)) return { kind: "summary", period: "today" };
  if (/^\/?(unpaid|invoices|outstanding)$/.test(t)) return { kind: "outstanding" };
  if (/^\/?exceptions$/.test(t)) return { kind: "review", filter: "all" };
  if (invoice || payment || tx) return { kind: "accounting", invoice, payment, tx };
  return { kind: "unknown" };
}

// ── financial questions and records ─────────────────────────────────────────────────────────────

export function finPeriod(t: string): FinPeriod | null {
  if (/\blast month\b|\bprevious month\b/.test(t)) return "last_month";
  if (/\blast year\b|\bprevious year\b/.test(t)) return "last_year";
  if (/\b(this|current) quarter\b|\bquarter to date\b|\bqtd\b/.test(t)) return "quarter";
  if (/\b(this|current) year\b|\byear to date\b|\bytd\b|\bso far this year\b/.test(t)) return "year";
  if (/\b(this|current) month\b|\bmonth to date\b|\bmtd\b/.test(t)) return "month";
  return null;
}

const RECORD_VERB = /\b(record|log|add|enter|create|book|capture|note)\b/;

function parseFinancial(original: string, t: string): Intent | null {
  // Creating records: vendor bills and expenses. "Bill Acme $500" stays a payment request.
  const billFrom = /\bbill\s+(?:from|by)\s+(.+?)(?=\s+(?:for|of|due|#|no\.?|number|\$|\d)|[.!?]*$)/i.exec(original)?.[1];
  if (billFrom || (RECORD_VERB.test(t) && /\b(vendor bill|supplier bill|bill|invoice)\s+(?:from|by)\b/.test(t)) || /\b(we got|we received|received)\s+(?:a|an)\s+(?:bill|invoice)\s+from\b/.test(t)) {
    const found = findAmount(original);
    const vendor = billFrom ?? /\b(?:bill|invoice)\s+from\s+(.+?)(?=\s+(?:for|of|due|#|\$|\d)|[.!?]*$)/i.exec(original)?.[1];
    const due = parseDue(original)?.due;
    const number = /(?:#\s*|\bno\.\s*|\bnumber\s+)([A-Za-z0-9][A-Za-z0-9._/-]{0,30})/i.exec(original)?.[1];
    const title = /\bfor\s+(?!\$|\d)(.+?)(?=\s+(?:due|payable|by)\b|[.!?]*$)/i.exec(original)?.[1];
    return { kind: "record_bill", amount: found?.amount, vendor: clean(vendor, 80), title: clean(title), number, due };
  }
  const paymentRequest = /\b(payment request|payment link|pay link|request)\b/.test(t);
  if (RECORD_VERB.test(t) && /\b(expenses?|spend|spent|purchase|cost)\b/.test(t) && !paymentRequest && !/\b(show|list|how much|what|which)\b/.test(t)) {
    const found = findAmount(original);
    const paidFrom = /\b(bank|card|wire)\b/.test(t) ? "bank" : /\b(personally|out of pocket|owner paid|i paid|my own)\b/.test(t) ? "owner" : undefined;
    const vendor = /\b(?:to|from|at)\s+([A-Z][\w&.'’ -]{0,60}?)(?=\s+(?:for|paid|from|on|via|using)\b|[.!?]*$)/.exec(original)?.[1];
    const title = /\bfor\s+(?!\$|\d)(.+?)(?=\s+(?:paid|from|via|using|to|at)\b|[.!?]*$)/i.exec(original)?.[1] ?? /\bexpense\s+(?:of\s+)?(?:\$?[\d.,]+\s*(?:usdc|usd|dollars)?\s+)?(?:on|for)\s+(.+?)[.!?]*$/i.exec(original)?.[1];
    return { kind: "record_expense", amount: found?.amount, title: clean(title), vendor: clean(vendor, 80), paidFrom };
  }

  const close = /\bclose\s+(?:out\s+)?(?:the\s+)?(?:books\s+(?:for\s+)?)?(?:(last month)|([a-z]{3,9})(?:\s+(\d{4}))?)\b/i.exec(original);
  const monthWord = (close?.[2] ?? "").toLowerCase();
  const isMonth = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)$/.test(monthWord);
  if (close && (close[1] || isMonth)) {
    if (close[1]) return { kind: "close_period", last: true };
    return { kind: "close_period", month: MONTHS.indexOf(close[2]!.slice(0, 3).toLowerCase()) + 1, year: close[3] ? Number(close[3]) : undefined };
  }

  // Anything that asks to create a payment request is a payment request, whatever its purpose says.
  if (CREATE_VERB.test(t) && CREATE_OBJECT.test(t) && !/\b(show|list|which|what|how many|how much|any)\b/.test(t)) return null;
  // "…than last month" names what to compare against, not the period asked about.
  const against = /\b(?:than|from|vs\.?|versus|compared (?:to|with))\s+(?:the\s+)?(?:last|previous|prior)\s+(month|quarter|year)\b/.exec(t)?.[1];
  const p = against ? ({ month: "month", quarter: "quarter", year: "year" } as const)[against as "month"] : finPeriod(t);
  if (/\bwhy\b.*\b(profit|revenue|income|expenses?|spending|costs?|margin|earnings)\b|\bcompare(?:d)?\b.*\b(month|year|quarter|last)\b|\b(profit|revenue|expenses?|income)\b.*\b(vs\.?|versus|compared (?:to|with))\b|\bwhat changed\b/.test(t)) return { kind: "fin_compare", period: p ?? "month" };
  if (/\b(are|is)\s+(?:the|my|our)\s+books\b|\bbooks?\s+(?:ok|okay|balanced?|right|correct|healthy|clean|in order)\b|\breconcil(?:e|ed|iation)\b.*\b(books|ledger|accounts?)\b|\btrial balance\b|\bdo (?:the )?books (?:balance|agree)\b/.test(t)) return { kind: "fin_health" };
  if (/\b(unclassified|to classify|needs? classif\w*|uncategori[sz]ed)\b/.test(t)) return { kind: "fin_unclassified" };
  if (/\b(what|how much) do we owe\b|\bwho do we owe\b|\b(unpaid|open|outstanding|upcoming|due|overdue) bills\b|\bbills? (?:due|to pay|coming up)\b|\bpayables?\b|\bowe (?:to )?vendors?\b/.test(t)) return { kind: "fin_payables" };
  if (/\bhow much (?:cash|money) do we have\b|\bcash (?:balance|position|on hand)\b|\b(what'?s|what is) (?:our|my|the) (?:cash|balance)\b|\bbalance sheet\b|\bin the bank\b|\brunway\b|\bhow much (?:is|do we have) in (?:the |our )?wallets?\b/.test(t)) return { kind: "fin_cash" };
  const spendOn = /\b(?:spend|spent|spending|expenses?|costs?)\s+(?:on|for)\s+(.+?)(?=\s+(?:this|last|in|so far|year|month|quarter)\b|[.?!]*$)/i.exec(original)?.[1];
  if (spendOn && /\b(how much|what|show|total)\b/.test(t)) return { kind: "fin_spend", category: clean(spendOn, 60)!, period: p ?? "month" };
  if (/\b(profit|p&l|p ?and ?l|profit and loss|income statement|net income|bottom line|margin|losing money|making money|earnings)\b|\bhow much did we (?:make|earn)\b|\bhow (?:are|is) (?:we|the business) doing\b/.test(t)) return { kind: "fin_pl", period: p ?? "month", focus: "profit" };
  if (/\brevenue\b|\b(sales|income) (?:this|last)\b/.test(t)) return { kind: "fin_pl", period: p ?? "month", focus: "revenue" };
  if (/\b(expenses|spending|costs|burn|how much did we spend|what did we spend)\b/.test(t)) return { kind: "fin_pl", period: p ?? "month", focus: "expenses" };
  return null;
}

/** Calendar bounds (YYYY-MM-DD) for a financial period, in the merchant's time zone. */
export function finRange(p: FinPeriod, now: Date, tz: string): { from: string; to: string; label: string; previous: { from: string; to: string; label: string } } {
  const d = localDate(now, tz);
  const iso = (y: number, m: number, day: number) => {
    const dt = new Date(Date.UTC(y, m - 1, day));
    return dt.toISOString().slice(0, 10);
  };
  const today = iso(d.year, d.month, d.day);
  const monthName = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  switch (p) {
    case "last_month": {
      const y = d.month === 1 ? d.year - 1 : d.year;
      const m = d.month === 1 ? 12 : d.month - 1;
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: iso(y, m, 1), to: iso(y, m + 1, 0), label: monthName(y, m), previous: { from: iso(py, pm, 1), to: iso(py, pm + 1, 0), label: monthName(py, pm) } };
    }
    case "quarter": {
      const q = Math.floor((d.month - 1) / 3) * 3 + 1;
      const pq = q === 1 ? 10 : q - 3;
      const py = q === 1 ? d.year - 1 : d.year;
      return { from: iso(d.year, q, 1), to: today, label: "This quarter", previous: { from: iso(py, pq, 1), to: iso(py, pq + 3, 0), label: "Last quarter" } };
    }
    case "year":
      return { from: iso(d.year, 1, 1), to: today, label: `${d.year} so far`, previous: { from: iso(d.year - 1, 1, 1), to: iso(d.year - 1, d.month, d.day), label: `Same period ${d.year - 1}` } };
    case "last_year":
      return { from: iso(d.year - 1, 1, 1), to: iso(d.year - 1, 12, 31), label: String(d.year - 1), previous: { from: iso(d.year - 2, 1, 1), to: iso(d.year - 2, 12, 31), label: String(d.year - 2) } };
    default: {
      const py = d.month === 1 ? d.year - 1 : d.year;
      const pm = d.month === 1 ? 12 : d.month - 1;
      const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
      return { from: iso(d.year, d.month, 1), to: today, label: "This month", previous: { from: iso(py, pm, 1), to: iso(py, pm, Math.min(d.day, lastDay)), label: "Same days last month" } };
    }
  }
}

// ── dates in the merchant's time zone ────────────────────────────────────────────────────────────

/** Offset of `tz` from UTC at `at`, in minutes (e.g. +60 for Africa/Lagos). */
export function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Calendar date (y, m, d) of `at` in `tz`. */
export function localDate(at: Date, tz: string): { year: number; month: number; day: number; weekday: number } {
  const offset = tzOffsetMinutes(at, tz);
  const shifted = new Date(at.getTime() + offset * 60_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), weekday: shifted.getUTCDay() };
}

/** The instant a local wall-clock time happens in `tz`. */
export function zoned(year: number, month: number, day: number, hour: number, minute: number, second: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = tzOffsetMinutes(new Date(guess), tz);
  return new Date(guess - offset * 60_000);
}

export function safeTimeZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** End of the due day, in the merchant's time zone. Null when the date doesn't exist. */
export function resolveDue(spec: DueSpec, now: Date, tz: string): Date | null {
  const today = localDate(now, tz);
  const endOf = (y: number, m: number, d: number) => zoned(y, m, d, 23, 59, 59, tz);
  const addDays = (n: number) => {
    const base = new Date(Date.UTC(today.year, today.month - 1, today.day + n));
    return endOf(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
  };
  switch (spec.type) {
    case "today":
      return addDays(0);
    case "tomorrow":
      return addDays(1);
    case "in_days":
      return addDays(spec.days);
    case "weekday": {
      const delta = (spec.day - today.weekday + 7) % 7 || 7; // "Friday" on a Friday means next Friday
      return addDays(delta);
    }
    case "date": {
      if (spec.month < 1 || spec.month > 12 || spec.day < 1 || spec.day > 31) return null;
      let year = spec.year ?? today.year;
      const probe = new Date(Date.UTC(year, spec.month - 1, spec.day));
      if (probe.getUTCMonth() !== spec.month - 1) return null; // Feb 30
      if (!spec.year && Date.UTC(year, spec.month - 1, spec.day) < Date.UTC(today.year, today.month - 1, today.day)) year += 1;
      return endOf(year, spec.month, spec.day);
    }
  }
}

/** Start of a reporting period in the merchant's time zone. */
export function periodStart(p: Period, now: Date, tz: string): { start: Date; end: Date; label: string } {
  const today = localDate(now, tz);
  const midnight = (offsetDays: number) => {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + offsetDays));
    return zoned(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, 0, tz);
  };
  switch (p) {
    case "today":
      return { start: midnight(0), end: now, label: "Today" };
    case "yesterday":
      return { start: midnight(-1), end: midnight(0), label: "Yesterday" };
    case "week": {
      const sinceMonday = (today.weekday + 6) % 7;
      return { start: midnight(-sinceMonday), end: now, label: "This week" };
    }
    case "month":
      return { start: zoned(today.year, today.month, 1, 0, 0, 0, tz), end: now, label: "This month" };
  }
}
