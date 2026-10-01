import { bytesToHex, hexToBytes, keccak256, stringToHex, type Hex } from "viem";

/**
 * Books on Monad, shared by the server, the console and the public verify page so a fingerprint
 * means the same thing everywhere: how an entry becomes a Merkle leaf, how leaves become the root,
 * and the formats of the encrypted books and public statements carried by SetraBooksAttestation.
 */

export interface BooksLine {
  position: number;
  account_id: string;
  /** Debit and credit in reporting micro-units (6 decimals), as integer strings. */
  debit: string;
  credit: string;
  account_code?: string;
  account_name?: string;
  memo?: string | null;
}

export interface BooksEntry {
  id: string;
  number: string;
  entry_date: string;
  source_type: string | null;
  source_id: string | null;
  reverses_entry_id: string | null;
  description?: string | null;
  lines: BooksLine[];
}

/** The month's books as published (inside the encryption). */
export interface BooksDocument {
  v: 1;
  business: string;
  month: string;
  book: Hex;
  period: number;
  entries: BooksEntry[];
}

/** Public statements: totals anyone can read. Amounts are decimal strings in the reporting currency. */
export interface BooksStatements {
  v: 1;
  business: string;
  month: string;
  basis: "accrual" | "cash";
  currency: string;
  revenue: string;
  expenses: string;
  net_income: string;
  cash_opening: string;
  cash_closing: string;
  assets: string;
  liabilities: string;
  equity: string;
  entry_count: number;
  root: Hex;
}

export const booksIdOf = (organizationId: string, environment: string): Hex => keccak256(stringToHex(`setra-books:${organizationId}:${environment}`));

/** One leaf per posted entry: its identity, date, source and every line (account, debit, credit). */
export function booksEntryLeaf(e: BooksEntry): Hex {
  const parts = ["setra-entry-v1", e.id, e.number, e.entry_date, e.source_type ?? "", e.source_id ?? "", e.reverses_entry_id ?? "", ...[...e.lines].sort((a, b) => a.position - b.position).map((l) => `${l.position}:${l.account_id}:${l.debit}:${l.credit}`)];
  return keccak256(stringToHex(parts.join("|")));
}

/** Merkle root with sorted pairs (order-independent proofs), carrying an odd node up unchanged. */
export function booksMerkleRoot(leaves: Hex[]): Hex | null {
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

/** The fingerprint of a month's entries (entries sorted by id), or the empty-month marker. */
export function booksRoot(entries: BooksEntry[], book: Hex, period: number): Hex {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return booksMerkleRoot(sorted.map(booksEntryLeaf)) ?? keccak256(stringToHex(`setra-books-empty:${book}:${period}`));
}

// ── Encrypted books ─────────────────────────────────────────────────────────────────────────────
//
// Format v1: "SB" 0x01 | salt (16) | iv (12) | AES-256-GCM(gzip(JSON(BooksDocument))).
// The key is PBKDF2-SHA256 (600,000 iterations) of the passphrase the business chose. Encryption and
// decryption happen in the browser (or any WebCrypto runtime); the passphrase never reaches Setra.

const MAGIC = [0x53, 0x42, 0x01];
const ITERATIONS = 600_000;

const subtle = () => {
  const c = globalThis.crypto?.subtle;
  if (!c) throw new Error("This browser can't encrypt or decrypt (WebCrypto is unavailable).");
  return c;
};

// WebCrypto wants buffers backed by a plain ArrayBuffer; copying guarantees that.
const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

async function deriveKey(passphrase: string, salt: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations: ITERATIONS }, base, { name: "AES-GCM", length: 256 }, false, [usage]);
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([buf(data)]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encryptBooks(doc: BooksDocument, passphrase: string): Promise<Hex> {
  if (passphrase.length < 12) throw new Error("Use a passphrase of at least 12 characters.");
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const compressed = await pipe(new TextEncoder().encode(JSON.stringify(doc)), new CompressionStream("gzip"));
  const key = await deriveKey(passphrase, salt, "encrypt");
  const cipher = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(compressed)));
  const out = new Uint8Array(MAGIC.length + salt.length + iv.length + cipher.length);
  out.set(MAGIC, 0);
  out.set(salt, 3);
  out.set(iv, 19);
  out.set(cipher, 31);
  return bytesToHex(out);
}

export async function decryptBooks(payload: Hex, passphrase: string): Promise<BooksDocument> {
  const bytes = hexToBytes(payload);
  if (bytes.length < 32 || bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2]) throw new Error("This isn't a Setra encrypted-books payload.");
  const key = await deriveKey(passphrase, bytes.slice(3, 19), "decrypt");
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: buf(bytes.slice(19, 31)) }, key, buf(bytes.slice(31))));
  } catch {
    throw new Error("That passphrase doesn't open these books.");
  }
  return JSON.parse(new TextDecoder().decode(await pipe(plain, new DecompressionStream("gzip")))) as BooksDocument;
}

export const encodeStatements = (s: BooksStatements): Hex => stringToHex(JSON.stringify(s));
export function decodeStatements(payload: Hex): BooksStatements | null {
  if (!payload || payload === "0x") return null;
  return JSON.parse(new TextDecoder().decode(hexToBytes(payload))) as BooksStatements;
}

/** SetraBooksAttestation v2: attest, publish, and their events. */
export const BOOKS_V2_ABI = [
  {
    type: "function",
    name: "attest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "book", type: "bytes32" },
      { name: "period", type: "uint32" },
      { name: "root", type: "bytes32" },
      { name: "entryCount", type: "uint32" }
    ],
    outputs: [{ name: "version", type: "uint32" }]
  },
  {
    type: "function",
    name: "publish",
    stateMutability: "nonpayable",
    inputs: [
      { name: "book", type: "bytes32" },
      { name: "period", type: "uint32" },
      { name: "root", type: "bytes32" },
      { name: "entryCount", type: "uint32" },
      { name: "encryptedBooks", type: "bytes" },
      { name: "statements", type: "bytes" }
    ],
    outputs: [{ name: "version", type: "uint32" }]
  },
  {
    type: "event",
    name: "BooksAttested",
    anonymous: false,
    inputs: [
      { name: "publisher", type: "address", indexed: true },
      { name: "book", type: "bytes32", indexed: true },
      { name: "period", type: "uint32", indexed: true },
      { name: "root", type: "bytes32", indexed: false },
      { name: "entryCount", type: "uint32", indexed: false },
      { name: "version", type: "uint32", indexed: false }
    ]
  },
  {
    type: "event",
    name: "BooksPublished",
    anonymous: false,
    inputs: [
      { name: "publisher", type: "address", indexed: true },
      { name: "book", type: "bytes32", indexed: true },
      { name: "period", type: "uint32", indexed: true },
      { name: "version", type: "uint32", indexed: false },
      { name: "encryptedBooks", type: "bytes", indexed: false },
      { name: "statements", type: "bytes", indexed: false }
    ]
  }
] as const;
