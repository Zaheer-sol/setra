"use client";

import { useState } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, http, type Address, type EIP1193Provider, type Hex } from "viem";
import { AlertTriangle, ExternalLink, ShieldCheck } from "lucide-react";
import { Button, useToast } from "@/components/app-ui";
import { useSession } from "@/components/session";
import { api, useApi, type ApiError } from "@/lib/api";
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

/** The first browser wallet that announces itself (EIP-6963), or the classic injected one. */
function browserWallet(): Promise<EIP1193Provider | null> {
  return new Promise((resolve) => {
    let found: EIP1193Provider | null = null;
    const onAnnounce = (e: Event) => {
      found ??= (e as CustomEvent<{ provider: EIP1193Provider }>).detail?.provider ?? null;
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      resolve(found ?? ((window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null));
    }, 300);
  });
}

/**
 * Publish a closed month's fingerprint on Monad from the business's own wallet, and show whether the
 * books still match what was published. Hidden when the attestation contract isn't set up for this mode.
 */
export function BooksOnMonad({ month, label }: { month: string; label: string }) {
  const { can } = useSession();
  const toast = useToast();
  const { data, mutate } = useApi<Status>(`/v1/accounting/periods/${month}/books-attestation`, { revalidateOnFocus: false });
  const [step, setStep] = useState<string | null>(null);

  if (!data?.contract || data.state === "not_closed") return null;
  const contract = data.contract;
  const latest = data.attestations[0];

  const publish = async () => {
    try {
      setStep("Connecting your wallet…");
      const provider = await browserWallet();
      if (!provider) throw new Error("Open this page in a browser with a wallet such as MetaMask to publish.");
      const chain = defineChain({ id: contract.chain_id, name: contract.network, nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [contract.rpc_url] } } });
      const wallet = createWalletClient({ chain, transport: custom(provider) });
      const [account] = await wallet.requestAddresses();
      if (!account) throw new Error("No wallet account was shared.");
      if ((await wallet.getChainId()) !== chain.id) {
        setStep(`Switching your wallet to ${contract.network}…`);
        await wallet.switchChain({ id: chain.id }).catch(() => wallet.addChain({ chain }));
      }
      setStep("Confirm in your wallet…");
      const hash = await wallet.writeContract({ account, chain, address: contract.address, abi: ATTEST_ABI, functionName: "attest", args: [data.book, data.period, data.root, data.entry_count] });
      setStep("Waiting for Monad…");
      await createPublicClient({ chain, transport: http(contract.rpc_url) }).waitForTransactionReceipt({ hash });
      setStep("Checking it against your books…");
      await api(`/v1/accounting/periods/${month}/books-attestation`, { method: "POST", body: { transaction_hash: hash } });
      toast("success", `${label} is published on ${contract.network}.`);
      mutate();
    } catch (e) {
      const message = (e as ApiError).message ?? String(e);
      toast("error", /rejected|denied/i.test(message) ? "Nothing was published: the wallet request was declined." : message);
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
      {can("financials:manage") && data.state !== "published" && (
        <Button size="sm" variant="ghost" loading={!!step} onClick={publish}>
          {step ?? (data.state === "changed" ? "Publish again" : `Publish to ${contract.network}`)}
        </Button>
      )}
    </div>
  );
}
