# Deployments

One JSON file per network, written by `npm run contracts:record -- --network <key>` from Foundry's
broadcast output. Setra reads contract addresses from environment variables
(`MONAD_PAYMENT_INTENT_ADDRESS`, `MONAD_TESTNET_PAYMENT_INTENT_ADDRESS`, …); these files are the
auditable record of what was deployed where, including the ABI.

| Network        | Chain ID | File                   | Status |
| -------------- | -------- | ---------------------- | ------ |
| Monad          | 143      | `monad.json`           | Not deployed yet |
| Monad Testnet  | 10143    | `monad-testnet.json`   | Not deployed yet |
| Base           | 8453     | `base.json`            | Not deployed (secondary) |

Nothing in this directory is fabricated: a file exists only after a real broadcast.
