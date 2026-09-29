// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SetraPaymentIntent} from "../src/SetraPaymentIntent.sol";
import {ISetraPaymentIntent} from "../interfaces/ISetraPaymentIntent.sol";
import {MockUSDC} from "./mocks/Tokens.sol";

/// @notice Drives random sequences of pay / cancel / refund / time travel across a fixed set of intents
///         and tracks what *should* be true.
contract IntentHandler is Test {
    SetraPaymentIntent public intents;
    MockUSDC public usdc;
    address public merchant = makeAddr("merchant");
    address[3] public payers = [makeAddr("p0"), makeAddr("p1"), makeAddr("p2")];

    ISetraPaymentIntent.Terms[] internal _terms;
    mapping(bytes32 => uint256) public paidCount;
    mapping(bytes32 => ISetraPaymentIntent.Status) public ghostStatus;
    uint256 public ghostMerchantNet; // paid - refunded
    bool public illegalTransitionObserved;

    constructor(SetraPaymentIntent intents_, MockUSDC usdc_) {
        intents = intents_;
        usdc = usdc_;
        for (uint256 i; i < payers.length; i++) {
            usdc.mint(payers[i], 1e15);
            vm.prank(payers[i]);
            usdc.approve(address(intents), type(uint256).max);
        }
        usdc.mint(merchant, 1e15);
        vm.prank(merchant);
        usdc.approve(address(intents), type(uint256).max);
        for (uint256 i; i < 8; i++) {
            _terms.push(
                ISetraPaymentIntent.Terms({
                    merchant: merchant,
                    token: address(usdc),
                    amount: (i + 1) * 100e6,
                    expiresAt: uint64(block.timestamp + (i + 1) * 1 days),
                    ref: keccak256(abi.encode(i))
                })
            );
        }
    }

    function termsCount() external view returns (uint256) {
        return _terms.length;
    }

    function termsAt(uint256 i) external view returns (ISetraPaymentIntent.Terms memory) {
        return _terms[i];
    }

    function pay(uint256 seed, uint256 payerSeed) external {
        ISetraPaymentIntent.Terms memory t = _terms[seed % _terms.length];
        bytes32 id = intents.intentIdOf(t);
        address p = payers[payerSeed % payers.length];
        ISetraPaymentIntent.Status beforeStatus = intents.recordOf(id).status;
        vm.prank(p);
        try intents.pay(t) {
            if (beforeStatus != ISetraPaymentIntent.Status.Open || block.timestamp >= t.expiresAt) illegalTransitionObserved = true;
            paidCount[id]++;
            ghostMerchantNet += t.amount;
            ghostStatus[id] = ISetraPaymentIntent.Status.Paid;
        } catch {}
    }

    function cancel(uint256 seed, bool asMerchant) external {
        ISetraPaymentIntent.Terms memory t = _terms[seed % _terms.length];
        bytes32 id = intents.intentIdOf(t);
        ISetraPaymentIntent.Status beforeStatus = intents.recordOf(id).status;
        vm.prank(asMerchant ? merchant : payers[0]);
        try intents.cancel(t) {
            if (!asMerchant || beforeStatus != ISetraPaymentIntent.Status.Open) illegalTransitionObserved = true;
            ghostStatus[id] = ISetraPaymentIntent.Status.Cancelled;
        } catch {}
    }

    function refund(uint256 seed, bool asMerchant) external {
        ISetraPaymentIntent.Terms memory t = _terms[seed % _terms.length];
        bytes32 id = intents.intentIdOf(t);
        ISetraPaymentIntent.Status beforeStatus = intents.recordOf(id).status;
        vm.prank(asMerchant ? merchant : payers[1]);
        try intents.refund(t) {
            if (!asMerchant || beforeStatus != ISetraPaymentIntent.Status.Paid) illegalTransitionObserved = true;
            ghostMerchantNet -= t.amount;
            ghostStatus[id] = ISetraPaymentIntent.Status.Refunded;
        } catch {}
    }

    function warp(uint256 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 1, 2 days));
    }
}

contract SetraPaymentIntentInvariantTest is Test {
    SetraPaymentIntent internal intents;
    MockUSDC internal usdc;
    IntentHandler internal handler;
    uint256 internal merchantStart;

    function setUp() public {
        intents = new SetraPaymentIntent();
        usdc = new MockUSDC();
        handler = new IntentHandler(intents, usdc);
        merchantStart = usdc.balanceOf(handler.merchant());
        targetContract(address(handler));
    }

    /// The contract is non-custodial: it never holds a token balance.
    function invariant_neverHoldsFunds() public view {
        assertEq(usdc.balanceOf(address(intents)), 0);
    }

    /// Every intent is paid at most once.
    function invariant_paidAtMostOnce() public view {
        for (uint256 i; i < handler.termsCount(); i++) {
            assertLe(handler.paidCount(intents.intentIdOf(handler.termsAt(i))), 1);
        }
    }

    /// The merchant's balance moves exactly by what was paid minus what was refunded.
    function invariant_merchantAccountingExact() public view {
        assertEq(usdc.balanceOf(handler.merchant()), merchantStart + handler.ghostMerchantNet());
    }

    /// Stored status always equals the last legal transition; no illegal transition ever succeeded.
    function invariant_stateMachine() public view {
        assertFalse(handler.illegalTransitionObserved());
        for (uint256 i; i < handler.termsCount(); i++) {
            bytes32 id = intents.intentIdOf(handler.termsAt(i));
            assertEq(uint8(intents.recordOf(id).status), uint8(handler.ghostStatus(id)));
        }
    }
}
