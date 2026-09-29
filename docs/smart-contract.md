# SetraPaymentIntent

`contracts/src/SetraPaymentIntent.sol` is a minimal primitive that gives a stablecoin payment a
machine-readable onchain reference. It exists for one reason: when two open invoices have the same
amount, a direct transfer can't say which one it pays. A payment intent can.

The ordinary Setra flow (direct ERC-20 transfer to the merchant's wallet) needs no contract.

## Design

- **No creation transaction.** An intent id is a commitment to the full terms:
  `keccak256(abi.encode(chainId, address(this), merchant, token, amount, expiresAt, ref))`.
  Setra computes it offchain (`packages/contracts-client`), stores it, and gives the terms to the payer.
- **Non-custodial.** `pay(terms)` transfers `amount` from `msg.sender` straight to `terms.merchant`
  and records the payment. The contract never holds a balance (enforced by an invariant test).
- **No owner, admin, upgradeability, fees or token.**
- `payWithPermit` accepts an EIP-2612 signature instead of a separate approval, tolerating permit
  front-running.
- Merchants can `cancel` an open intent and `refund` a paid one to the original payer.

## State machine

```
OPEN ──pay──▶ PAID ──refund──▶ REFUNDED
  └──cancel──▶ CANCELLED
EXPIRED is derived from time (OPEN and block.timestamp ≥ expiresAt); it is never stored.
```

No transition returns to OPEN; CANCELLED and REFUNDED are terminal. Invalid transitions revert with
`InvalidTransition(from, to)`.

## Events

```solidity
event PaymentIntentPaid(bytes32 indexed intentId, address indexed merchant, address indexed payer, address token, uint256 amount, bytes32 ref);
event PaymentIntentCancelled(bytes32 indexed intentId, address indexed merchant, bytes32 ref);
event PaymentIntentRefunded(bytes32 indexed intentId, address indexed merchant, address indexed payer, address token, uint256 amount, bytes32 ref);
```

Setra filters `PaymentIntentPaid`/`Refunded` by `merchant` (topic 2) for monitored wallets, looks the
intent up by `(chain, contract, intentId)` among intents *it created*, verifies merchant/token/amount,
records the event as the payment's evidence and the ERC-20 `Transfer` in the same transaction as
supporting evidence (never a second payment), and matches by reference.

## Security review

Checked, with tests in `contracts/test`:

| Question | Answer |
|---|---|
| Can a user pay twice? | No. Status becomes PAID before the transfer; a second `pay` reverts. Reentrancy guard on `pay`/`refund`/`payWithPermit`. |
| Can someone create an intent for another merchant? | Anyone can compute terms for any merchant, but paying them only pays that merchant the stated amount. Setra ignores intents it didn't create. |
| Can a payment be redirected or resized? | No. Any change to the terms changes the id. |
| Can an expired intent be paid? | No. `block.timestamp >= expiresAt` reverts (fuzzed). |
| Can state move backward? | No (invariant test over 16k random calls per run). |
| Can an unauthorized user cancel or refund? | No. `msg.sender == merchant` (fuzzed). |
| Can one payer's allowance be spent by someone else? | No. `pay` always pulls from `msg.sender`; `refund` only from the merchant, only when the merchant calls it. |
| Replay across chains/deployments? | No. Chain id and contract address are inside the id. |
| Weird ERC-20s? | Fee-on-transfer and inexact tokens revert (`InexactTransfer`, balance-delta check); false-returning tokens revert; no-return (USDT-style) tokens work; reentrant tokens can't re-enter. |
| Paying the contract itself? | Found in second review: `merchant == address(this)` would strand funds. Now reverts with `InvalidMerchant`. |
| Does the event match the transition? | Emitted only after the exact transfer succeeded, with the committed terms. |

Static analysis: `slither` (101 detectors) and `forge lint` report only `block.timestamp` comparisons,
which are intended: expiry granularity is hours/days and validator drift is seconds.

Known limitations: a payer blacklisted by the token issuer can't be refunded through the contract
(the merchant refunds another way); refunds require the merchant to approve the contract first.

**The contract has not been audited by a third party.**

## Testing

```bash
cd contracts
forge test               # 32 tests: unit, 3 fuzz (1,000 runs), 4 invariants (256 runs × 64 depth)
forge test --gas-report  # pay ≈ 31k–94k gas, cancel ≈ 25k–48k
forge test --profile ci  # 10,000 fuzz runs, 1,000 invariant runs
```

End-to-end with Setra's ingestion on a real EVM node: `packages/engine/test/chain.test.ts`.

## Deployment

See `docs/deployment.md#smart-contract`. Deployment records live in `contracts/deployments/<network>.json`
and are written only from real Foundry broadcasts. Status: **not yet deployed to Monad.**
