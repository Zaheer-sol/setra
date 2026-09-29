// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISetraPaymentIntent} from "../interfaces/ISetraPaymentIntent.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";

/// @title SetraPaymentIntent
/// @notice A minimal, non-custodial primitive that gives a stablecoin payment a machine-readable
///         onchain reference. Tokens move directly from the payer to the merchant in the same call;
///         this contract never holds funds, has no owner, no admin, no upgrade path and no fees.
///
/// @dev    An intent is not created onchain. Its id is a commitment to the full payment terms
///         (merchant, token, amount, expiry, reference) plus the chain id and this contract's
///         address. Anyone holding the terms can pay them exactly once, and only exactly as stated:
///
///           - Changing any term changes the id, so a payment can never be redirected or resized.
///           - "Front-running" an intent means paying the merchant the full amount, which is harmless.
///           - Ids are domain-separated by chain id and contract address, so they cannot be replayed
///             on another chain or deployment.
///
///         State machine (EXPIRED is derived from time, never stored):
///
///             OPEN ──pay──▶ PAID ──refund──▶ REFUNDED
///               │
///               └──cancel──▶ CANCELLED
///
///         No transition leads back to OPEN or out of CANCELLED/REFUNDED.
contract SetraPaymentIntent is ISetraPaymentIntent {
    using SafeTransfer for address;

    mapping(bytes32 intentId => Record) private _records;
    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @inheritdoc ISetraPaymentIntent
    function intentIdOf(Terms calldata terms) public view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(this), terms.merchant, terms.token, terms.amount, terms.expiresAt, terms.ref)
        );
    }

    /// @inheritdoc ISetraPaymentIntent
    function pay(Terms calldata terms) external nonReentrant returns (bytes32 intentId) {
        intentId = _pay(terms);
    }

    /// @inheritdoc ISetraPaymentIntent
    function payWithPermit(Terms calldata terms, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        returns (bytes32 intentId)
    {
        // A permit can be front-run by anyone who copies the signature from the mempool, which would make
        // this call revert even though the allowance now exists. Ignore permit failures and let the
        // transfer itself decide: without allowance it still reverts safely.
        try IERC20Permit(terms.token).permit(msg.sender, address(this), terms.amount, deadline, v, r, s) {} catch {}
        intentId = _pay(terms);
    }

    /// @inheritdoc ISetraPaymentIntent
    function cancel(Terms calldata terms) external returns (bytes32 intentId) {
        if (msg.sender != terms.merchant) revert Unauthorized();
        intentId = intentIdOf(terms);
        Record storage record = _records[intentId];
        if (record.status != Status.Open) revert InvalidTransition(record.status, Status.Cancelled);
        record.status = Status.Cancelled;
        emit PaymentIntentCancelled(intentId, terms.merchant, terms.ref);
    }

    /// @inheritdoc ISetraPaymentIntent
    function refund(Terms calldata terms) external nonReentrant returns (bytes32 intentId) {
        if (msg.sender != terms.merchant) revert Unauthorized();
        intentId = intentIdOf(terms);
        Record storage record = _records[intentId];
        if (record.status != Status.Paid) revert InvalidTransition(record.status, Status.Refunded);

        record.status = Status.Refunded;
        address payer = record.payer;
        _exactTransfer(terms.token, terms.merchant, payer, terms.amount);
        emit PaymentIntentRefunded(intentId, terms.merchant, payer, terms.token, terms.amount, terms.ref);
    }

    /// @inheritdoc ISetraPaymentIntent
    function stateOf(Terms calldata terms) external view returns (State) {
        Record storage record = _records[intentIdOf(terms)];
        if (record.status == Status.Open) {
            return block.timestamp >= terms.expiresAt ? State.Expired : State.Open;
        }
        if (record.status == Status.Paid) return State.Paid;
        if (record.status == Status.Cancelled) return State.Cancelled;
        return State.Refunded;
    }

    /// @inheritdoc ISetraPaymentIntent
    function recordOf(bytes32 intentId) external view returns (Record memory) {
        return _records[intentId];
    }

    function _pay(Terms calldata terms) private returns (bytes32 intentId) {
        if (terms.merchant == address(0)) revert ZeroAddress();
        // Paying "to this contract" would strand funds here and break the non-custodial guarantee.
        if (terms.merchant == address(this)) revert InvalidMerchant();
        if (terms.token.code.length == 0) revert NotAContract();
        if (terms.amount == 0) revert ZeroAmount();
        if (msg.sender == terms.merchant) revert PayerIsMerchant();
        if (block.timestamp >= terms.expiresAt) revert IntentExpired();

        intentId = intentIdOf(terms);
        Record storage record = _records[intentId];
        if (record.status != Status.Open) revert InvalidTransition(record.status, Status.Paid);

        // Effects before interactions.
        record.status = Status.Paid;
        record.payer = msg.sender;
        record.paidAt = uint64(block.timestamp);

        _exactTransfer(terms.token, msg.sender, terms.merchant, terms.amount);
        emit PaymentIntentPaid(intentId, terms.merchant, msg.sender, terms.token, terms.amount, terms.ref);
    }

    /// @dev Moves exactly `amount` from `from` to `to`. Fee-on-transfer, rebasing or otherwise
    ///      inconsistent tokens are rejected so the emitted event always equals what arrived.
    function _exactTransfer(address token, address from, address to, uint256 amount) private {
        uint256 before = token.balanceOf(to);
        token.safeTransferFrom(from, to, amount);
        uint256 afterBalance = token.balanceOf(to);
        if (afterBalance < before || afterBalance - before != amount) revert InexactTransfer();
    }
}

interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}
