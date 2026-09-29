import type { Block, Row } from "./blocks";
import { api, createAction, formatAmount, qs, type AssistantContext, type Reply } from "./orchestrator";
import { finRange, localDate, resolveDue, type FinPeriod, type Intent } from "./intent-parser";

/**
 * Seti's financial intelligence. Every number comes from Setra's accounting API (the same posted
 * journal entries the reports use); nothing is estimated or invented. When the books can't answer,
 * Seti says so. Creating records (expenses, bills, closing a period) is always a confirmation card
 * that runs through the same API routes and permissions as the console.
 */

type Any = Record<string, any>;

const PRESET: Record<FinPeriod, string> = { month: "month", last_month: "last_month", quarter: "quarter", year: "ytd", last_year: "last_year" };
/** "This month" → "this month" mid-sentence; month names keep their capital. */
const lc = (label: string) => (/^(This|Last|Same)\b/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label);
const usd = (v: string | null | undefined) => (v === null || v === undefined ? "-" : `$${formatAmount(v)}`.replace("$-", "-$"));

/** Exact decimal arithmetic on the API's amount strings (up to 6 decimals). */
const micro = (v: string | null | undefined): bigint => {
  if (!v) return 0n;
  const neg = v.startsWith("-");
  const [w = "0", f = ""] = (neg ? v.slice(1) : v).split(".");
  const n = BigInt(w) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
  return neg ? -n : n;
};
const dec = (n: bigint): string => {
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? "-" : ""}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0")}`;
};

function noAccess(ctx: AssistantContext, what = "the books"): Reply | null {
  if (ctx.can("financials:read")) return null;
  return { intent: "financials", pending: null, blocks: [{ type: "notice", tone: "warning", title: `Your role can't see ${what}.`, text: "Financial statements are visible to owners, admins, operators and viewers." }] };
}

export async function financial(ctx: AssistantContext, intent: Intent): Promise<Reply> {
  const denied = ["record_expense", "record_bill", "close_period"].includes(intent.kind) ? null : noAccess(ctx);
  if (denied) return denied;
  switch (intent.kind) {
    case "fin_pl":
      return profitAndLoss(ctx, intent.period, intent.focus);
    case "fin_compare":
      return compare(ctx, intent.period);
    case "fin_spend":
      return spend(ctx, intent.category, intent.period);
    case "fin_cash":
      return cash(ctx);
    case "fin_payables":
      return payables(ctx);
    case "fin_health":
      return health(ctx);
    case "fin_unclassified":
      return unclassified(ctx);
    case "record_expense":
      return recordExpense(ctx, intent);
    case "record_bill":
      return recordBill(ctx, intent);
    case "close_period":
      return closePeriod(ctx, intent);
    default:
      return { intent: "unknown", pending: null, blocks: [] };
  }
}

// ── ASK ───────────────────────────────────────────────────────────────────────────────────────

async function pl(ctx: AssistantContext, from: string, to: string) {
  return api(ctx, "GET", `/v1/accounting/reports/profit-and-loss?${qs({ from, to })}`);
}

async function suspenseNote(ctx: AssistantContext): Promise<string | undefined> {
  const accounts = (await api<{ data: Any[] }>(ctx, "GET", "/v1/accounting/accounts")).data;
  const held = accounts.find((a) => a.system_key === "payments_to_identify")?.balance;
  return held && held !== "0.00" ? `${usd(held)} received but not yet identified is held aside and isn't counted as revenue.` : undefined;
}

