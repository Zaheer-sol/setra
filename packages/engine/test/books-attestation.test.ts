import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { resetNetworks } from "../../config/src";
import { BOOKS_ATTESTATION_ABI, BOOKS_V2_ABI, booksRoot, decodeStatements, decryptBooks, encodeStatements, encryptBooks } from "../../contracts-client/src";
import { closePools, withTenant } from "../../database/src";
import { startDevChain, type DevChain } from "../../devchain/src";
import { booksAttestationStatus, booksPublication, closePeriod, readBooksAttestation, recordBooksAttestation, reopenPeriod, simulatePayment } from "../src";
import { decodeEventLog, type Hex as H } from "viem";
import { workspace, type Workspace } from "../../../test/fixtures";

/**
 * Books on Monad, end to end against a real EVM node (Anvil) running the real SetraBooksAttestation
 * contract: close a month, publish its fingerprint from a wallet, and have Setra accept only an
 * attestation that matches the books exactly.
 */

let chain: DevChain;
let contract: Address;
let ws: Workspace;
const saved: Record<string, string | undefined> = {};
const ENV = ["LOCAL_CHAIN_ENABLED", "LOCAL_CHAIN_RPC_URL", "LOCAL_BOOKS_ATTESTATION_ADDRESS", "MONAD_TESTNET_BOOKS_ATTESTATION_ADDRESS"];

// The month before this one: it has ended, so it can be closed.
const now = new Date();
const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const month = previous.toISOString().slice(0, 7);
const inMonth = (day: number) => new Date(Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth(), day, 12));

const tenant = <T>(fn: (c: any) => Promise<T>) => withTenant(ws.orgId, fn);
const receive = (amount: string, day: number) => tenant((c) => simulatePayment(c, ws.orgId, "test", { scenario: "unknown", amount, finalize: true }, ws.actor, { at: inMonth(day) }));

async function publish(root: Hex, entryCount: number, from = 1): Promise<Hex> {
  const status = await tenant((c) => booksAttestationStatus(c, ws.orgId, "test", month));
  const hash = await chain.wallet(from).writeContract({ address: contract, abi: BOOKS_ATTESTATION_ABI, functionName: "attest", args: [status.book, status.period, root, entryCount], account: chain.accounts[from]!, chain: null });
  await chain.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  chain = await startDevChain({ port: 8900 + Math.floor(Math.random() * 90) });
  const artifact = JSON.parse(readFileSync(resolve(__dirname, "../../../contracts/out/SetraBooksAttestation.sol/SetraBooksAttestation.json"), "utf8"));
  const deploy = await chain.wallet(0).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, account: chain.accounts[0]!, chain: null });
  contract = (await chain.publicClient.waitForTransactionReceipt({ hash: deploy })).contractAddress!.toLowerCase() as Address;
  process.env.LOCAL_CHAIN_ENABLED = "true";
  process.env.LOCAL_CHAIN_RPC_URL = chain.rpcUrl;
  process.env.LOCAL_BOOKS_ATTESTATION_ADDRESS = contract;
  delete process.env.MONAD_TESTNET_BOOKS_ATTESTATION_ADDRESS;
  resetNetworks();

  ws = await workspace();
  await receive("125.00", 5);
  await receive("40.50", 18);
  await tenant((c) => closePeriod(c, ws.orgId, "test", month, ws.actor));
}, 60_000);

afterAll(async () => {
  chain?.stop();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetNetworks();
  await closePools();
});

