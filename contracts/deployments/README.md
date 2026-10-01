# Deployments

One JSON file per network, written by `npm run contracts:record -- --network <key>` from Foundry's
broadcast output, covering both contracts (`SetraPaymentIntent` and `SetraBooksAttestation`). Setra
reads contract addresses from environment variables (`MONAD_TESTNET_PAYMENT_INTENT_ADDRESS`,
`MONAD_TESTNET_BOOKS_ATTESTATION_ADDRESS`, …; `render.yaml` sets them for the hosted demo); these
files are the auditable record of what was deployed where, including the ABI.

Deploy both to Monad testnet with your own keystore (`cast wallet import` first if you haven't):

    cd contracts && forge script script/DeploySetra.s.sol --rpc-url https://testnet-rpc.monad.xyz \
      --account <keystore-name> --broadcast
    cd .. && npm run contracts:record -- --network monad-testnet

| Network        | Chain ID | File                   | Status |
| -------------- | -------- | ---------------------- | ------ |
| Monad          | 143      | `monad.json`           | Not deployed yet |
| Monad Testnet  | 10143    | `monad-testnet.json`   | SetraPaymentIntent `0x1eF2Ca1b4426D7e942EAd749F4C7eF5580fd9B5c` (block 67282785); SetraBooksAttestation v2 `0xD4b87CE59e2dcf5F597ea0EDf7dEC17c21D78a73` (block 67320290, adds `publish`). v1 `0xBc89b80F680046E23e53b2650Ca574E96Fb5C9cA` is kept in the record's history |
| Base           | 8453     | `base.json`            | Not deployed (secondary) |

Nothing in this directory is fabricated: a file exists only after a real broadcast.