async function profitAndLoss(ctx: AssistantContext, period: FinPeriod, focus: "profit" | "revenue" | "expenses"): Promise<Reply> {
  const r = finRange(period, ctx.now, ctx.tz);
  const [p, note] = await Promise.all([pl(ctx, r.from, r.to), suspenseNote(ctx)]);
  const rows: Row[] = [];
  if (focus !== "expenses") {
    rows.push(["Revenue", usd(p.revenue.total)]);
    if (focus === "revenue") for (const a of p.revenue.accounts.slice(0, 5)) rows.push([`  ${a.name}`, usd(a.amount)]);
  }
  if (p.cost_of_goods_sold.total !== "0.00") rows.push(["Cost of goods sold", usd(p.cost_of_goods_sold.total)]);
  rows.push(["Expenses", usd(p.operating_expenses.total)]);
  const top = [...p.operating_expenses.accounts].sort((a: Any, b: Any) => (micro(b.amount) > micro(a.amount) ? 1 : -1)).slice(0, focus === "expenses" ? 6 : 3);
  for (const a of top) rows.push([`  ${a.name}`, usd(a.amount)]);
  const highlight = focus === "revenue" ? { label: "Revenue", value: usd(p.revenue.total) } : focus === "expenses" ? { label: "Total expenses", value: usd(p.operating_expenses.total) } : { label: micro(p.net_income) < 0n ? "Net loss" : "Net income", value: usd(p.net_income) };
  const empty = p.revenue.accounts.length + p.operating_expenses.accounts.length + p.cost_of_goods_sold.accounts.length === 0;
  return {
    intent: "fin_pl",
    pending: null,
    blocks: [
      {
        type: "summary",
        title: `${r.label}: ${focus === "profit" ? "profit and loss" : focus}`,
        rows,
        highlight,
        note: empty ? "Nothing was posted in this period yet." : note,
        link: { label: "Open profit and loss", href: `/app/reports/profit-and-loss?preset=${PRESET[period]}` }
      }
    ]
  };
}

/** ANALYZE: what changed between this period and the one before, by account. */
async function compare(ctx: AssistantContext, period: FinPeriod): Promise<Reply> {
  const r = finRange(period, ctx.now, ctx.tz);
  const [now, before] = await Promise.all([pl(ctx, r.from, r.to), pl(ctx, r.previous.from, r.previous.to)]);
  const lines = new Map<string, { name: string; kind: "revenue" | "expense"; now: bigint; before: bigint }>();
  const add = (s: Any, kind: "revenue" | "expense", which: "now" | "before") => {
    for (const a of s.accounts) {
      const e = lines.get(a.id) ?? { name: a.name, kind, now: 0n, before: 0n };
      e[which] += micro(a.amount);
      lines.set(a.id, e);
    }
  };
  add(now.revenue, "revenue", "now");
  add(before.revenue, "revenue", "before");
  for (const s of ["cost_of_goods_sold", "operating_expenses"]) {
    add(now[s], "expense", "now");
    add(before[s], "expense", "before");
  }
  const netNow = micro(now.net_income);
  const netBefore = micro(before.net_income);
  const delta = netNow - netBefore;
  // Effect on profit: revenue up helps, expenses up hurts.
  const drivers = [...lines.values()]
    .map((l) => ({ ...l, effect: l.kind === "revenue" ? l.now - l.before : l.before - l.now }))
    .filter((l) => l.effect !== 0n)
    .sort((a, b) => (Math.abs(Number(b.effect)) > Math.abs(Number(a.effect)) ? 1 : -1))
    .slice(0, 5);
  const rows: Row[] = [
    [`Net income, ${lc(r.label)}`, usd(dec(netNow))],
    [`Net income, ${lc(r.previous.label)}`, usd(dec(netBefore))],
    ...drivers.map((d): Row => [`${d.name} (${d.kind === "revenue" ? "revenue" : "expense"})`, `${usd(dec(d.before))} → ${usd(dec(d.now))}`])
  ];
  let text: string;
  if (delta === 0n) text = `Net income is the same as ${lc(r.previous.label)}.`;
  else if (!drivers.length) text = `Net income changed by ${usd(dec(delta))}.`;
  else {
    const main = drivers[0]!;
    const direction = main.kind === "revenue" ? (main.now > main.before ? "higher" : "lower") : main.now > main.before ? "higher" : "lower";
    text = `Net income is ${usd(dec(delta < 0n ? -delta : delta))} ${delta < 0n ? "lower" : "higher"} than ${lc(r.previous.label)}. The biggest factor: ${main.name} was ${direction} (${usd(dec(main.before))} → ${usd(dec(main.now))}).`;
  }
  return {
    intent: "fin_compare",
    pending: null,
    blocks: [
      { type: "text", text },
      { type: "summary", title: `${r.label} compared with ${lc(r.previous.label)}`, rows, highlight: { label: "Change in net income", value: `${delta > 0n ? "+" : ""}${usd(dec(delta))}` }, note: "Compared account by account from posted journal entries.", link: { label: "Open profit and loss", href: `/app/reports/profit-and-loss?preset=${PRESET[period]}` } }
    ]
  };
}

