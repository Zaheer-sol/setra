"use client";

import { DynamicContextProvider, useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors, isEthereumWallet } from "@dynamic-labs/ethereum";
import { useEffect, useRef } from "react";
import type { Address, EIP1193Provider } from "viem";

/**
 * Pay with just an email: Dynamic creates an embedded wallet for the customer (no extension, no
 * seed phrase), and the checkout uses it like any other wallet. Only loaded when a Dynamic
 * environment is configured, and only on the payment page.
 */

export interface EmailWalletNetwork {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  nativeSymbol: string;
}

export interface ConnectedEmailWallet {
  id: "dynamic";
  name: string;
  address: Address;
  provider: EIP1193Provider;
}

function Bridge({ open, onWallet, onClosed }: { open: boolean; onWallet: (w: ConnectedEmailWallet) => void; onClosed: () => void }) {
  const { primaryWallet, setShowAuthFlow, showAuthFlow } = useDynamicContext();
  const opened = useRef(false);
  const delivered = useRef<string | null>(null);

  useEffect(() => {
    if (open && !primaryWallet) {
      opened.current = true;
      setShowAuthFlow(true);
    }
  }, [open, primaryWallet, setShowAuthFlow]);

  // The customer closed the sign-in without finishing.
  useEffect(() => {
    if (opened.current && !showAuthFlow && !primaryWallet) {
      opened.current = false;
      onClosed();
    }
  }, [showAuthFlow, primaryWallet, onClosed]);

  useEffect(() => {
    if (!primaryWallet || !isEthereumWallet(primaryWallet) || delivered.current === primaryWallet.address) return;
    let cancelled = false;
    (async () => {
      const client = await primaryWallet.getWalletClient();
      if (cancelled) return;
      delivered.current = primaryWallet.address;
      // The checkout talks EIP-1193; the wallet client speaks it too.
      const provider = { request: (args: { method: string; params?: unknown }) => client.request(args as never) } as unknown as EIP1193Provider;
      onWallet({ id: "dynamic", name: "Email wallet", address: primaryWallet.address as Address, provider });
    })();
    return () => {
      cancelled = true;
    };
  }, [primaryWallet, onWallet]);

  return null;
}

export default function EmailWallet({ environmentId, network, open, onWallet, onClosed }: { environmentId: string; network: EmailWalletNetwork; open: boolean; onWallet: (w: ConnectedEmailWallet) => void; onClosed: () => void }) {
  return (
    <DynamicContextProvider
      settings={{
        environmentId,
        walletConnectors: [EthereumWalletConnectors],
        overrides: {
          evmNetworks: [
            {
              chainId: network.chainId,
              networkId: network.chainId,
              name: network.name,
              vanityName: network.name,
              nativeCurrency: { name: network.nativeSymbol, symbol: network.nativeSymbol, decimals: 18 },
              rpcUrls: [network.rpcUrl],
              blockExplorerUrls: network.explorerUrl ? [network.explorerUrl] : [],
              iconUrls: []
            }
          ]
        }
      }}
    >
      <Bridge open={open} onWallet={onWallet} onClosed={onClosed} />
    </DynamicContextProvider>
  );
}
