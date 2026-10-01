"use client";

import { useState } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, http, type Address, type Hex } from "viem";
import { AlertTriangle, ExternalLink, ShieldCheck } from "lucide-react";
import { Button, useToast } from "@/components/app-ui";
import { useSession } from "@/components/session";
import { api, useApi } from "@/lib/api";
import { useInjectedWallets, walletDeclined, walletErrorMessage, type InjectedWallet } from "@/lib/browser-wallets";
import { shortAddress, timeAgo } from "@/lib/format";

interface Attestation {
  version: number;
  publisher: string;
  transaction_hash: string;
  explorer_url: string | null;
  published_at: string;
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

const ATTEST_ABI = [
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
  }
] as const;

const REMEMBERED = "setra:books-wallet";
const remembered = () => {
  try {
    return localStorage.getItem(REMEMBERED);
  } catch {
    return null;
  }
};

/**
 * Publish a closed month's fingerprint on Monad from the business's own wallet, and show whether the
 * books still match what was published. Hidden when the attestation contract isn't set up for this mode.
 */
export function BooksOnMonad({ month, label }: { month: string; label: string }) {
  const { can } = useSession();
  const toast = useToast();
  const { data, mutate } = useApi<Status>(`/v1/accounting/periods/${month}/books-attestation`, { revalidateOnFocus: false });
  const [step, setStep] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const wallets = useInjectedWallets();

  if (!data?.contract || data.state === "not_closed") return null;
  const contract = data.contract;
  const latest = data.attestations[0];

  // With several wallets installed, the person picks one (and it's remembered); with one, it's used directly.
  const start = () => {
    if (!wallets?.length) {
      toast("error", "Open this page in a browser with a wallet such as MetaMask to publish.");
      return;
    }
    const known = wallets.find((w) => w.id === remembered());
    if (wallets.length === 1 || known) void publish(known ?? wallets[0]!);
    else setChoosing(true);
  };

  const publish = async (wallet: InjectedWallet) => {
    setChoosing(false);
    try {
      localStorage.setItem(REMEMBERED, wallet.id);
    } catch {
      // Not remembered; it will ask again next time.
    }
    // Which request is open in the wallet, so a decline or failure says where it happened.
    let action = "connection request";
    try {
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
      const hash = await client.writeContract({ account, chain, address: contract.address, abi: ATTEST_ABI, functionName: "attest", args: [data.book, data.period, data.root, data.entry_count] });
      action = "wait for Monad";
      setStep("Waiting for Monad…");
      await createPublicClient({ chain, transport: http(contract.rpc_url) }).waitForTransactionReceipt({ hash });
      action = "check against your books";
      setStep("Checking it against your books…");
      await api(`/v1/accounting/periods/${month}/books-attestation`, { method: "POST", body: { transaction_hash: hash } });
      toast("success", `${label} is published on ${contract.network}.`);
      mutate();
    } catch (e) {
      console.error(`Publish to ${contract.network} failed at the ${action}`, e);
      toast(
        "error",
        walletDeclined(e)
          ? `Nothing was published: ${wallet.name} declined the ${action}.`
          : `Publishing stopped at the ${action}: ${walletErrorMessage(e, "it didn't go through")}`
      );
    } finally {
      setStep(null);
    }
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {data.state === "published" && latest ? (
        <span className="inline-flex items-center gap-1.5 text-success">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          On {contract.network} · signed by {shortAddress(latest.publisher)} {timeAgo(latest.published_at)}
          {latest.explorer_url && (
            <a href={latest.explorer_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium underline-offset-2 hover:underline" aria-label="View the transaction">
              View <ExternalLink className="size-3" aria-hidden="true" />
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
      {can("financials:manage") && data.state !== "published" && !choosing && (
        <Button size="sm" variant="ghost" loading={!!step} onClick={start}>
          {step ?? (data.state === "changed" ? "Publish again" : `Publish to ${contract.network}`)}
        </Button>
      )}
      {can("financials:manage") && data.state !== "published" && !choosing && !step && (wallets?.length ?? 0) > 1 && remembered() && (
        <button type="button" onClick={() => setChoosing(true)} className="cursor-pointer text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Use another wallet
        </button>
      )}
      {choosing && wallets && (
        <div className="flex w-full flex-wrap items-center gap-2" role="group" aria-label="Choose a wallet">
          <span className="text-muted-foreground">Publish with:</span>
          {wallets.map((w) => (
            <Button key={w.id} size="sm" variant="secondary" onClick={() => void publish(w)} icon={w.icon ? <img src={w.icon} alt="" className="size-4 rounded" /> : undefined}>
              {w.name}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setChoosing(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