async function spend(ctx: AssistantContext, category: string, period: FinPeriod): Promise<Reply> {
  const r = finRange(period, ctx.now, ctx.tz);
  const needle = category.toLowerCase().replace(/^(the|our|my)\s+/, "").replace(/s$/, "");
  const accounts = (await api<{ data: Any[] }>(ctx, "GET", "/v1/accounting/accounts")).data.filter((a) => ["expense", "cogs"].includes(a.type));
  const account = accounts.find((a) => a.name.toLowerCase().includes(needle));
  if (account) {
    const p = await pl(ctx, r.from, r.to);
    const line = [...p.operating_expenses.accounts, ...p.cost_of_goods_sold.accounts].find((a: Any) => a.id === account.id);
    return {
      intent: "fin_spend",
      pending: null,
      blocks: [{ type: "summary", title: `${account.name}: ${lc(r.label)}`, rows: [["Account", `${account.code} ${account.name}`], ["Period", `${r.from} to ${r.to}`]], highlight: { label: "Spent", value: usd(line?.amount ?? "0.00") }, link: { label: "See the entries", href: `/app/accounting/accounts/${account.id}?preset=${PRESET[period]}` } }]
    };
  }
  const vendors = (await api<{ data: Any[] }>(ctx, "GET", `/v1/vendors?${qs({ search: category, limit: 5 })}`)).data;
  if (vendors.length === 1) {
    const v = vendors[0]!;
    const gl = await api(ctx, "GET", `/v1/accounting/ledger?${qs({ vendor_id: v.id, from: r.from, to: r.to, limit: 500 })}`);
    const total = gl.lines.filter((l: Any) => ["expense", "cogs"].includes(l.account.type)).reduce((s: bigint, l: Any) => s + micro(l.debit) - micro(l.credit), 0n);
    return {
      intent: "fin_spend",
      pending: null,
      blocks: [{ type: "summary", title: `${v.name}: ${lc(r.label)}`, rows: [["Still owed on bills", usd(v.owed)]], highlight: { label: "Expensed", value: usd(dec(total)) }, link: { label: `Open ${v.name}`, href: `/app/vendors/${v.id}` } }]
    };
  }
  return {
    intent: "fin_spend",
    pending: null,
    blocks: [{ type: "notice", tone: "info", title: `I couldn't find an expense account or vendor called “${category}”.`, text: `Your expense accounts: ${accounts.slice(0, 10).map((a) => a.name).join(", ")}.`, link: { label: "Chart of accounts", href: "/app/accounting/accounts" } }]
  };
}

async function cash(ctx: AssistantContext): Promise<Reply> {
  const accounts = (await api<{ data: Any[] }>(ctx, "GET", "/v1/accounting/accounts")).data;
  const cashAccounts = accounts.filter((a) => a.subtype === "cash" && a.balance !== "0.00");
  const total = cashAccounts.reduce((s, a) => s + micro(a.balance), 0n);
  const bal = (key: string) => accounts.find((a) => a.system_key === key)?.balance ?? "0.00";
  const rows: Row[] = cashAccounts.map((a): Row => [a.name, usd(a.balance)]);
  rows.push(["Customers owe you", usd(bal("accounts_receivable"))], ["You owe vendors", usd(bal("accounts_payable"))]);
  if (bal("customer_credits") !== "0.00") rows.push(["Customer credits (owed back or to apply)", usd(bal("customer_credits"))]);
  if (bal("payments_to_identify") !== "0.00") rows.push(["Received, not yet identified", usd(bal("payments_to_identify"))]);
  return {
    intent: "fin_cash",
    pending: null,
    blocks: [{ type: "summary", title: "Cash position", rows, highlight: { label: "Cash in wallets and bank", value: usd(dec(total)) }, note: "Wallet balances are what Setra has recorded since monitoring began; stablecoins are valued at their peg.", link: { label: "Open balance sheet", href: "/app/reports/balance-sheet" } }]
  };
}

