import { describe, expect, it } from "vitest";
import { hexToBytes, bytesToHex } from "viem";
import { booksEntryLeaf, booksIdOf, booksRoot, decodeStatements, decryptBooks, encodeStatements, encryptBooks, type BooksDocument, type BooksEntry } from "./books";

const entry = (id: string, debit = "1000000"): BooksEntry => ({
  id,
  number: `JE-${id}`,
  entry_date: "2026-09-12",
  source_type: "payment",
  source_id: `pay_${id}`,
  reverses_entry_id: null,
  description: "Payment received",
  lines: [
    { position: 2, account_id: "acct_revenue", debit: "0", credit: debit, account_code: "4000", account_name: "Sales" },
    { position: 1, account_id: "acct_cash", debit, credit: "0", account_code: "1010", account_name: "Wallet" }
  ]
});

const book = booksIdOf("org_1", "test");
const doc: BooksDocument = { v: 1, business: "Café Nova", month: "2026-09", book, period: 202609, entries: [entry("je_02"), entry("je_01", "2500000")] };

describe("books fingerprint", () => {
  it("doesn't depend on the order entries or lines arrive in", () => {
    const reordered = doc.entries.map((e) => ({ ...e, lines: [...e.lines].reverse() })).reverse();
    expect(booksRoot(reordered, book, 202609)).toBe(booksRoot(doc.entries, book, 202609));
  });

  it("changes when any amount changes, and marks an empty month distinctly", () => {
    const changed = [entry("je_02"), entry("je_01", "2500001")];
    expect(booksRoot(changed, book, 202609)).not.toBe(booksRoot(doc.entries, book, 202609));
    expect(booksRoot([], book, 202609)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(booksRoot([], book, 202609)).not.toBe(booksRoot([], book, 202610));
  });

  it("covers the entry's identity, source and every line", () => {
    const base = booksEntryLeaf(entry("je_01"));
    expect(booksEntryLeaf({ ...entry("je_01"), source_id: "pay_other" })).not.toBe(base);
    expect(booksEntryLeaf({ ...entry("je_01"), entry_date: "2026-09-13" })).not.toBe(base);
    // Display fields (names, memos, descriptions) aren't part of the fingerprint.
    expect(booksEntryLeaf({ ...entry("je_01"), description: "Renamed" })).toBe(base);
  });
});

describe("encrypted books", () => {
  it("round-trips with the right passphrase and refuses the wrong one", async () => {
    const payload = await encryptBooks(doc, "correct horse battery staple");
    expect(payload.startsWith("0x534201")).toBe(true);
    expect(await decryptBooks(payload, "correct horse battery staple")).toEqual(doc);
    await expect(decryptBooks(payload, "wrong passphrase!!")).rejects.toThrow(/doesn't open/);
  });

  it("detects tampering and refuses short passphrases", async () => {
    const payload = hexToBytes(await encryptBooks(doc, "correct horse battery staple"));
    payload[payload.length - 1]! ^= 1;
    await expect(decryptBooks(bytesToHex(payload), "correct horse battery staple")).rejects.toThrow();
    await expect(encryptBooks(doc, "short")).rejects.toThrow(/12 characters/);
  });
});

describe("public statements", () => {
  it("round-trip as readable JSON", () => {
    const s = { v: 1 as const, business: "Café Nova", month: "2026-09", basis: "accrual" as const, currency: "USD", revenue: "3500.00", expenses: "0.00", net_income: "3500.00", cash_opening: "0.00", cash_closing: "3500.00", assets: "3500.00", liabilities: "0.00", equity: "3500.00", entry_count: 2, root: booksRoot(doc.entries, book, 202609) };
    expect(decodeStatements(encodeStatements(s))).toEqual(s);
    expect(decodeStatements("0x")).toBeNull();
  });
});
