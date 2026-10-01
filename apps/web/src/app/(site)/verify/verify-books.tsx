"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { createPublicClient, decodeEventLog, http, type Hex } from "viem";
import { CheckCircle2, Download, Lock, ShieldCheck, XCircle } from "lucide-react";
import { BOOKS_V2_ABI, booksRoot, decodeStatements, decryptBooks, type BooksDocument, type BooksStatements } from "@setra/contracts-client";
import { Alert, Button, Card, CardBody, Field, Input } from "@/components/app-ui";
import { wrap } from "@/components/marketing";
import { money } from "@/lib/format";

interface BooksContract {
  chain_id: number;
  network: string;
  address: string;
  previous?: string[];
  rpc_url: string;
  explorer_url: string | null;
}

interface Publication {
  contract: BooksContract;
  official: boolean;
  transaction: Hex;
  publisher: string;
  book: Hex;
  period: number;
  root: Hex;
  entryCount: number;
  version: number;
  latestVersion: number;
  publishedAt: Date;
  encryptedBooks: Hex | null;
  statements: BooksStatements | null;
}

const monthLabel = (period: number) => new Date(Date.UTC(Math.floor(period / 100), (period % 100) - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** Ledger micro-units (6 decimals, integer string) as a decimal string. */
const micro = (v: string) => {
  const n = BigInt(v);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  return `${neg ? "-" : ""}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
};

/**
 * Public verification of books published on Monad. Everything here runs in the visitor's browser
 * against the chain itself: the transaction, the contract's record and, with the passphrase, the
 * decrypted books, whose fingerprint is recomputed and compared. Setra's servers only supply the list
 * of its official contract addresses.
 */
export function VerifyBooks() {
  const params = useSearchParams();
  const [contracts, setContracts] = useState<BooksContract[] | null>(null);
  const [tx, setTx] = useState(params.get("tx") ?? "");
  const [chainId, setChainId] = useState<number | null>(params.get("chain") ? Number(params.get("chain")) : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pub, setPub] = useState<Publication | null>(null);

  useEffect(() => {
    fetch("/api/v1/public/books-contracts")
      .then((r) => r.json())
      .then((j: { data: BooksContract[] }) => setContracts(j.data))
      .catch(() => setContracts([]));
  }, []);

  useEffect(() => {
    if (contracts && params.get("tx")) void look();
    // Run once the official contracts are known, for a link that already names a transaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts]);

  async function look() {
    setError(null);
    setPub(null);
    const hash = tx.trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) {
      setError("Paste a transaction hash (0x followed by 64 characters).");
      return;
    }
    const contract = contracts?.find((c) => c.chain_id === chainId) ?? contracts?.[0];
    if (!contract) {
      setError("No Monad network is available to check against.");
      return;
    }
    setLoading(true);
    try {
      const client = createPublicClient({ transport: http(contract.rpc_url) });
      const receipt = await client.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
      if (!receipt) throw new Error(`${contract.network} doesn't have this transaction. Check the hash and the network.`);
      let attested: Omit<Publication, "contract" | "official" | "transaction" | "latestVersion" | "publishedAt" | "encryptedBooks" | "statements"> | null = null;
      let published: { encryptedBooks: Hex; statements: Hex } | null = null;
      let from: string | null = null;
      for (const log of receipt.logs) {
        try {
          const e = decodeEventLog({ abi: BOOKS_V2_ABI, data: log.data, topics: log.topics });
          if (e.eventName === "BooksAttested") {
            attested = { publisher: e.args.publisher, book: e.args.book, period: e.args.period, root: e.args.root, entryCount: e.args.entryCount, version: e.args.version };
            from = log.address.toLowerCase();
          }
          if (e.eventName === "BooksPublished") published = { encryptedBooks: e.args.encryptedBooks, statements: e.args.statements };
        } catch {
          // Not a books event.
        }
      }
      if (!attested || !from) throw new Error("This transaction didn't publish any books.");
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      const latest = (await client.readContract({
        address: from as Hex,
        abi: [{ type: "function", name: "latest", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }, { type: "uint32" }], outputs: [{ type: "tuple", components: [{ name: "root", type: "bytes32" }, { name: "entryCount", type: "uint32" }, { name: "version", type: "uint32" }, { name: "publishedAt", type: "uint64" }] }] }],
        functionName: "latest",
        args: [attested.publisher as Hex, attested.book, attested.period]
      })) as { version: number };
      setPub({
        ...attested,
        contract,
        official: [contract.address, ...(contract.previous ?? [])].some((a) => a.toLowerCase() === from),
        transaction: hash as Hex,
        latestVersion: latest.version,
        publishedAt: new Date(Number(block.timestamp) * 1000),
        encryptedBooks: published && published.encryptedBooks !== "0x" ? published.encryptedBooks : null,
        statements: published ? decodeStatements(published.statements) : null
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="py-16 max-md:py-10">
      <div className={`${wrap} grid max-w-[860px] gap-6`}>
        <header className="grid gap-2">
          <h1 className="text-[clamp(2rem,4vw,2.75rem)] leading-tight font-bold tracking-[-0.03em]">Verify books on Monad</h1>
          <p className="text-[1.0625rem] text-muted-foreground">
            Check a month of books a business published with Setra. This page reads Monad directly from your browser. With the passphrase the business gave you, it opens the books and confirms they match what was published.
          </p>
        </header>

        <Card>
          <CardBody className="grid gap-3">
            <Field label="Transaction" htmlFor="verify-tx" hint="The publication's transaction hash, from the business or its Verify link.">
              <Input id="verify-tx" value={tx} onChange={(e) => setTx(e.target.value)} placeholder="0x…" spellCheck={false} className="font-mono" />
            </Field>
            {contracts && contracts.length > 1 && (
              <Field label="Network" htmlFor="verify-chain">
                <select id="verify-chain" className="h-9 rounded-md border bg-transparent px-2" value={chainId ?? contracts[0]!.chain_id} onChange={(e) => setChainId(Number(e.target.value))}>
                  {contracts.map((c) => (
                    <option key={c.chain_id} value={c.chain_id}>
                      {c.network}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div>
              <Button variant="primary" loading={loading} onClick={look} disabled={!contracts}>
                Check on Monad
              </Button>
            </div>
            {error && <Alert tone="danger">{error}</Alert>}
          </CardBody>
        </Card>

        {pub && <PublicationView pub={pub} />}
      </div>
    </section>
  );
}

function PublicationView({ pub }: { pub: Publication }) {
  const explorer = pub.contract.explorer_url ? `${pub.contract.explorer_url.replace(/\/$/, "")}/tx/${pub.transaction}` : null;
  return (
    <>
      <Card title={`${monthLabel(pub.period)}, published on ${pub.contract.network}`} description={`${pub.publishedAt.toUTCString().replace(" GMT", " UTC")}`}>
        <CardBody className="grid gap-3 text-sm">
          {pub.official ? (
            <p className="inline-flex items-center gap-2 font-medium text-success">
              <ShieldCheck className="size-4" aria-hidden="true" /> Published through Setra&apos;s books contract
            </p>
          ) : (
            <Alert tone="warning" title="Not Setra's contract">
              These events came from a contract Setra doesn&apos;t recognize. Treat them as unverified.
            </Alert>
          )}
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <Row k="Signed by" v={<span className="font-mono">{pub.publisher}</span>} />
            <Row k="Posted entries" v={String(pub.entryCount)} />
            <Row k="Version" v={pub.version === pub.latestVersion ? `${pub.version} (the latest for this month)` : `${pub.version} (version ${pub.latestVersion} is newer)`} />
            <Row k="Fingerprint" v={<span className="font-mono break-all">{pub.root}</span>} />
          </dl>
          {pub.version !== pub.latestVersion && (
            <Alert tone="warning">The business published this month again after this version. Ask it for the latest Verify link.</Alert>
          )}
          {explorer && (
            <a href={explorer} target="_blank" rel="noreferrer" className="text-primary hover:underline">
              View the transaction on the explorer
            </a>
          )}
        </CardBody>
      </Card>

      {pub.statements && (
        <Card title="Public statements" description={`${pub.statements.business} · ${pub.statements.basis === "accrual" ? "Accrual" : "Cash"} basis · ${pub.statements.currency}`}>
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 tabular sm:grid-cols-3">
              {(
                [
                  ["Revenue", pub.statements.revenue],
                  ["Expenses", pub.statements.expenses],
                  ["Net income", pub.statements.net_income],
                  ["Cash at month start", pub.statements.cash_opening],
                  ["Cash at month end", pub.statements.cash_closing],
                  ["Assets", pub.statements.assets],
                  ["Liabilities", pub.statements.liabilities],
                  ["Equity", pub.statements.equity]
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="text-lg font-semibold">{money(v)}</dd>
                </div>
              ))}
            </dl>
            {pub.statements.root !== pub.root && <Alert tone="danger" className="mt-3">These statements claim a different fingerprint than the books attested in the same transaction.</Alert>}
          </CardBody>
        </Card>
      )}

      {pub.encryptedBooks ? (
        <OpenBooks payload={pub.encryptedBooks} root={pub.root} />
      ) : (
        <Card>
          <CardBody className="text-sm text-muted-foreground">
            This publication carries the fingerprint only. To check the books, ask the business for them: any copy whose fingerprint equals the one above is exactly what it published.
          </CardBody>
        </Card>
      )}
    </>
  );
}

function OpenBooks({ payload, root }: { payload: Hex; root: Hex }) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [books, setBooks] = useState<BooksDocument | null>(null);
  const [matches, setMatches] = useState<boolean | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const doc = await decryptBooks(payload, passphrase);
      setBooks(doc);
      setMatches(booksRoot(doc.entries, doc.book, doc.period) === root);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!books) return;
    const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = [
      [books.business],
      [`Books for ${books.month}, decrypted from Monad`],
      ["Fingerprint", root],
      [],
      ["date", "entry", "description", "account_code", "account", "debit", "credit", "memo"],
      ...books.entries.flatMap((e) => e.lines.map((l) => [e.entry_date, e.number, e.description ?? "", l.account_code ?? "", l.account_name ?? "", micro(l.debit), micro(l.credit), l.memo ?? ""]))
    ];
    const blob = new Blob(["﻿" + rows.map((r) => r.map((c) => esc(String(c))).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${books.business.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-books-${books.month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!books) {
    return (
      <Card title="The books, encrypted" description="This publication carries the month's books. Enter the passphrase the business gave you to open them here, in your browser.">
        <CardBody className="grid gap-3">
          <Field label="Passphrase" htmlFor="verify-pass">
            <Input id="verify-pass" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} onKeyDown={(e) => e.key === "Enter" && passphrase && void open()} />
          </Field>
          <div>
            <Button variant="primary" icon={<Lock />} loading={busy} disabled={!passphrase} onClick={open}>
              Open the books
            </Button>
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
        </CardBody>
      </Card>
    );
  }

  return (
    <Card
      title={`${books.business} · books for ${books.month}`}
      description={`${books.entries.length} posted entries, decrypted from Monad in your browser`}
      actions={
        <Button size="sm" icon={<Download />} onClick={download}>
          Download CSV
        </Button>
      }
    >
      <CardBody className="grid gap-4">
        {matches ? (
          <p className="inline-flex items-center gap-2 font-medium text-success">
            <CheckCircle2 className="size-4" aria-hidden="true" /> These books match the published fingerprint, entry for entry.
          </p>
        ) : (
          <p className="inline-flex items-center gap-2 font-medium text-destructive">
            <XCircle className="size-4" aria-hidden="true" /> These books do not match the published fingerprint.
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">Entry</th>
                <th className="py-2 pr-3 font-medium">Account</th>
                <th className="py-2 pr-3 text-right font-medium">Debit</th>
                <th className="py-2 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {books.entries.map((e) =>
                e.lines.map((l, i) => (
                  <tr key={`${e.id}-${l.position}`} className={i === e.lines.length - 1 ? "border-b" : ""}>
                    <td className="py-1.5 pr-3 align-top whitespace-nowrap">{i === 0 ? e.entry_date : ""}</td>
                    <td className="py-1.5 pr-3 align-top">{i === 0 ? <><span className="font-medium">{e.number}</span> <span className="text-muted-foreground">{e.description}</span></> : ""}</td>
                    <td className="py-1.5 pr-3">{l.account_code} {l.account_name}</td>
                    <td className="py-1.5 pr-3 text-right">{l.debit !== "0" ? money(micro(l.debit)) : ""}</td>
                    <td className="py-1.5 text-right">{l.credit !== "0" ? money(micro(l.credit)) : ""}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          The fingerprint covers every entry&apos;s date, source, accounts and amounts, so a match means nothing in these books differs from what was published.
        </p>
      </CardBody>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