describe("books on Monad", () => {
  it("fingerprints a closed month and shows where to publish it", async () => {
    const status = await tenant((c) => booksAttestationStatus(c, ws.orgId, "test", month));
    expect(status.state).toBe("unpublished");
    expect(status.closed).toBe(true);
    expect(status.entry_count).toBeGreaterThanOrEqual(2);
    expect(status.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(status.period).toBe(Number(month.replace("-", "")));
    expect(status.contract?.address).toBe(contract);
    // The fingerprint is deterministic.
    expect((await tenant((c) => booksAttestationStatus(c, ws.orgId, "test", month))).root).toBe(status.root);
  });

  it("records an attestation only after reading it back from the chain, once", async () => {
    const status = await tenant((c) => booksAttestationStatus(c, ws.orgId, "test", month));
    const hash = await publish(status.root, status.entry_count);
    const onchain = await readBooksAttestation("test", hash);
    expect(onchain.publisher).toBe(chain.accounts[1]!.address.toLowerCase());
    expect(onchain.version).toBe(1);

    const after = await tenant((c) => recordBooksAttestation(c, ws.orgId, "test", month, onchain, ws.actor));
    expect(after.state).toBe("published");
    expect(after.attestations).toHaveLength(1);
    expect(after.attestations[0]!.transaction_hash).toBe(hash.toLowerCase());

    const again = await tenant((c) => recordBooksAttestation(c, ws.orgId, "test", month, onchain, ws.actor));
    expect(again.attestations).toHaveLength(1);
  });

  it("refuses an attestation that doesn't match the books, or isn't an attestation at all", async () => {
    const status = await tenant((c) => booksAttestationStatus(c, ws.orgId, "test", month));
    const wrong = await publish(`0x${"ab".repeat(32)}`, status.entry_count, 2);
    const onchain = await readBooksAttestation("test", wrong);
    await expect(tenant((c) => recordBooksAttestation(c, ws.orgId, "test", month, onchain, ws.actor))).rejects.toMatchObject({ code: "books_changed" });

    const transfer = await chain.transferUsdc(1, chain.accounts[3]!.address, 1_000_000n);
    await expect(readBooksAttestation("test", transfer)).rejects.toMatchObject({ code: "not_an_attestation" });
    await expect(readBooksAttestation("test", `0x${"cd".repeat(32)}`)).rejects.toMatchObject({ code: "transaction_not_found" });
  });

  it("says the books changed after a published month is reopened and adjusted, until it's published again", async () => {
    await tenant((c) => reopenPeriod(c, ws.orgId, "test", month, "Late receipt recorded after close", ws.actor));
    await receive("9.99", 27);
    await tenant((c) => closePeriod(c, ws.orgId, "test", month, ws.actor));

    const changed = await tenant((c) => booksAttestationStatus(c, ws.orgId, "test", month));
    expect(changed.state).toBe("changed");

    const hash = await publish(changed.root, changed.entry_count);
    const onchain = await readBooksAttestation("test", hash);
    expect(onchain.version).toBe(2);
    const republished = await tenant((c) => recordBooksAttestation(c, ws.orgId, "test", month, onchain, ws.actor));
    expect(republished.state).toBe("published");
    expect(republished.attestations.map((a) => a.version)).toEqual([2, 1]);
  });

  it("publishes the books themselves, encrypted, with public statements, and an outsider can read and check them from the chain", async () => {
    const pub = await tenant((c) => booksPublication(c, ws.orgId, "test", month));
    expect(pub.document.entries).toHaveLength(pub.entry_count);
    expect(pub.statements.root).toBe(pub.root);
    expect(Number(pub.statements.revenue)).toBeGreaterThanOrEqual(0);

    const passphrase = "correct horse battery staple";
    const encrypted = await encryptBooks(pub.document, passphrase);
    const hash = await chain.wallet(1).writeContract({ address: contract, abi: BOOKS_V2_ABI, functionName: "publish", args: [pub.book, pub.period, pub.root, pub.entry_count, encrypted, encodeStatements(pub.statements)], account: chain.accounts[1]!, chain: null });
    await chain.publicClient.waitForTransactionReceipt({ hash });

    const onchain = await readBooksAttestation("test", hash);
    expect(onchain.encryptedBooks).toBe(true);
    expect(onchain.statements?.net_income).toBe(pub.statements.net_income);
    const status = await tenant((c) => recordBooksAttestation(c, ws.orgId, "test", month, onchain, ws.actor));
    expect(status.state).toBe("published");
    expect(status.attestations[0]).toMatchObject({ encrypted_books: true, statements: { business: pub.business, root: pub.root } });

    // An outsider: nothing but the transaction, the chain and the passphrase.
    const receipt = await chain.publicClient.getTransactionReceipt({ hash });
    const event = receipt.logs.map((l) => { try { return decodeEventLog({ abi: BOOKS_V2_ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === "BooksPublished")!;
    const args = event.args as { encryptedBooks: H; statements: H };
    const books = await decryptBooks(args.encryptedBooks, passphrase);
    expect(booksRoot(books.entries, books.book, books.period)).toBe(pub.root);
    expect(decodeStatements(args.statements)?.root).toBe(pub.root);
    await expect(decryptBooks(args.encryptedBooks, "not the passphrase")).rejects.toThrow();
  });
});
