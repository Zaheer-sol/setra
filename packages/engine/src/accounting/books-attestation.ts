import { networks } from "@setra/config";
import { BOOKS_ATTESTATION_ABI } from "@setra/contracts-client";
import { type Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { createPublicClient, decodeEventLog, http, keccak256, stringToHex, type Hex } from "viem";
import { audit, EngineError, type Actor } from "../context";
import { monthBounds } from "./periods";

/**
 * Books on Monad: a business publishes the fingerprint of a closed month from its own wallet
 * (SetraBooksAttestation), and anyone it shares its books with can check they're the ones it vouched
 * for. The fingerprint is a Merkle root over the month's posted journal entries, so the entries stay
 * private while any single entry can later be proven to belong to the attested books.
 */

type Row = Record<string, any>;

/** The set of books an attestation is about: one per workspace and mode. */
export const bookIdOf = (organizationId: string, environment: Environment): Hex => keccak256(stringToHex(`setra-books:${organizationId}:${environment}`));

/** The month as the contract stores it: 2026-08 → 202608. */
export const periodNumber = (month: string): number => Number(month.replace("-", ""));

/** One leaf per posted entry: its identity, date, source and every line (account, debit, credit). */
function entryLeaf(e: Row, lines: Row[]): Hex {
  const parts = ["setra-entry-v1", e.id, e.number, e.entry_date, e.source_type ?? "", e.source_id ?? "", e.reverses_entry_id ?? "", ...lines.map((l) => `${l.position}:${l.account_id}:${l.debit}:${l.credit}`)];
  return keccak256(stringToHex(parts.join("|")));
}

/** Merkle root with sorted pairs (order-independent proofs), carrying an odd node up unchanged. */
export function merkleRoot(leaves: Hex[]): Hex | null {
  if (!leaves.length) return null;
  let level = leaves;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1];
      if (!b) next.push(a);
      else next.push(keccak256(a < b ? `${a}${b.slice(2)}` : `${b}${a.slice(2)}`));
    }
    level = next;
  }
  return level[0]!;
}

export interface BooksFingerprint {
  month: string;
  book: Hex;
  period: number;
  root: Hex;
  entry_count: number;
  closed: boolean;
}

/** The fingerprint of a month's books as they stand now. Only a closed month can be attested. */
export async function booksFingerprint(client: Client, organizationId: string, environment: Environment, month: string): Promise<BooksFingerprint> {
  const { start, end } = monthBounds(month);
  const period = (await client.query("SELECT status FROM accounting_periods WHERE organization_id = $1 AND environment = $2 AND start_date = $3", [organizationId, environment, start])).rows[0] as Row | undefined;
  const entries = (
    await client.query(
      `SELECT id, number, entry_date::text AS entry_date, source_type, source_id, reverses_entry_id FROM journal_entries
        WHERE organization_id = $1 AND environment = $2 AND status = 'posted' AND entry_date BETWEEN $3::date AND $4::date ORDER BY id`,
      [organizationId, environment, start, end]
    )
  ).rows as Row[];
  const lines = new Map<string, Row[]>();
  for (const l of (await client.query("SELECT entry_id, position, account_id, debit::text AS debit, credit::text AS credit FROM journal_lines WHERE entry_id = ANY($1) ORDER BY entry_id, position", [entries.map((e) => e.id)])).rows as Row[]) {
    const list = lines.get(l.entry_id);
    if (list) list.push(l);
    else lines.set(l.entry_id, [l]);
  }
  const book = bookIdOf(organizationId, environment);
  const root = merkleRoot(entries.map((e) => entryLeaf(e, lines.get(e.id) ?? []))) ?? keccak256(stringToHex(`setra-books-empty:${book}:${periodNumber(month)}`));
  return { month, book, period: periodNumber(month), root, entry_count: entries.length, closed: period?.status === "closed" };
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
  recorded_by: a.recorded_by_label
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
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== target.contract) continue;
    try {
      const event = decodeEventLog({ abi: BOOKS_ATTESTATION_ABI, data: log.data, topics: log.topics });
      if (event.eventName !== "BooksAttested") continue;
      const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
      return {
        chainId: target.network.chainId,
        contract: target.contract,
        publisher: event.args.publisher.toLowerCase(),
        book: event.args.book,
        period: event.args.period,
        root: event.args.root,
        entryCount: event.args.entryCount,
        version: event.args.version,
        blockNumber: receipt.blockNumber,
        publishedAt: new Date(Number(block.timestamp) * 1000),
        transactionHash: hash
      };
    } catch {
      // Not a BooksAttested log.
    }
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
    `INSERT INTO books_attestations (id, organization_id, environment, period_start, book_id, root, entry_count, version, chain_id, contract_address, publisher, transaction_hash, block_number, published_at, recorded_by, recorded_by_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (chain_id, transaction_hash) DO NOTHING`,
    [newId("booksAttestation"), organizationId, environment, monthBounds(month).start, onchain.book, onchain.root, onchain.entryCount, onchain.version, onchain.chainId, onchain.contract, onchain.publisher, onchain.transactionHash, onchain.blockNumber.toString(), onchain.publishedAt, actor.id ?? null, actor.label ?? null]
  );
  if (inserted.rowCount) {
    await audit(client, actor, { organizationId, environment, action: "books_attested", objectType: "accounting_period", objectId: month, next: { root: onchain.root, transaction_hash: onchain.transactionHash, publisher: onchain.publisher, version: onchain.version } });
  }
  return booksAttestationStatus(client, organizationId, environment, month);
}
