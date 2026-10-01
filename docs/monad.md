# Monad integration

Monad is Setra's primary network. It is where the money moves; Setra understands it.

## Networks

Verified on 2026-09-27 against official sources (docs.monad.xyz network information, current facts,
JSON-RPC reference; Circle's USDC contract address list) and by querying the public RPCs directly.

| | Monad (live mode) | Monad Testnet (test mode) |
|---|---|---|
| Chain ID | `143` | `10143` |
| Public RPC | `https://rpc.monad.xyz` (QuickNode, 25 rps, `eth_getLogs` ≤ 100 blocks) | `https://testnet-rpc.monad.xyz` |
| WebSocket | `wss://rpc.monad.xyz` | `wss://testnet-rpc.monad.xyz` |
| Explorer | monadscan.com | testnet.monadscan.com |
| USDC | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` (6 decimals) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` (6 decimals, Circle faucet) |
| USDT0 | `0xe7cd86e13AC4309349F30B3435a9d337750fC82D` | n/a |
| Block time | ~300 ms (measured: 302 ms average over 10,000 blocks) | ~300 ms |

All values live in `packages/config/src/networks.ts` and can be overridden through environment
variables (`MONAD_RPC_URL`, `MONAD_USDC_ADDRESS`, `MONAD_LOGS_BLOCK_RANGE`, …). Production should use
an authenticated, higher-limit RPC provider; `*_PUBLIC_RPC_URL` is what the hosted payment page hands
to customers' wallets and never contains provider keys.

## Finality policy

Monad maps block tags to consensus states: `latest` = Proposed (speculative), `safe` = Voted,
`finalized` = Finalized (irreversible without a hard fork). Setra uses this directly:

- **Tip stage** reads `latest` and records observations as `observed`. The console and hosted page say
  "Payment detected" within one block. Nothing is applied.
- **Settled stage** reads `finalized` and applies payments. Observations become `finalized`.
- A tip observation that doesn't reappear in the settled range is `dropped` with a compensating
  `PAYMENT_REVERSED` event. No balances were ever changed.

**Safety lag.** The public endpoint is load-balanced; during verification the `finalized` block returned
by one request was *ahead* of `latest` returned by the next. A node that is behind can silently return
incomplete logs for the newest blocks. Setra therefore scans settled ranges only up to
`finalized − MONAD_SETTLED_LAG_BLOCKS` (default 5 blocks ≈ 1.5 s). With 1 s polling, detection-to-applied
latency on mainnet measured at **~1.8 s average**.

## What was verified against real Monad

- The worker ran against **Monad mainnet** monitoring a real, busy USDC recipient address (read-only):
  34 real USDC transfers were observed, deduplicated, recorded as immutable evidence and processed
  through matching (all correctly unmatched, since the workspace had no invoices); 6 were first seen at the
  tip and promoted to finalized an average of 1.84 s later; a 300-block backfill completed; zero errors.
- The adapter was exercised against **Monad testnet** (block number, `finalized` tag, `eth_getLogs`).

- **A real payment into a Setra invoice on Monad testnet** (2026-09-27): a 2 USDC transfer from the
  hosted payment page (MetaMask, direct ERC-20 transfer), tx
  `0xb7208e823382be10d1dcc390eef18f6a68499dad0788e095740c073c121d7207`, block 66,179,640. Observed at the tip
  at 16:52:49.6 UTC, finalized at 16:52:52.0, matched to INV-2061 (known customer wallet, `match-v1.0`),
  invoice paid, `payment.matched` delivered (HTTP 200, signature verified). A second identical transfer
  (`0x1cd4c02d1382ffa6104d8f6f3827c7d226dd6044668f2deb0086ef255c610e13`) was correctly flagged as a
  possible duplicate. A real 20 USDC faucet transfer into the merchant wallet was picked up by backfill and
  flagged as unknown.

## Books on Monad

When a month is closed, the business can publish its books' fingerprint on Monad from its own wallet
(`contracts/src/SetraBooksAttestation.sol`: no owner, no admin, no funds). The fingerprint is a
Merkle root over the month's posted journal entries (each leaf covers the entry's id, number, date,
source and every line), so the entries stay private while anyone the business shares its books with
can check they're the ones it vouched for. Setra records an attestation only after reading the
transaction back from the chain and checking that its book, month, root and entry count match the
books exactly; if a month is reopened and adjusted, the Books page says the books changed since they
were published until the new version is published. Publishing costs about 65,000 gas. Verified end to
end against the real contract on Anvil (`packages/engine/test/books-attestation.test.ts`).

## What has not been verified against real Monad yet

- **SetraPaymentIntent and SetraBooksAttestation on Monad mainnet.** Both are deployed on Monad
  testnet (2026-10-01, block 67282785; addresses in `contracts/deployments/monad-testnet.json`), not
  on mainnet. A payment and a books attestation through them on testnet are still to be recorded here. It is deployed and exercised end-to-end on Anvil
  (pay, refund, reference-based matching, intent id parity with the contract). Deploy with
  `contracts/script/DeployPaymentIntent.s.sol` and record it with `npm run contracts:record`.
- **Any payment on Monad mainnet.** Mainnet ingestion was verified read-only; no mainnet funds were used.

## Why Monad matters to the product

- Payments are final in about a second, so Setra can apply them immediately without taking reorg risk
  or making merchants wait for confirmation counts.
- Canonical USDC is native on Monad, so invoices settle in the stablecoin businesses already use.
- EVM compatibility means standard wallets pay the hosted page with a normal ERC-20 transfer, and the
  intent contract is plain Solidity.

Base (8453 / Base Sepolia 84532) implements the same adapter interface with a confirmations-based
settlement policy and reorg rechecking; it is disabled by default and exists to prove the multichain
boundary.
