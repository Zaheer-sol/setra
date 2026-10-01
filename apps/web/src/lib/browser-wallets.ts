"use client";

import { useEffect, useState } from "react";
import type { EIP1193Provider } from "viem";

export interface InjectedWallet {
  id: string;
  name: string;
  icon?: string;
  provider: EIP1193Provider;
}

/**
 * Discover installed browser wallets. EIP-6963 lets every extension announce itself, so a browser
 * with several wallets installed doesn't depend on whichever one grabbed window.ethereum.
 * Returns null until discovery has had a moment to finish.
 */
export function useInjectedWallets(): InjectedWallet[] | null {
  const [wallets, setWallets] = useState<InjectedWallet[] | null>(null);
  useEffect(() => {
    const found = new Map<string, InjectedWallet>();
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<{ info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider }>).detail;
      if (!detail?.provider || !detail.info) return;
      found.set(detail.info.rdns || detail.info.uuid, { id: detail.info.rdns || detail.info.uuid, name: detail.info.name, icon: detail.info.icon, provider: detail.provider });
      setWallets([...found.values()]);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // Legacy wallets only expose window.ethereum.
    const timer = setTimeout(() => {
      const legacy = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
      if (found.size === 0 && legacy) found.set("injected", { id: "injected", name: "Browser wallet", provider: legacy });
      setWallets([...found.values()]);
    }, 400);
    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(timer);
    };
  }, []);
  return wallets;
}

/** True when the wallet itself reports that the person said no (EIP-1193 code 4001). */
export function walletDeclined(e: unknown): boolean {
  const err = e as { code?: number; cause?: { code?: number }; name?: string };
  return err.code === 4001 || err.cause?.code === 4001 || err.name === "UserRejectedRequestError";
}

/** A wallet error in plain words: the wallet's short message, not viem's full technical dump. */
export function walletErrorMessage(e: unknown, fallback: string): string {
  const err = e as { shortMessage?: string; message?: string; code?: number };
  if (err.code === -32002 || /already pending/i.test(err.message ?? "")) return "Your wallet already has a request waiting. Open the wallet extension and approve or reject it.";
  return err.shortMessage ?? err.message?.split("\n")[0] ?? fallback;
}
