import { networks } from "@setra/config";
import { BOOKS_V2_ABI, booksIdOf, booksRoot, decodeStatements, type BooksEntry, type BooksStatements } from "@setra/contracts-client";
import { type Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { createPublicClient, decodeEventLog, http, type Hex } from "viem";
import { audit, EngineError, type Actor } from "../context";
import { monthBounds } from "./periods";
import { balanceSheet, cashFlow, money, profitAndLoss } from "./reports";

/**
 * Books on Monad: a business publishes a closed month from its own wallet (SetraBooksAttestation):
 * always the fingerprint (a Merkle root over the month's posted journal entries), and optionally the
 * books themselves, encrypted in its browser with a passphrase Setra never sees, and public statements
 * (totals anyone can read). Anyone it shares the passphrase with can read the books straight from the
 * chain and check them against the fingerprint. Leaf, root and payload formats live in
 * @setra/contracts-client so the console and the public verify page compute exactly the same thing.
 */

type Row = Record<string, any>;

/** The set of books an attestation is about: one per workspace and mode. */
export const bookIdOf = (organizationId: string, environment: Environment): Hex => booksIdOf(organizationId, environment);

/** The month as the contract stores it: 2026-08 → 202608. */
export const periodNumber = (month: string): number => Number(month.replace("-", ""));

export interface BooksFingerprint {
  month: string;
  book: Hex;
  period: number;
  root: Hex;
  entry_count: number;
  closed: boolean;
}

/** The month's posted entries with every line, as they're fingerprinted and published. */
async function monthEntries(client: Client, organizationId: string, environment: Environment, month: string): Promise<BooksEntry[]> {
  const { start, end } = monthBounds(month);
  const entries = (
    await client.query(
      `SELECT id, number, entry_date::text AS entry_date, source_type, source_id, reverses_entry_id, description FROM journal_entries
        WHERE organization_id = $1 AND environment = $2 AND status = 'posted' AND entry_date BETWEEN $3::date AND $4::date ORDER BY id`,
      [organizationId, environment, start, end]
    )
  ).rows as Row[];
  const lines = new Map<string, BooksEntry["lines"]>();
  for (const l of (
    await client.query(
      `SELECT l.entry_id, l.position, l.account_id, l.debit::text AS debit, l.credit::text AS credit, l.memo, a.code AS account_code, a.name AS account_name
         FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id WHERE l.entry_id = ANY($1) ORDER BY l.entry_id, l.position`,
      [entries.map((e) => e.id)]
    )
  ).rows as Row[]) {
    const line = { position: l.position, account_id: l.account_id, debit: l.debit, credit: l.credit, account_code: l.account_code, account_name: l.account_name, memo: l.memo };
    const list = lines.get(l.entry_id);
    if (list) list.push(line);
    else lines.set(l.entry_id, [line]);
  }
  return entries.map((e) => ({ id: e.id, number: e.number, entry_date: e.entry_date, source_type: e.source_type, source_id: e.source_id, reverses_entry_id: e.reverses_entry_id, description: e.description, lines: lines.get(e.id) ?? [] }));
}

/** The fingerprint of a month's books as they stand now. Only a closed month can be attested. */
export async function booksFingerprint(client: Client, organizationId: string, environment: Environment, month: string): Promise<BooksFingerprint> {
  const { start } = monthBounds(month);
  const period = (await client.query("SELECT status FROM accounting_periods WHERE organization_id = $1 AND environment = $2 AND start_date = $3", [organizationId, environment, start])).rows[0] as Row | undefined;
  const entries = await monthEntries(client, organizationId, environment, month);
  const book = bookIdOf(organizationId, environment);
  return { month, book, period: periodNumber(month), root: booksRoot(entries, book, periodNumber(month)), entry_count: entries.length, closed: period?.status === "closed" };
}

/**
 * Everything a publication can carry: the fingerprint, the month's entries (to be encrypted in the
 * browser) and the public statements, which come from the same reports the console shows.
 */
export async function booksPublication(client: Client, organizationId: string, environment: Environment, month: string) {
  const fingerprint = await booksFingerprint(client, organizationId, environment, month);
  if (!fingerprint.closed) throw new EngineError("period_not_closed", "Close the month before publishing its books.", 409);
  const { start, end } = monthBounds(month);
  const entries = await monthEntries(client, organizationId, environment, month);
  const org = (await client.query<{ name: string; method: "accrual" | "cash" | null }>("SELECT o.name, s.method FROM organizations o LEFT JOIN accounting_settings s ON s.organization_id = o.id AND s.environment = $2 WHERE o.id = $1", [organizationId, environment])).rows[0];
  const pl = await profitAndLoss(client, organizationId, environment, start, end);
  const bs = await balanceSheet(client, organizationId, environment, end);
  const cf = await cashFlow(client, organizationId, environment, start, end);
  const business = org?.name ?? "Workspace";
  const statements: BooksStatements = {
    v: 1,
    business,
    month,
    basis: org?.method ?? "accrual",
    currency: "USD",
    revenue: pl.revenue.total,
    expenses: money(pl.raw.cogs + pl.raw.expenses),
    net_income: pl.net_income,
    cash_opening: cf.opening_balance,
    cash_closing: cf.closing_balance,
    assets: bs.assets.total,
    liabilities: bs.liabilities.total,
    equity: bs.equity.total,
    entry_count: fingerprint.entry_count,
    root: fingerprint.root
  };
  return { ...fingerprint, business, document: { v: 1 as const, business, month, book: fingerprint.book, period: fingerprint.period, entries }, statements };
}

/** Monad for the mode; in test mode, a local devnet with the contract deployed (development and tests) when Monad has none. */
function attestationNetwork(environment: Environment) {
  const network = [networks().resolve("monad", environment), ...(environment === "test" ? [networks().resolve("local", "test")] : [])].find((n) => n?.booksAttestation);
  if (!network?.booksAttestation) return null;
  return { network, contract: network.booksAttestation };
}

const serializeAttestation = (a: Row, explorerUrl: string | null) => ({
  id: a.id,
  root: a.root,
  entry_count: a.entry_count,
  version: a.version,
  publisher: a.publisher,
  transaction_hash: a.transaction_hash,
  explorer_url: explorerUrl ? `${explorerUrl.replace(/\/$/, "")}/tx/${a.transaction_hash}` : null,
  block_number: String(a.block_number),
  published_at: a.published_at,
  recorded_by: a.recorded_by_label,
  encrypted_books: a.has_encrypted_books,
  statements: a.statements ?? null
});

/**
 * Where a month stands on Monad: not closed yet, closed but unpublished, published and matching the
 * books, or published but the books have changed since (the month was reopened and adjusted).
 */
export async function booksAttestationStatus(client: Client, organizationId: string, environment: Environment, month: string) {
  const fingerprint = await booksFingerprint(client, organizationId, environment, month);
  const target = attestationNetwork(environment);
  const rows = (await client.query("SELECT * FROM books_attestations WHERE organization_id = $1 AND environment = $2 AND period_start = $3 ORDER BY block_number DESC, version DESC", [organizationId, environment, monthBounds(month).start])).rows as Row[];
  const latest = rows[0];
  const state = !fingerprint.closed ? "not_closed" : !latest ? "unpublished" : latest.root === fingerprint.root ? "published" : "changed";
  return {
    ...fingerprint,
    state,
    contract: target ? { chain_id: target.network.chainId, network: target.network.name, address: target.contract, rpc_url: target.network.publicRpcUrl, explorer_url: target.network.explorerUrl ?? null } : null,
    attestations: rows.map((a) => serializeAttestation(a, target?.network.explorerUrl ?? null))
  };
}

export interface OnchainAttestation {
  chainId: number;
  contract: string;
  publisher: string;
  book: Hex;
  period: number;
  root: Hex;
  entryCount: number;
  version: number;
  blockNumber: bigint;
  publishedAt: Date;
  transactionHash: Hex;
  /** Whether the transaction also carried the books, encrypted. */
  encryptedBooks: boolean;
  /** Public statements the transaction carried, if any. */
  statements: BooksStatements | null;
}

/** Read an attestation back from Monad. No database access, so it runs outside any transaction. */
export async function readBooksAttestation(environment: Environment, transactionHash: string): Promise<OnchainAttestation> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new EngineError("invalid_transaction", "That isn't a transaction hash.", 422);
  const target = attestationNetwork(environment);
  if (!target) throw new EngineError("attestation_not_configured", "Publishing books on Monad isn't set up for this mode yet.", 409);
  const chain = createPublicClient({ transport: http(target.network.rpcUrl) });
  const hash = transactionHash.toLowerCase() as Hex;
  const receipt = await chain.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) throw new EngineError("transaction_not_found", "Monad doesn't have this transaction yet. Try again in a moment.", 404);
  if (receipt.status !== "success") throw new EngineError("transaction_failed", "That transaction failed on Monad, so nothing was published.", 422);
  // A publication emits BooksAttested and, when it carries the books or statements, BooksPublished.
  let attested: { publisher: string; book: Hex; period: number; root: Hex; entryCount: number; version: number } | null = null;
  let published: { encryptedBooks: Hex; statements: Hex } | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== target.contract) continue;
    try {
      const event = decodeEventLog({ abi: BOOKS_V2_ABI, data: log.data, topics: log.topics });
      if (event.eventName === "BooksAttested") attested = { ...event.args, publisher: event.args.publisher.toLowerCase() };
      if (event.eventName === "BooksPublished") published = { encryptedBooks: event.args.encryptedBooks, statements: event.args.statements };
    } catch {
      // Not one of the contract's events.
    }
  }
  if (attested) {
    let statements: BooksStatements | null = null;
    try {
      statements = published ? decodeStatements(published.statements) : null;
    } catch {
      throw new EngineError("statements_unreadable", "The statements in that transaction aren't readable.", 422);
    }
    if (statements && statements.root !== attested.root) throw new EngineError("statements_mismatch", "The statements in that transaction don't belong to the books it attests.", 422);
    const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
    return {
      chainId: target.network.chainId,
      contract: target.contract,
      ...attested,
      blockNumber: receipt.blockNumber,
      publishedAt: new Date(Number(block.timestamp) * 1000),
      transactionHash: hash,
      encryptedBooks: !!published && published.encryptedBooks !== "0x",
      statements
    };
  }
  throw new EngineError("not_an_attestation", "That transaction didn't publish books to Setra's attestation contract.", 422);
}

