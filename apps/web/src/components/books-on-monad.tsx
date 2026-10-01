"use client";

import { useState } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, http, type Address, type Hex } from "viem";
import { AlertTriangle, ExternalLink, Lock, ShieldCheck } from "lucide-react";
import { BOOKS_V2_ABI, encodeStatements, encryptBooks, type BooksDocument, type BooksStatements } from "@setra/contracts-client";
import { Alert, Button, Field, Input, Modal, useToast } from "@/components/app-ui";
import { useSession } from "@/components/session";
import { api, useApi } from "@/lib/api";
import { useInjectedWallets, walletDeclined, walletErrorMessage, type InjectedWallet } from "@/lib/browser-wallets";
import { money, shortAddress, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Attestation {
  version: number;
  publisher: string;
  transaction_hash: string;
  explorer_url: string | null;
  published_at: string;
  encrypted_books: boolean;
  statements: BooksStatements | null;
}

interface Status {
  book: Hex;
  period: number;
  root: Hex;
  entry_count: number;
  state: "not_closed" | "unpublished" | "published" | "changed";
  contract: { chain_id: number; network: string; address: Address; rpc_url: string; explorer_url: string | null } | null;
  attestations: Attestation[];
}

interface Publication {
  book: Hex;
  period: number;
  root: Hex;
  entry_count: number;
  document: BooksDocument;
  statements: BooksStatements;
}

const REMEMBERED = "setra:books-wallet";
const remembered = () => {
  try {
    return localStorage.getItem(REMEMBERED);
  } catch {
    return null;
  }
};

export const verifyLink = (chainId: number, tx: string) => `/verify?chain=${chainId}&tx=${tx}`;

/**
 * Publish a closed month on Monad from the business's own wallet: always its fingerprint, and
 * optionally the books themselves, encrypted in this browser with a passphrase Setra never sees, and
 * public statements. Shows whether the books still match what was published. Hidden when the books
 * contract isn't set up for this mode.
 */
export function BooksOnMonad({ month, label }: { month: string; label: string }) {
  const { can } = useSession();
  const { data, mutate } = useApi<Status>(`/v1/accounting/periods/${month}/books-attestation`, { revalidateOnFocus: false });
  const [open, setOpen] = useState(false);

  if (!data?.contract || data.state === "not_closed") return null;
  const contract = data.contract;
  const latest = data.attestations[0];
  const canPublish = can("financials:manage");

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {data.state === "published" && latest ? (
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-success">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          On {contract.network} · signed by {shortAddress(latest.publisher)} {timeAgo(latest.published_at)}
          {latest.encrypted_books && <span className="rounded-full bg-success/12 px-1.5 py-0.5 font-medium">Books, encrypted</span>}
          {latest.statements && <span className="rounded-full bg-success/12 px-1.5 py-0.5 font-medium">Public statements</span>}
          <a href={verifyLink(contract.chain_id, latest.transaction_hash)} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">
            Verify
          </a>
          {latest.explorer_url && (
            <a href={latest.explorer_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium underline-offset-2 hover:underline" aria-label="View the transaction on the explorer">
              Explorer <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          )}
        </span>
      ) : data.state === "changed" ? (
        <span className="inline-flex items-center gap-1.5 text-warning">
          <AlertTriangle className="size-3.5" aria-hidden="true" />
          The books changed after they were published on {contract.network}.
        </span>
      ) : (
        <span className="text-muted-foreground">Not published on {contract.network} yet.</span>
      )}
      {canPublish && data.state !== "published" && (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          {data.state === "changed" ? "Publish again" : `Publish to ${contract.network}`}
        </Button>
      )}
      {canPublish && data.state === "published" && latest && (!latest.encrypted_books || !latest.statements) && (
        <button type="button" onClick={() => setOpen(true)} className="cursor-pointer text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Add the books or statements
        </button>
      )}
      {open && <PublishDialog month={month} label={label} contract={contract} onClose={() => setOpen(false)} onDone={() => { setOpen(false); mutate(); }} />}
    </div>
  );
}

function PublishDialog({ month, label, contract, onClose, onDone }: { month: string; label: string; contract: NonNullable<Status["contract"]>; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const wallets = useInjectedWallets();
  const { data: pub, error: pubError } = useApi<Publication>(`/v1/accounting/periods/${month}/books-publication`, { revalidateOnFocus: false });
  const [withBooks, setWithBooks] = useState(true);
  const [withStatements, setWithStatements] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [walletId, setWalletId] = useState<string | null>(remembered());
  const [step, setStep] = useState<string | null>(null);

  const wallet: InjectedWallet | undefined = wallets?.find((w) => w.id === walletId) ?? (wallets?.length === 1 ? wallets[0] : undefined);
  const passphraseProblem = !withBooks ? null : passphrase.length < 12 ? "Use at least 12 characters." : passphrase !== confirm ? "The two passphrases don't match." : null;
  const ready = !!pub && !!wallet && !passphraseProblem && !step;

  const publish = async () => {
    if (!pub || !wallet) return;
    try {
      localStorage.setItem(REMEMBERED, wallet.id);
    } catch {
      // Not remembered; it will ask again next time.
    }
    // Which request is open, so a decline or failure says where it happened.
    let action = "encryption";
    try {
      let encrypted: Hex = "0x";
      if (withBooks) {
        setStep("Encrypting the books in this browser…");
        encrypted = await encryptBooks(pub.document, passphrase);
      }
      action = "connection request";
      setStep(`Connecting ${wallet.name}…`);
      const chain = defineChain({ id: contract.chain_id, name: contract.network, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [contract.rpc_url] } } });
      const client = createWalletClient({ chain, transport: custom(wallet.provider) });
      const [account] = await client.requestAddresses();
      if (!account) throw new Error("No wallet account was shared.");
      if ((await client.getChainId()) !== chain.id) {
        action = `switch to ${contract.network}`;
        setStep(`Switching ${wallet.name} to ${contract.network}…`);
        await client.switchChain({ id: chain.id }).catch(async (e) => {
          if (walletDeclined(e)) throw e;
          await client.addChain({ chain });
        });
      }
      action = "transaction";
      setStep("Confirm in your wallet…");
      const statements: Hex = withStatements ? encodeStatements(pub.statements) : "0x";
      const hash =
        withBooks || withStatements
          ? await client.writeContract({ account, chain, address: contract.address, abi: BOOKS_V2_ABI, functionName: "publish", args: [pub.book, pub.period, pub.root, pub.entry_count, encrypted, statements] })
          : await client.writeContract({ account, chain, address: contract.address, abi: BOOKS_V2_ABI, functionName: "attest", args: [pub.book, pub.period, pub.root, pub.entry_count] });
      action = "wait for Monad";
      setStep("Waiting for Monad…");
      await createPublicClient({ chain, transport: http(contract.rpc_url) }).waitForTransactionReceipt({ hash });
      action = "check against your books";
      setStep("Checking it against your books…");
      await api(`/v1/accounting/periods/${month}/books-attestation`, { method: "POST", body: { transaction_hash: hash } });
      toast("success", `${label} is published on ${contract.network}.`);
      onDone();
    } catch (e) {
      console.error(`Publish to ${contract.network} failed at the ${action}`, e);
      toast("error", walletDeclined(e) ? `Nothing was published: ${wallet.name} declined the ${action}.` : `Publishing stopped at the ${action}: ${walletErrorMessage(e, "it didn't go through")}`);
    } finally {
      setStep(null);
    }
  };

  return (
    <Modal
      open
      onClose={step ? () => undefined : onClose}
      title={`Publish ${label} on ${contract.network}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={!!step}>
            Cancel
          </Button>
          <Button variant="primary" loading={!!step} disabled={!ready} onClick={publish}>
            {step ?? "Publish"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 text-sm">
        {pubError && <Alert tone="danger">{pubError.message}</Alert>}
        <Layer checked disabled title="Fingerprint" body={pub ? `Proves these ${pub.entry_count} posted entries, exactly as they are now. Always included.` : "Proves the month's posted entries, exactly as they are now. Always included."} />
        <Layer checked={withBooks} onChange={setWithBooks} title="The books, encrypted" body="Every entry of the month, encrypted in this browser. Anyone you give the passphrase to can read the books straight from Monad and check them. Setra never sees the passphrase and can't recover it." />
        {withBooks && (
          <div className="grid gap-3 rounded-xl bg-muted/50 p-3 sm:grid-cols-2">
            <Field label="Passphrase" htmlFor="books-pass" hint="At least 12 characters. Keep it somewhere safe.">
              <Input id="books-pass" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </Field>
            <Field label="Repeat it" htmlFor="books-pass2" error={passphrase && confirm && passphraseProblem ? passphraseProblem : undefined}>
              <Input id="books-pass2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
          </div>
        )}
        <Layer checked={withStatements} onChange={setWithStatements} title="Public statements" body="The month's totals, readable by anyone, forever. Customers and individual entries stay private." />
        {withStatements && pub && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-muted/50 p-3 tabular sm:grid-cols-3">
            {(
              [
                ["Revenue", pub.statements.revenue],
                ["Expenses", pub.statements.expenses],
                ["Net income", pub.statements.net_income],
                ["Cash at month end", pub.statements.cash_closing],
                ["Assets", pub.statements.assets],
                ["Liabilities", pub.statements.liabilities]
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="font-medium">{money(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        {wallets && wallets.length > 1 && (
          <div className="grid gap-2">
            <p className="font-medium">Publish with</p>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Wallet">
              {wallets.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="radio"
                  aria-checked={wallet?.id === w.id}
                  onClick={() => setWalletId(w.id)}
                  className={cn("inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5", wallet?.id === w.id ? "border-primary bg-primary/10 font-medium" : "hover:bg-accent")}
                >
                  {w.icon && <img src={w.icon} alt="" className="size-4 rounded" />}
                  {w.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {wallets && wallets.length === 0 && <Alert tone="info">Open this page in a browser with a wallet such as MetaMask to publish.</Alert>}
      </div>
    </Modal>
  );
}

function Layer({ checked, disabled, onChange, title, body }: { checked: boolean; disabled?: boolean; onChange?: (v: boolean) => void; title: string; body: string }) {
  return (
    <label className={cn("flex gap-3 rounded-xl border p-3", disabled ? "opacity-80" : "cursor-pointer hover:bg-accent/40")}>
      <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
      <span className="grid gap-0.5">
        <span className="inline-flex items-center gap-1.5 font-medium">
          {title === "The books, encrypted" && <Lock className="size-3.5" aria-hidden="true" />}
          {title}
        </span>
        <span className="text-muted-foreground">{body}</span>
      </span>
    </label>
  );
}
