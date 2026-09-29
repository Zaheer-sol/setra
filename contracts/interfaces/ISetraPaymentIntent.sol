// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ISetraPaymentIntent
/// @notice Interface and event model consumed by Setra's ingestion engine.
interface ISetraPaymentIntent {
    /// @notice The full terms of a payment. The intent id is a commitment to these values.
    struct Terms {
        address merchant; // merchant-controlled receiving wallet; funds settle here directly
        address token; // ERC-20 stablecoin contract
        uint256 amount; // exact amount in token base units
        uint64 expiresAt; // unix seconds; payment must happen strictly before this time
        bytes32 ref; // opaque Setra reference (keccak of the Setra intent id)
    }

    /// @dev Stored status. `Open` is the zero value: an intent nobody has touched yet.
    enum Status {
        Open,
        Paid,
        Cancelled,
        Refunded
    }

    /// @dev Observable state, including the time-derived `Expired`.
    enum State {
        Open,
        Paid,
        Cancelled,
        Refunded,
        Expired
    }

    struct Record {
        Status status;
        address payer;
        uint64 paidAt;
    }

    event PaymentIntentPaid(
        bytes32 indexed intentId,
        address indexed merchant,
        address indexed payer,
        address token,
        uint256 amount,
        bytes32 ref
    );
    event PaymentIntentCancelled(bytes32 indexed intentId, address indexed merchant, bytes32 ref);
    event PaymentIntentRefunded(
        bytes32 indexed intentId,
        address indexed merchant,
        address indexed payer,
        address token,
        uint256 amount,
        bytes32 ref
    );

    error ZeroAddress();
    error InvalidMerchant();
    error NotAContract();
    error ZeroAmount();
    error PayerIsMerchant();
    error IntentExpired();
    error Unauthorized();
    error InvalidTransition(Status from, Status to);
    error InexactTransfer();
    error Reentrancy();

    /// @notice Deterministic id for a set of terms on this chain and this deployment.
    function intentIdOf(Terms calldata terms) external view returns (bytes32);

    /// @notice Pay an open, unexpired intent. Requires prior ERC-20 approval of `terms.amount`.
    function pay(Terms calldata terms) external returns (bytes32 intentId);

    /// @notice Same as `pay`, using an EIP-2612 permit signature instead of a separate approval.
    function payWithPermit(Terms calldata terms, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (bytes32 intentId);

    /// @notice Merchant-only. Prevents an open intent from ever being paid.
    function cancel(Terms calldata terms) external returns (bytes32 intentId);

    /// @notice Merchant-only. Returns a paid intent's funds to the original payer (requires merchant approval).
    function refund(Terms calldata terms) external returns (bytes32 intentId);

    function stateOf(Terms calldata terms) external view returns (State);

    function recordOf(bytes32 intentId) external view returns (Record memory);
}