/** Record an attestation read from Monad, after checking it's exactly these books, for this month. */
export async function recordBooksAttestation(client: Client, organizationId: string, environment: Environment, month: string, onchain: OnchainAttestation, actor: Actor) {
  const fingerprint = await booksFingerprint(client, organizationId, environment, month);
  if (!fingerprint.closed) throw new EngineError("period_not_closed", "Close the month before publishing its books.", 409);
  if (onchain.book !== fingerprint.book || onchain.period !== fingerprint.period) throw new EngineError("attestation_mismatch", "That transaction is about a different set of books or a different month.", 422);
  if (onchain.root !== fingerprint.root || onchain.entryCount !== fingerprint.entry_count) {
    throw new EngineError("books_changed", "That transaction published a different fingerprint than these books have now. Publish again from this page.", 422);
  }
  const inserted = await client.query(
    `INSERT INTO books_attestations (id, organization_id, environment, period_start, book_id, root, entry_count, version, chain_id, contract_address, publisher, transaction_hash, block_number, published_at, recorded_by, recorded_by_label, has_encrypted_books, statements)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (chain_id, transaction_hash) DO NOTHING`,
    [newId("booksAttestation"), organizationId, environment, monthBounds(month).start, onchain.book, onchain.root, onchain.entryCount, onchain.version, onchain.chainId, onchain.contract, onchain.publisher, onchain.transactionHash, onchain.blockNumber.toString(), onchain.publishedAt, actor.id ?? null, actor.label ?? null, onchain.encryptedBooks, onchain.statements ? JSON.stringify(onchain.statements) : null]
  );
  if (inserted.rowCount) {
    await audit(client, actor, { organizationId, environment, action: "books_attested", objectType: "accounting_period", objectId: month, next: { root: onchain.root, transaction_hash: onchain.transactionHash, publisher: onchain.publisher, version: onchain.version, encrypted_books: onchain.encryptedBooks, statements: !!onchain.statements } });
  }
  return booksAttestationStatus(client, organizationId, environment, month);
}
