import { createHash } from "node:crypto";
import type { Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";
import { accountById, LEDGER_DECIMALS } from "./chart";
import { ensureBooks } from "./posting-rules";
import { isoDate, postEntry } from "./ledger";
import { money } from "./reports";

type Row = Record<string, any>;

/**
 * Bank reconciliation for off-chain accounts (bank, card). Setra reconciles wallets against the
 * chain automatically; everything else is reconciled against the statement: import it, match each
 * statement line to a ledger line (or create the missing entry), then check that the ledger less
 * uncleared items equals the statement balance.
 */

export interface StatementMapping {
  date: string;
  description: string;
  amount?: string;
  money_in?: string;
  money_out?: string;
  reference?: string;
}

export type DateFormat = "YYYY-MM-DD" | "MM/DD/YYYY" | "DD/MM/YYYY" | "DD.MM.YYYY";

/** RFC 4180-ish CSV: quoted fields, doubled quotes, commas/newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** "1,234.56", "$1,234.56", "(12.00)", "-12" → ledger micro-units. Null if it isn't a number. */
export function parseStatementAmount(raw: string | undefined): bigint | null {
  if (raw === undefined) return null;
  let v = raw.trim();
  if (!v) return null;
  let neg = false;
  if (/^\(.*\)$/.test(v)) {
    neg = true;
    v = v.slice(1, -1);
  }
  v = v.replace(/[\s$€£,]/g, "").replace(/[A-Za-z]{3}$/, "");
  if (v.startsWith("-")) {
    neg = !neg;
    v = v.slice(1);
  } else if (v.startsWith("+")) v = v.slice(1);
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const [w, f = ""] = v.split(".");
  const micro = BigInt(w!) * 10n ** BigInt(LEDGER_DECIMALS) + BigInt((f + "000000").slice(0, LEDGER_DECIMALS));
  return neg ? -micro : micro;
}

export function parseStatementDate(raw: string | undefined, format: DateFormat): string | null {
  const v = raw?.trim();
  if (!v) return null;
  let y: number, m: number, d: number;
  const parts = v.split(/[-/.]/).map((p) => Number(p));
  if (parts.length < 3 || parts.some((p) => !Number.isInteger(p))) return null;
  if (format === "YYYY-MM-DD") [y, m, d] = parts as [number, number, number];
  else if (format === "MM/DD/YYYY") [m, d, y] = parts as [number, number, number];
  else [d, m, y] = parts as [number, number, number];
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return isoDate(dt);
}

async function bankAccount(client: Client, organizationId: string, environment: Environment, accountId: string): Promise<Row> {
  const a = await accountById(client, organizationId, environment, accountId);
  if (a.wallet_id) throw new EngineError("wallet_account", "Wallet accounts are reconciled against the chain automatically.", 422);
  if (!(a.subtype === "cash" || (a.type === "liability" && !a.system_key))) throw new EngineError("not_a_bank_account", "Choose a bank, cash or card account.", 422);
  return a;
}

/** Import statement lines from CSV. Re-importing the same file never duplicates a line. */
export async function importStatement(
  client: Client,
  organizationId: string,
  environment: Environment,
  input: { account_id: string; filename?: string | null; csv: string; mapping: StatementMapping; date_format: DateFormat; has_header?: boolean },
  actor: Actor
): Promise<{ import_id: string; imported: number; skipped: number; errors: Array<{ row: number; message: string }> }> {
  await ensureBooks(client, organizationId, environment);
  const account = await bankAccount(client, organizationId, environment, input.account_id);
  const rows = parseCsv(input.csv);
  if (rows.length === 0) throw new EngineError("empty_statement", "That file has no rows.", 422);
  const header = input.has_header === false ? null : rows[0]!.map((h) => h.trim());
  const body = header ? rows.slice(1) : rows;
  if (body.length > 5000) throw new EngineError("statement_too_large", "Import at most 5,000 lines at a time.", 422);
  const col = (name: string | undefined) => {
    if (name === undefined || name === "") return -1;
    if (header) {
      const i = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
      if (i === -1) throw new EngineError("unknown_column", `The file has no column called “${name}”.`, 422);
      return i;
    }
    const i = Number(name) - 1;
    if (!Number.isInteger(i) || i < 0) throw new EngineError("unknown_column", "Without a header row, name columns by number (1, 2, 3…).", 422);
    return i;
  };
  const cDate = col(input.mapping.date);
  const cDesc = col(input.mapping.description);
  const cAmount = col(input.mapping.amount);
  const cIn = col(input.mapping.money_in);
  const cOut = col(input.mapping.money_out);
  const cRef = col(input.mapping.reference);
  if (cAmount === -1 && cIn === -1 && cOut === -1) throw new EngineError("amount_column_required", "Choose an amount column, or money-in and money-out columns.", 422);

  const importId = newId("bankImport");
  await client.query("INSERT INTO bank_statement_imports (id, organization_id, environment, account_id, filename, line_count, created_by_label) VALUES ($1,$2,$3,$4,$5,0,$6)", [importId, organizationId, environment, account.id, input.filename ?? null, actor.label ?? null]);
  const errors: Array<{ row: number; message: string }> = [];
  const seen = new Map<string, number>();
  let imported = 0;
  let skipped = 0;
  for (let i = 0; i < body.length; i++) {
    const r = body[i]!;
    const rowNo = i + (header ? 2 : 1);
    const date = parseStatementDate(r[cDate], input.date_format);
    if (!date) {
      errors.push({ row: rowNo, message: `Couldn't read the date “${r[cDate] ?? ""}” as ${input.date_format}.` });
      continue;
    }
    let amount: bigint | null;
    if (cAmount !== -1) amount = parseStatementAmount(r[cAmount]);
    else {
      const inAmt = parseStatementAmount(r[cIn]) ?? 0n;
      const outAmt = parseStatementAmount(r[cOut]) ?? 0n;
      amount = inAmt - (outAmt < 0n ? -outAmt : outAmt);
    }
    if (amount === null || amount === 0n) {
      errors.push({ row: rowNo, message: "No amount on this row." });
      continue;
    }
    const description = (r[cDesc] ?? "").trim().slice(0, 300) || "(no description)";
    const reference = cRef === -1 ? null : (r[cRef] ?? "").trim().slice(0, 120) || null;
    const base = `${account.id}|${date}|${amount}|${description}|${reference ?? ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const fingerprint = createHash("sha256").update(`${base}|${n}`).digest("hex");
    const res = await client.query(
      `INSERT INTO bank_statement_lines (id, organization_id, environment, account_id, import_id, line_date, description, reference, amount, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (organization_id, environment, account_id, fingerprint) DO NOTHING`,
      [newId("bankLine"), organizationId, environment, account.id, importId, date, description, reference, amount.toString(), fingerprint]
    );
    if (res.rowCount) imported += 1;
    else skipped += 1;
  }
  await client.query("UPDATE bank_statement_imports SET line_count = $2, skipped_count = $3 WHERE id = $1", [importId, imported, skipped]);
  await audit(client, actor, { organizationId, environment, action: "bank_statement_imported", objectType: "ledger_account", objectId: account.id, next: { import_id: importId, imported, skipped, errors: errors.length } });
  return { import_id: importId, imported, skipped, errors: errors.slice(0, 50) };
}

/** Ledger lines on the account that could be this statement line: same amount, near the date, not matched. */
async function candidates(client: Client, line: Row): Promise<Row[]> {
  return (
    await client.query(
      `SELECT l.id, l.debit, l.credit, l.memo, e.id AS entry_id, e.number, e.entry_date::text AS entry_date, e.description, abs(e.entry_date - $3::date) AS days
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = $1 AND e.status = 'posted' AND (l.debit - l.credit) = $2::numeric
          AND e.entry_date BETWEEN $3::date - 10 AND $3::date + 10
          AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.journal_line_id = l.id)
        ORDER BY days, e.entry_date, e.number LIMIT 5`,
      [line.account_id, line.amount, line.line_date]
    )
  ).rows as Row[];
}

const serializeLine = (l: Row, suggestions?: Row[]) => ({
  id: l.id,
  date: l.line_date,
  description: l.description,
  reference: l.reference,
  amount: money(BigInt(l.amount)),
  status: l.status,
  excluded_reason: l.excluded_reason,
  matched: l.journal_line_id ? { journal_line_id: l.journal_line_id, entry_id: l.entry_id ?? null, entry_number: l.entry_number ?? null } : null,
  suggestions: suggestions?.map((c) => ({ journal_line_id: c.id, entry_id: c.entry_id, number: c.number, date: c.entry_date, description: c.description, amount: money(BigInt(c.debit) - BigInt(c.credit)) }))
});

export async function statementLines(client: Client, organizationId: string, environment: Environment, accountId: string, opts: { status?: string; limit?: number } = {}) {
  await bankAccount(client, organizationId, environment, accountId);
  const rows = (
    await client.query(
      `SELECT b.*, e.id AS entry_id, e.number AS entry_number FROM bank_statement_lines b
         LEFT JOIN journal_lines l ON l.id = b.journal_line_id LEFT JOIN journal_entries e ON e.id = l.entry_id
        WHERE b.account_id = $1 AND ($2::text IS NULL OR b.status = $2) ORDER BY b.line_date DESC, b.id DESC LIMIT $3`,
      [accountId, opts.status ?? null, opts.limit ?? 500]
    )
  ).rows as Row[];
  const out = [];
  for (const r of rows) out.push(serializeLine(r, r.status === "unmatched" ? await candidates(client, r) : undefined));
  return out;
}

async function lineById(client: Client, organizationId: string, environment: Environment, id: string, lock = true): Promise<Row> {
  const l = (await client.query(`SELECT * FROM bank_statement_lines WHERE id = $1 AND organization_id = $2 AND environment = $3${lock ? " FOR UPDATE" : ""}`, [id, organizationId, environment])).rows[0] as Row | undefined;
  if (!l) throw new EngineError("not_found", "No such statement line.", 404);
  return l;
}

async function reconciledThrough(client: Client, accountId: string): Promise<string | null> {
  return ((await client.query("SELECT max(statement_date)::text AS d FROM bank_reconciliations WHERE account_id = $1", [accountId])).rows[0]?.d as string | null) ?? null;
}

export async function matchStatementLine(client: Client, organizationId: string, environment: Environment, lineId: string, journalLineId: string, actor: Actor): Promise<void> {
  const line = await lineById(client, organizationId, environment, lineId);
  if (line.status !== "unmatched") throw new EngineError("line_not_unmatched", "This statement line is already matched or excluded.", 409);
  const jl = (
    await client.query("SELECT l.*, e.status AS entry_status FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.id = $1 AND e.organization_id = $2 AND e.environment = $3", [journalLineId, organizationId, environment])
  ).rows[0] as Row | undefined;
  if (!jl || jl.account_id !== line.account_id) throw new EngineError("wrong_account", "Match it to a line on the same account.", 422);
  if (jl.entry_status !== "posted") throw new EngineError("entry_not_posted", "Only posted entries can be matched.", 409);
  if (BigInt(jl.debit) - BigInt(jl.credit) !== BigInt(line.amount)) throw new EngineError("amount_mismatch", "The amounts differ. Create an adjusting entry for the difference instead.", 422);
  if ((await client.query("SELECT 1 FROM bank_statement_lines WHERE journal_line_id = $1", [journalLineId])).rows[0]) throw new EngineError("already_matched", "That ledger line is matched to another statement line.", 409);
  await client.query("UPDATE bank_statement_lines SET status = 'matched', journal_line_id = $2, matched_at = now(), matched_by_label = $3, updated_at = now() WHERE id = $1", [lineId, journalLineId, actor.label ?? null]);
  await audit(client, actor, { organizationId, environment, action: "bank_line_matched", objectType: "bank_statement_line", objectId: lineId, next: { journal_line_id: journalLineId } });
}

/** Match every line that has exactly one candidate, which in turn is nobody else's only candidate. */
export async function autoMatchStatement(client: Client, organizationId: string, environment: Environment, accountId: string, actor: Actor): Promise<{ matched: number }> {
  await bankAccount(client, organizationId, environment, accountId);
  const open = (await client.query("SELECT * FROM bank_statement_lines WHERE account_id = $1 AND status = 'unmatched' ORDER BY line_date, id", [accountId])).rows as Row[];
  const options = new Map<string, Row[]>();
  const claims = new Map<string, number>();
  for (const l of open) {
    const c = await candidates(client, l);
    options.set(l.id, c);
    for (const x of c) claims.set(x.id, (claims.get(x.id) ?? 0) + 1);
  }
  let matched = 0;
  for (const l of open) {
    const c = options.get(l.id)!;
    if (c.length === 1 && claims.get(c[0]!.id) === 1) {
      await matchStatementLine(client, organizationId, environment, l.id, c[0]!.id, actor);
      matched += 1;
    }
  }
  return { matched };
}

/** Post the entry the ledger was missing for a statement line (a bank fee, interest, a card charge) and match it. */
export async function createEntryForStatementLine(client: Client, organizationId: string, environment: Environment, lineId: string, input: { account_id: string; memo?: string | null }, actor: Actor): Promise<Row> {
  const line = await lineById(client, organizationId, environment, lineId);
  if (line.status !== "unmatched") throw new EngineError("line_not_unmatched", "This statement line is already matched or excluded.", 409);
  const counter = await accountById(client, organizationId, environment, input.account_id);
  if (counter.id === line.account_id) throw new EngineError("invalid_account", "Choose the account on the other side (for example Payment & Bank Fees).", 422);
  if (counter.archived_at) throw new EngineError("account_archived", `Account ${counter.code} is archived.`, 422);
  if (counter.system_key === "accounts_receivable" || counter.system_key === "accounts_payable") throw new EngineError("use_subledger", "Money for invoices or bills should be recorded on the invoice or bill so customer and vendor balances stay right.", 422);
  const amount = BigInt(line.amount);
  const abs = amount < 0n ? -amount : amount;
  const { entry } = await postEntry(client, {
    organizationId,
    environment,
    date: line.line_date,
    description: line.description.slice(0, 500),
    memo: input.memo ?? (line.reference ? `Statement reference ${line.reference}` : null),
    sourceType: "bank",
    sourceId: line.id,
    sourceKey: `bank-line:${line.id}`,
    actor,
    lines: amount > 0n ? [{ accountId: line.account_id, debit: abs, memo: "Per bank statement" }, { accountId: counter.id, credit: abs }] : [{ accountId: counter.id, debit: abs }, { accountId: line.account_id, credit: abs, memo: "Per bank statement" }]
  });
  const bankLine = (await client.query("SELECT id FROM journal_lines WHERE entry_id = $1 AND account_id = $2", [entry.id, line.account_id])).rows[0] as Row;
  await matchStatementLine(client, organizationId, environment, line.id, bankLine.id, actor);
  return entry;
}

export async function excludeStatementLine(client: Client, organizationId: string, environment: Environment, lineId: string, reason: string, actor: Actor): Promise<void> {
  const line = await lineById(client, organizationId, environment, lineId);
  if (line.status !== "unmatched") throw new EngineError("line_not_unmatched", "Only unmatched lines can be excluded.", 409);
  await client.query("UPDATE bank_statement_lines SET status = 'excluded', excluded_reason = $2, updated_at = now() WHERE id = $1", [lineId, reason]);
  await audit(client, actor, { organizationId, environment, action: "bank_line_excluded", objectType: "bank_statement_line", objectId: lineId, next: { reason } });
}

export async function unmatchStatementLine(client: Client, organizationId: string, environment: Environment, lineId: string, actor: Actor): Promise<void> {
  const line = await lineById(client, organizationId, environment, lineId);
  if (line.status === "unmatched") return;
  const through = await reconciledThrough(client, line.account_id);
  if (through && line.line_date <= through) throw new EngineError("line_reconciled", `This line is part of the reconciliation through ${through}.`, 409);
  await client.query("UPDATE bank_statement_lines SET status = 'unmatched', journal_line_id = NULL, matched_at = NULL, matched_by_label = NULL, excluded_reason = NULL, updated_at = now() WHERE id = $1", [lineId]);
  await audit(client, actor, { organizationId, environment, action: "bank_line_unmatched", objectType: "bank_statement_line", objectId: lineId, previous: { status: line.status } });
}

/**
 * Where the reconciliation stands on a statement date: ledger balance, items in the ledger the
 * bank hasn't cleared, statement lines still to match, and the difference to the statement balance.
 */

export async function reconciliationStatus(client: Client, organizationId: string, environment: Environment, accountId: string, statementDate: string, statementBalance?: string | null) {
  const account = await bankAccount(client, organizationId, environment, accountId);
  const ledger = BigInt(
    (await client.query<{ s: string }>("SELECT COALESCE(sum(l.debit - l.credit), 0)::text AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.status = 'posted' AND e.entry_date <= $2::date", [accountId, statementDate])).rows[0]!.s
  );
  const uncleared = (
    await client.query(
      `SELECT l.id, (l.debit - l.credit)::text AS amount, e.id AS entry_id, e.number, e.entry_date::text AS entry_date, e.description FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = $1 AND e.status = 'posted' AND e.entry_date <= $2::date AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.journal_line_id = l.id)
        ORDER BY e.entry_date, e.number`,
      [accountId, statementDate]
    )
  ).rows as Row[];
  const unclearedTotal = uncleared.reduce((s, r) => s + BigInt(r.amount), 0n);
  const unmatched = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM bank_statement_lines WHERE account_id = $1 AND status = 'unmatched' AND line_date <= $2::date", [accountId, statementDate])).rows[0]!.n;
  // The ledger follows the account's natural sign; statements show money in as positive for assets.
  const sign = account.normal_balance === "debit" ? 1n : -1n;
  const adjusted = (ledger - unclearedTotal) * sign;
  const stmt = statementBalance ? parseStatementAmount(statementBalance) : null;
  const history = (await client.query("SELECT statement_date::text AS statement_date, statement_balance::text, completed_by_label, created_at FROM bank_reconciliations WHERE account_id = $1 ORDER BY statement_date DESC LIMIT 12", [accountId])).rows as Row[];
  return {
    account: { id: account.id, code: account.code, name: account.name },
    statement_date: statementDate,
    ledger_balance: money(ledger * sign),
    uncleared: uncleared.map((u) => ({ journal_line_id: u.id, entry_id: u.entry_id, number: u.number, date: u.entry_date, description: u.description, amount: money(BigInt(u.amount) * sign) })),
    uncleared_total: money(unclearedTotal * sign),
    adjusted_balance: money(adjusted),
    statement_balance: stmt === null ? null : money(stmt),
    difference: stmt === null ? null : money(stmt - adjusted),
    unmatched_statement_lines: unmatched,
    reconciled_through: await reconciledThrough(client, accountId),
    can_complete: stmt !== null && stmt === adjusted && unmatched === 0,
    history: history.map((h) => ({ statement_date: h.statement_date, statement_balance: money(BigInt(h.statement_balance)), completed_by: h.completed_by_label, completed_at: h.created_at }))
  };
}

export async function completeReconciliation(client: Client, organizationId: string, environment: Environment, accountId: string, statementDate: string, statementBalance: string, actor: Actor) {
  const status = await reconciliationStatus(client, organizationId, environment, accountId, statementDate, statementBalance);
  if (status.unmatched_statement_lines > 0) throw new EngineError("unmatched_lines", `Match or exclude the ${status.unmatched_statement_lines} statement line${status.unmatched_statement_lines === 1 ? "" : "s"} dated on or before ${statementDate} first.`, 409);
  if (!status.can_complete) throw new EngineError("not_reconciled", `The ledger (less uncleared items) is ${status.adjusted_balance}; the statement says ${status.statement_balance}. Difference: ${status.difference}.`, 409);
  if (status.reconciled_through && statementDate <= status.reconciled_through) throw new EngineError("already_reconciled", `Already reconciled through ${status.reconciled_through}.`, 409);
  const stmt = parseStatementAmount(statementBalance)!;
  const acct = await accountById(client, organizationId, environment, accountId);
  const sign = acct.normal_balance === "debit" ? 1n : -1n;
  await client.query(
    `INSERT INTO bank_reconciliations (id, organization_id, environment, account_id, statement_date, statement_balance, ledger_balance, uncleared_total, completed_by_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId("bankReconciliation"), organizationId, environment, accountId, statementDate, stmt.toString(), (parseStatementAmount(status.ledger_balance)! * sign).toString(), (parseStatementAmount(status.uncleared_total)! * sign).toString(), actor.label ?? null]
  );
  await audit(client, actor, { organizationId, environment, action: "bank_reconciled", objectType: "ledger_account", objectId: accountId, next: { statement_date: statementDate, statement_balance: statementBalance } });
  return reconciliationStatus(client, organizationId, environment, accountId, statementDate, statementBalance);
}
