import type { Block, InvoiceCard, PaymentCard } from "./blocks";

/**
 * Seti's voice: one plain sentence before a card, so an answer reads like a reply and not a report.
 *
 * Every figure in the sentence is copied from the card underneath it, which the backend produced. Nothing
 * here does arithmetic or guesses: when the card doesn't carry a number, the sentence doesn't state one.
 * Replies that already open with text, a question or a notice are left alone.
 */

type Spoken = { intent: string; blocks: Block[] };

const CARDS = new Set<Block["type"]>(["payment", "payments", "invoices", "summary", "exceptions", "record", "confirm"]);

/** The same message always gets the same wording; different messages get a little variety. */
export function pick(seed: string, options: string[]): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return options[Math.abs(h) % options.length]!;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const amount = (value: string, asset: string) => (asset ? `${value} ${asset}` : `$${value}`);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const count = (n: number, one: string, many: string) => (n === 1 ? `One ${one}` : `${n} ${many}`);

function payment(p: PaymentCard, intent: string, next: Block | undefined, seed: string): string | null {
  const paid = amount(p.amount, p.asset);
  const who = p.customer ?? "a wallet I don't recognise";
  const forWhat = p.purpose ? ` for ${p.purpose}` : p.invoice ? ` on ${p.invoice}` : "";
  const open = next?.type === "invoices" ? next.items : [];
  switch (p.status) {
    case "matched": {
      const lead = intent === "latest" ? `The latest payment is ${paid} from ${who}${forWhat}.` : `${pick(seed, ["Yes.", "They did.", "Yes, it's in."])} ${who} paid ${paid}${forWhat}.`;
      return open.length ? `${lead} ${open.length === 1 ? "They still have one request open." : `They still have ${open.length} requests open.`}` : lead;
    }
    case "partial": {
      const inv = open.find((i) => i.number === p.invoice);
      return `${who} has paid ${paid}${forWhat} so far.${inv ? ` ${amount(inv.remaining, inv.asset)} is still open.` : " That's only part of what was due."}`;
    }
    case "overpaid":
      return `${who} paid ${paid}, which is more than ${p.invoice ?? "the invoice"} asked for. It's waiting in your review queue so you can decide what to do with the extra.`;
    case "confirming":
      return `${paid} from ${who} is on its way. I'll count it once the block is final.`;
    case "needs_review":
      return `${paid} came in from ${who}, but I couldn't tell which invoice it's for, so I haven't applied it. It's waiting for you in review.`;
    case "reversed":
      return `The ${paid} payment from ${who} was reversed on chain, so it no longer counts.`;
    case "refunded":
      return `The ${paid} payment from ${who} was refunded.`;
    default:
      return null;
  }
}

function invoice(i: InvoiceCard): string {
  const left = amount(i.remaining, i.asset);
  switch (i.status) {
    case "paid":
      return `${i.number} is paid in full.`;
    case "overpaid":
      return `${i.number} is paid, with more than was asked for.`;
    case "partially_paid":
      return `${i.number} is partly paid. ${left} is still open.`;
    case "overdue":
      return `${i.number} is overdue, with ${left} still unpaid.`;
    case "cancelled":
      return `${i.number} was cancelled.`;
    case "expired":
      return `${i.number} expired before it was paid.`;
    default:
      return `${i.number} hasn't been paid yet. ${i.customer} owes ${left}.`;
  }
}

function largest(items: InvoiceCard[]): InvoiceCard | undefined {
  const value = (i: InvoiceCard) => Number(i.remaining.replace(/,/g, ""));
  return [...items].sort((a, b) => value(b) - value(a))[0];
}

function invoices(b: Extract<Block, { type: "invoices" }>, intent: string, seed: string): string | null {
  const total = b.total?.match(/^[\d,.]+/)?.[0];
  if (intent === "payment_status" && b.items.length === 1) return invoice(b.items[0]!);
  if (intent === "overdue") {
    if (!b.items.length) return pick(seed, ["Nothing's overdue right now.", "No overdue payment requests. Good."]);
    const top = largest(b.items)!;
    return `${count(b.items.length, "payment request is", "payment requests are")} past due. The largest is ${top.customer}, with ${amount(top.remaining, top.asset)} unpaid.`;
  }
  if (intent === "outstanding") {
    const name = b.title.startsWith("Outstanding for ") ? b.title.slice("Outstanding for ".length) : null;
    if (name) return b.items.length ? `${name} owes ${total ? `$${total}` : "money"} across ${b.items.length === 1 ? "one request" : `${b.items.length} requests`}.` : `${name} doesn't owe you anything right now.`;
    if (!b.items.length) return pick(seed, ["Good news: nobody owes you anything right now.", "Nothing's outstanding. Every payment request is settled."]);
    const n = Number(b.title.match(/(\d+) payment request/)?.[1] ?? b.items.length);
    const top = largest(b.items)!;
    if (n === 1) return `One payment request is still open: ${top.customer} owes ${amount(top.remaining, top.asset)}.`;
    return `${n} payment requests are still open${total ? `, $${total} in total` : ""}. ${top.customer} owes the most, ${amount(top.remaining, top.asset)}.`;
  }
  return null;
}