async function payables(ctx: AssistantContext): Promise<Reply> {
  // Bills are recorded on the merchant's local calendar date; query the same date,
  // not the API server's UTC default (which can still be yesterday).
  const d = localDate(ctx.now, ctx.tz);
  const asOf = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  const a = await api(ctx, "GET", `/v1/accounting/reports/payables-aging?${qs({ as_of: asOf })}`);
  if (!a.bills.length) return { intent: "fin_payables", pending: null, blocks: [{ type: "notice", tone: "success", title: "You don't owe any vendors right now.", text: "Every approved bill is paid.", link: { label: "Bills", href: "/app/bills" } }] };
  const overdue = a.buckets.filter((b: Any) => b.key !== "current").reduce((s: bigint, b: Any) => s + micro(b.amount), 0n);
  const rows: Row[] = a.bills.slice(0, 6).map((b: Any): Row => [`${b.vendor.name} · ${b.number}`, `${usd(b.remaining)}${b.due_date ? `, due ${b.due_date}` : ""}${b.bucket !== "current" ? " (overdue)" : ""}`]);
  if (a.bills.length > 6) rows.push([`And ${a.bills.length - 6} more`, ""]);
  if (overdue > 0n) rows.push(["Overdue", usd(dec(overdue))]);
  return { intent: "fin_payables", pending: null, blocks: [{ type: "summary", title: "What you owe vendors", rows, highlight: { label: "Total owed", value: usd(a.total) }, link: { label: "Payables aging", href: "/app/reports/payables" } }] };
}

async function health(ctx: AssistantContext): Promise<Reply> {
  const h = await api(ctx, "GET", "/v1/accounting/health");
  const attention = h.checks.filter((c: Any) => c.status === "attention");
  if (!attention.length) return { intent: "fin_health", pending: null, blocks: [{ type: "notice", tone: "success", title: "The books reconcile.", text: `Receivables, payables and every wallet agree with the ledger, and debits equal credits (${h.method} basis).`, link: { label: "Open Books", href: "/app/accounting" } }] };
  return {
    intent: "fin_health",
    pending: null,
    blocks: [{ type: "summary", title: `${attention.length} thing${attention.length === 1 ? "" : "s"} to look at`, rows: attention.map((c: Any): Row => [c.label, c.detail]), highlight: { label: "Checks passing", value: `${h.checks.length - attention.length} of ${h.checks.length}` }, link: { label: "Open Books", href: "/app/accounting" } }]
  };
}

async function unclassified(ctx: AssistantContext): Promise<Reply> {
  const u = await api(ctx, "GET", "/v1/accounting/unclassified");
  const sum = (list: Any[]) => dec(list.reduce((s: bigint, x: Any) => s + micro(x.amount), 0n));
  if (!u.receipts.length && !u.outgoing.length) return { intent: "fin_unclassified", pending: null, blocks: [{ type: "notice", tone: "success", title: "Everything is classified.", text: "Every payment received and every transfer sent is accounted for." }] };
  return {
    intent: "fin_unclassified",
    pending: null,
    blocks: [{ type: "summary", title: "Needs a decision", rows: [["Received, not identified", `${u.receipts.length} (${usd(sum(u.receipts))})`], ["Sent, not classified", `${u.outgoing.length} (${usd(sum(u.outgoing))})`]], highlight: { label: "Waiting", value: String(u.receipts.length + u.outgoing.length) }, note: "Held in holding accounts. Never counted as income or spending until you decide.", link: { label: "Decide now", href: "/app/accounting/classify" } }]
  };
}

// ── CREATE (always confirmed) ─────────────────────────────────────────────────────────────────

/** Suggest an expense account from words in the description; the user sees it before confirming. */
function suggestAccount(accounts: Any[], words: string): Any | undefined {
  const t = words.toLowerCase();
  const hints: Array<[RegExp, string]> = [
    [/\b(software|saas|subscription|license|vercel|figma|notion|slack|github|aws|hosting|cloud|domain)\b/, "software"],
    [/\b(contractor|freelanc|consultant|developer|designer)\b/, "contractor"],
    [/\b(ads?|advertis|marketing|campaign|sponsor)\b/, "marketing"],
    [/\b(gas|network fee|gas fee)\b/, "network fees"],
    [/\b(bank fee|payment fee|processing fee|wire fee)\b/, "payment & bank fees"],
    [/\b(lawyer|legal|accountant|accounting|audit)\b/, "professional"],
    [/\b(office|supplies|rent|admin)\b/, "office"],
    [/\b(flight|hotel|travel|uber|taxi|train)\b/, "travel"]
  ];
  const direct = accounts.find((a) => a.name.length > 3 && t.includes(a.name.toLowerCase()));
  if (direct) return direct;
  for (const [re, name] of hints) if (re.test(t)) return accounts.find((a) => a.name.toLowerCase().startsWith(name));
  return undefined;
}

async function recordExpense(ctx: AssistantContext, intent: Extract<Intent, { kind: "record_expense" }>): Promise<Reply> {
  if (!ctx.can("financials:write")) return { intent: "record_expense", pending: null, blocks: [{ type: "notice", tone: "warning", title: "Your role can't record expenses." }] };
  if (!intent.amount || !(intent.title || intent.vendor)) {
    return { intent: "record_expense", pending: null, blocks: [{ type: "text", text: "Tell me the amount, what it was for and how it was paid. For example: “Record a $49 expense for Vercel hosting paid from the bank.” For money sent from one of your wallets, pick the transfer on the Needs a decision page so the onchain record is linked." }] };
  }
  const title = intent.title ?? intent.vendor!;
  if (!intent.paidFrom) {
    const base = `Record a $${intent.amount} expense for ${title}`;
    return {
      intent: "record_expense",
      pending: null,
      blocks: [
        { type: "choice", prompt: "How was it paid?", options: [{ label: `${base} paid from the bank`, value: "@text" }, { label: `${base} paid personally by an owner`, value: "@text" }] },
        { type: "notice", tone: "info", title: "Paid from one of your wallets?", text: "Record it from the transfer itself so the onchain proof is attached.", link: { label: "Open Needs a decision", href: "/app/accounting/classify" } }
      ]
    };
  }
  const accounts = (await api<{ data: Any[] }>(ctx, "GET", "/v1/accounting/accounts")).data;
  let vendor: Any | undefined;
  if (intent.vendor) {
    const found = (await api<{ data: Any[] }>(ctx, "GET", `/v1/vendors?${qs({ search: intent.vendor, limit: 3 })}`)).data;
    if (found.length === 1) vendor = found[0];
  }
  const spendAccounts = accounts.filter((a) => ["expense", "cogs"].includes(a.type) && !a.archived);
  const vendorDetail = vendor ? await api(ctx, "GET", `/v1/vendors/${vendor.id}`) : undefined;
  const account = suggestAccount(spendAccounts, `${title} ${intent.vendor ?? ""}`) ?? (vendorDetail?.default_account ? spendAccounts.find((a) => a.id === vendorDetail.default_account.id) : undefined) ?? accounts.find((a) => a.system_key === "general_expense");
  const paidFrom = accounts.find((a) => a.system_key === (intent.paidFrom === "bank" ? "bank" : "owner_equity"));
  if (!account || !paidFrom) return { intent: "record_expense", pending: null, blocks: [{ type: "notice", tone: "danger", title: "The chart of accounts is missing a required account." }] };
  const approve = ctx.can("financials:approve");
  const d = localDate(ctx.now, ctx.tz);
  const date = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  const action = await createAction(ctx, "record_expense", { title, amount: intent.amount, account_id: account.id, vendor_id: vendor?.id ?? null, paid_from_account_id: paidFrom.id, expense_date: date, approve });
  return {
    intent: "record_expense",
    pending: null,
    blocks: [
      {
        type: "confirm",
        actionId: action.id,
        title: "Record this expense?",
        rows: [
          ["Expense", title],
          ["Amount", `$${formatAmount(intent.amount)}`],
          ["Account", `${account.code} ${account.name} (suggested; change it later if needed)`],
          ["Paid from", paidFrom.name],
          vendor ? ["Vendor", vendor.name] : ["Vendor", "None linked"],
          ["Date", date],
          ["After confirming", approve ? "Posted to the books" : "Saved for an admin to approve"]
        ],
        confirmLabel: "Record expense",
        testMode: ctx.environment === "test",
        expiresAt: action.expires_at
      }
    ]
  };
}