function summary(b: Extract<Block, { type: "summary" }>, intent: string): string | null {
  const value = b.highlight.value;
  // "This month" reads as "this month"; a month name or a year keeps its capital and takes "in".
  const label = b.title.includes(":") ? b.title.split(":")[0]!.trim() : "";
  const period = !label ? "" : /^(This|Last|Same)\b/.test(label) ? lowerFirst(label) : `in ${label}`;
  const row = (label: string) => b.rows.find((r) => r[0] === label)?.[1];
  switch (intent) {
    case "fin_cash":
      return `You have ${value} across your wallets and bank.`;
    case "fin_payables": {
      if (b.rows.length !== 1) return `You owe vendors ${value} in total.`;
      const [what, detail] = b.rows[0]!;
      const [vendor, number] = what.split(" · ");
      const due = detail.match(/due (\d{4})-(\d{2})-(\d{2})/);
      const when = due ? `, due ${MONTHS[Number(due[2]) - 1]} ${Number(due[3])}` : "";
      return `You owe ${vendor} ${value}${number ? ` on bill ${number}` : ""}${when}.`;
    }
    case "fin_pl":
      if (b.note === "Nothing was posted in this period yet.") return `Nothing has been posted ${period} yet, so there's nothing to report.`;
      if (b.highlight.label === "Net loss") return `You're at a loss of ${value} ${period}.`;
      if (b.highlight.label === "Revenue") return `Revenue ${period} is ${value}.`;
      if (b.highlight.label === "Total expenses") return `You've spent ${value} ${period}.`;
      return `You made ${value} in profit ${period}.`;
    case "fin_spend": {
      const name = b.title.split(":")[0]!.trim();
      const when = lowerFirst(b.title.split(":")[1]?.trim() ?? "");
      return b.highlight.label === "Expensed" ? `You've expensed ${value} with ${name} ${when}.` : `You've spent ${value} on ${name} ${when}.`;
    }
    case "fin_health":
      return `${b.title.replace(/^(\d+) things? to look at$/, (_, n) => (n === "1" ? "One thing in your books needs" : `${n} things in your books need`))} a look.`;
    case "fin_unclassified":
      return "Some money needs a decision from you before the books are complete.";
    case "summary": {
      const received = Number(row("Payments received") ?? NaN);
      const when = lowerFirst(b.title.split(":")[0]!.trim());
      if (b.title.endsWith(": payments")) {
        if (received === 0) return `No payments came in ${when}.`;
        if (Number.isFinite(received)) return `${received === 1 ? "One payment" : `${received} payments`} came in ${when}, worth ${value}.`;
      }
      return null;
    }
    default:
      return null;
  }
}

function lead(reply: Spoken, seed: string): string | null {
  const [first, second] = reply.blocks;
  if (!first || !CARDS.has(first.type)) return null;
  switch (first.type) {
    case "payment":
      return payment(first.payment, reply.intent, second, seed);
    case "invoices":
      return invoices(first, reply.intent, seed);
    case "payments": {
      if (reply.intent === "find") return first.items.length ? `I found ${first.items.length === 1 ? "one payment" : `${first.items.length} payments`} that match.` : "I couldn't find a payment that matches.";
      const name = first.title.split(":")[0];
      const total = first.title.match(/· ([\d,.]+) USD received/)?.[1];
      if (!first.items.length) return `I don't see any payments from ${name} yet.`;
      return total ? `${name} has paid you $${total} in total. Here are the latest payments.` : `Here are ${name}'s latest payments.`;
    }
    case "exceptions": {
      if (!first.items.length) return pick(seed, ["All clear. Nothing needs your review.", "Nothing's waiting for review. You're caught up."]);
      const n = first.items.length >= 10 ? "At least 10 payments need" : first.items.length === 1 ? "One payment needs" : `${first.items.length} payments need`;
      return `${n} a look. The newest: ${lowerFirst(first.items[0]!.summary)}.`;
    }
    case "summary":
      return summary(first, reply.intent);
    case "record":
      return "Here's everything Setra recorded about that payment.";
    case "confirm":
      switch (reply.intent) {
        case "create_request":
          return pick(seed, ["Here's the payment request. Does it look right?", "Here's what I'll create. Look right?"]);
        case "record_expense":
          return "Here's the expense. Confirm and I'll post it to the books.";
        case "record_bill":
          return "Here's the bill. Confirm and I'll add it to what you owe.";
        case "close_period":
          return "Ready when you are. Once it's closed, nothing more can be posted to that month.";
        case "correction":
          return "Here's the change. Confirm and I'll move the payment.";
        default:
          return "Here's what I'll do. Confirm when you're ready.";
      }
    default:
      return null;
  }
}

/** Prefix a reply with a one-line answer in Seti's voice, when it opens with a card. */
export function speak<T extends Spoken>(reply: T, message: string): T {
  const sentence = lead(reply, message.trim().toLowerCase());
  return sentence ? { ...reply, blocks: [{ type: "text", text: sentence }, ...reply.blocks] } : reply;
}