async function recordBill(ctx: AssistantContext, intent: Extract<Intent, { kind: "record_bill" }>): Promise<Reply> {
  if (!ctx.can("financials:write")) return { intent: "record_bill", pending: null, blocks: [{ type: "notice", tone: "warning", title: "Your role can't record bills." }] };
  if (!intent.vendor || !intent.amount || !intent.number) {
    const missing = [!intent.vendor && "who it's from", !intent.amount && "the amount", !intent.number && "the bill number"].filter(Boolean).join(", ");
    return { intent: "record_bill", pending: null, blocks: [{ type: "text", text: `I need ${missing}. For example: “Record a bill from Northwind Hosting #NW-1042 for $420 hosting, due October 15.”` }] };
  }
  const vendors = (await api<{ data: Any[] }>(ctx, "GET", `/v1/vendors?${qs({ search: intent.vendor, limit: 5 })}`)).data;
  const exact = vendors.find((v) => v.name.toLowerCase() === intent.vendor!.toLowerCase()) ?? (vendors.length === 1 ? vendors[0] : undefined);
  if (!exact && vendors.length > 1) {
    return { intent: "record_bill", pending: null, blocks: [{ type: "choice", prompt: `Which vendor is “${intent.vendor}”?`, options: vendors.map((v) => ({ label: `Record a bill from ${v.name} #${intent.number} for $${intent.amount}${intent.title ? ` ${intent.title}` : ""}`, value: "@text" })) }] };
  }
  const accounts = (await api<{ data: Any[] }>(ctx, "GET", "/v1/accounting/accounts")).data;
  const spendAccounts = accounts.filter((a) => ["expense", "cogs"].includes(a.type) && !a.archived);
  const vendorDetail = exact ? await api(ctx, "GET", `/v1/vendors/${exact.id}`) : undefined;
  const account = (vendorDetail?.default_account ? spendAccounts.find((a) => a.id === vendorDetail.default_account.id) : undefined) ?? suggestAccount(spendAccounts, `${intent.title ?? ""} ${intent.vendor}`) ?? accounts.find((a) => a.system_key === "general_expense");
  const d = localDate(ctx.now, ctx.tz);
  const billDate = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  const due = intent.due ? resolveDue(intent.due, ctx.now, ctx.tz) : null;
  const dueDate = due ? new Intl.DateTimeFormat("en-CA", { timeZone: ctx.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(due) : null;
  const approve = ctx.can("financials:approve");
  const title = intent.title ?? `${exact?.name ?? intent.vendor} bill`;
  const action = await createAction(ctx, "record_bill", { vendor_id: exact?.id ?? null, new_vendor: exact ? null : intent.vendor, number: intent.number, title, amount: intent.amount, account_id: account?.id ?? null, bill_date: billDate, due_date: dueDate, approve });
  return {
    intent: "record_bill",
    pending: null,
    blocks: [
      {
        type: "confirm",
        actionId: action.id,
        title: "Record this bill?",
        rows: [
          ["Vendor", exact ? exact.name : `${intent.vendor} (new vendor)`],
          ["Bill number", intent.number],
          ["For", title],
          ["Amount", `$${formatAmount(intent.amount)}`],
          ["Account", account ? `${account.code} ${account.name}` : "General Expenses"],
          ["Due", dueDate ?? "No due date"],
          ["After confirming", approve ? "Approved: it's a payable until paid" : "Saved for an admin to approve"]
        ],
        confirmLabel: "Record bill",
        testMode: ctx.environment === "test",
        expiresAt: action.expires_at
      }
    ]
  };
}

async function closePeriod(ctx: AssistantContext, intent: Extract<Intent, { kind: "close_period" }>): Promise<Reply> {
  if (!ctx.can("financials:manage")) return { intent: "close_period", pending: null, blocks: [{ type: "notice", tone: "warning", title: "Only owners and admins can close a period." }] };
  const d = localDate(ctx.now, ctx.tz);
  let month = intent.last ? (d.month === 1 ? 12 : d.month - 1) : intent.month!;
  let year = intent.year ?? (intent.last ? (d.month === 1 ? d.year - 1 : d.year) : month >= d.month ? d.year - 1 : d.year);
  if (!intent.last && !intent.year && month === d.month) year = d.year;
  const key = `${year}-${String(month).padStart(2, "0")}`;
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const periods = (await api<{ data: Any[] }>(ctx, "GET", "/v1/accounting/periods")).data;
  const period = periods.find((x) => x.month === key);
  if (period?.status === "closed") return { intent: "close_period", pending: null, blocks: [{ type: "notice", tone: "info", title: `${label} is already closed.` }] };
  if (period && !period.ended) return { intent: "close_period", pending: null, blocks: [{ type: "notice", tone: "info", title: `${label} hasn't ended yet.`, text: "A period can be closed once it's over." }] };
  if (period?.draft_entries) return { intent: "close_period", pending: null, blocks: [{ type: "notice", tone: "warning", title: `${label} has ${period.draft_entries} draft entr${period.draft_entries === 1 ? "y" : "ies"}.`, text: "Post or discard them before closing.", link: { label: "Open journal", href: "/app/accounting/journal?status=draft" } }] };
  const action = await createAction(ctx, "close_period", { month: key, label });
  return {
    intent: "close_period",
    pending: null,
    blocks: [
      {
        type: "confirm",
        actionId: action.id,
        title: `Close ${label}?`,
        rows: [
          ["Entries in the period", String(period?.posted_entries ?? 0)],
          ["After closing", "Nothing more can be posted into it. Late activity is dated into the next open month."],
          ["Undo", "An owner or admin can reopen it with a reason."]
        ],
        confirmLabel: "Close period",
        testMode: ctx.environment === "test",
        expiresAt: action.expires_at
      }
    ]
  };
}

/** Carry out a confirmed financial action through the public API (as the user). */
export async function applyFinancialAction(ctx: AssistantContext, action: Any): Promise<Block[]> {
  const p = action.payload;
  if (action.kind === "record_expense") {
    const x = await api(ctx, "POST", "/v1/expenses", { title: p.title, amount: p.amount, account_id: p.account_id, vendor_id: p.vendor_id, paid_from_account_id: p.paid_from_account_id, expense_date: p.expense_date, approve: p.approve }, action.id);
    return [
      { type: "notice", tone: "success", title: x.status === "approved" ? "Expense recorded in the books." : "Expense saved for approval." },
      { type: "record", title: x.title, rows: [["Amount", `$${formatAmount(x.amount)}`], ["Account", `${x.account.code} ${x.account.name}`], ["Status", x.status === "approved" ? "Posted" : "Awaiting approval"]], links: [{ label: "Open expense", href: `/app/expenses/${x.id}` }] }
    ];
  }
  if (action.kind === "record_bill") {
    let vendorId = p.vendor_id;
    if (!vendorId && p.new_vendor) vendorId = (await api(ctx, "POST", "/v1/vendors", { name: p.new_vendor }, `${action.id}-vendor`)).id;
    const b = await api(ctx, "POST", "/v1/bills", { vendor_id: vendorId, number: p.number, title: p.title, amount: p.amount, account_id: p.account_id, bill_date: p.bill_date, due_date: p.due_date, approve: p.approve }, action.id);
    return [
      { type: "notice", tone: "success", title: b.status === "approved" ? `Bill ${b.number} approved. It's now a payable.` : `Bill ${b.number} saved for approval.` },
      { type: "record", title: `${b.vendor.name} · ${b.number}`, rows: [["For", b.title], ["Amount", `$${formatAmount(b.amount)}`], ["Due", b.due_date ?? "No due date"]], links: [{ label: "Open bill", href: `/app/bills/${b.id}` }] }
    ];
  }
  if (action.kind === "close_period") {
    await api(ctx, "POST", "/v1/accounting/periods/close", { month: p.month });
    return [{ type: "notice", tone: "success", title: `${p.label} is closed.`, text: "Nothing more can be posted into it. Late activity lands in the next open month.", link: { label: "Open Books", href: "/app/accounting" } }];
  }
  throw new Error(`Unknown action ${action.kind}`);
}
