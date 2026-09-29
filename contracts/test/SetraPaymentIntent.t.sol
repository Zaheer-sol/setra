// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {SetraPaymentIntent} from "../src/SetraPaymentIntent.sol";
import {ISetraPaymentIntent} from "../interfaces/ISetraPaymentIntent.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";
import {
    MockUSDC,
    FeeOnTransferToken,
    FalseReturningToken,
    NoReturnToken,
    ReentrantToken,
    IPay
} from "./mocks/Tokens.sol";

contract SetraPaymentIntentTest is Test {
    SetraPaymentIntent internal intents;
    MockUSDC internal usdc;

    address internal merchant = makeAddr("merchant");
    address internal payer;
    uint256 internal payerKey;
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AMOUNT = 2_000e6; // $2,000.00 USDC

    event PaymentIntentPaid(
        bytes32 indexed intentId, address indexed merchant, address indexed payer, address token, uint256 amount, bytes32 ref
    );
    event PaymentIntentCancelled(bytes32 indexed intentId, address indexed merchant, bytes32 ref);
    event PaymentIntentRefunded(
        bytes32 indexed intentId, address indexed merchant, address indexed payer, address token, uint256 amount, bytes32 ref
    );

    function setUp() public {
        vm.warp(1_760_000_000);
        intents = new SetraPaymentIntent();
        usdc = new MockUSDC();
        (payer, payerKey) = makeAddrAndKey("payer");
        usdc.mint(payer, 1_000_000e6);
        vm.prank(payer);
        usdc.approve(address(intents), type(uint256).max);
    }

    function _terms() internal view returns (ISetraPaymentIntent.Terms memory) {
        return ISetraPaymentIntent.Terms({
            merchant: merchant,
            token: address(usdc),
            amount: AMOUNT,
            expiresAt: uint64(block.timestamp + 7 days),
            ref: keccak256("pi_01J9Z3INV2041")
        });
    }

    // ── identity ──────────────────────────────────────────────────────────────────────────────

    function test_intentId_commitsToEveryTerm() public view {
        ISetraPaymentIntent.Terms memory t = _terms();
        bytes32 id = intents.intentIdOf(t);
        assertEq(
            id, keccak256(abi.encode(block.chainid, address(intents), t.merchant, t.token, t.amount, t.expiresAt, t.ref))
        );

        ISetraPaymentIntent.Terms memory changed = _terms();
        changed.amount = AMOUNT - 1;
        assertTrue(intents.intentIdOf(changed) != id);
        changed = _terms();
        changed.merchant = stranger;
        assertTrue(intents.intentIdOf(changed) != id);
        changed = _terms();
        changed.token = address(0xBEEF);
        assertTrue(intents.intentIdOf(changed) != id);
        changed = _terms();
        changed.expiresAt += 1;
        assertTrue(intents.intentIdOf(changed) != id);
        changed = _terms();
        changed.ref = bytes32(uint256(1));
        assertTrue(intents.intentIdOf(changed) != id);
    }

    function test_intentId_isDomainSeparatedByChainAndDeployment() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        bytes32 id = intents.intentIdOf(t);
        SetraPaymentIntent other = new SetraPaymentIntent();
        assertTrue(other.intentIdOf(t) != id, "other deployment");
        vm.chainId(10143);
        assertTrue(intents.intentIdOf(t) != id, "other chain");
    }

    // ── pay ───────────────────────────────────────────────────────────────────────────────────

    function test_pay_movesFundsDirectlyToMerchantAndEmits() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        bytes32 id = intents.intentIdOf(t);

        vm.expectEmit(true, true, true, true, address(intents));
        emit PaymentIntentPaid(id, merchant, payer, address(usdc), AMOUNT, t.ref);
        vm.prank(payer);
        assertEq(intents.pay(t), id);

        assertEq(usdc.balanceOf(merchant), AMOUNT);
        assertEq(usdc.balanceOf(address(intents)), 0, "contract never holds funds");
        assertEq(uint8(intents.stateOf(t)), uint8(ISetraPaymentIntent.State.Paid));
        ISetraPaymentIntent.Record memory record = intents.recordOf(id);
        assertEq(record.payer, payer);
        assertEq(record.paidAt, block.timestamp);
    }

    function test_pay_emitsExactlyOneTransferAndOnePaidEvent() public {
        vm.recordLogs();
        vm.prank(payer);
        intents.pay(_terms());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "Transfer + PaymentIntentPaid");
        assertEq(logs[0].emitter, address(usdc));
        assertEq(logs[1].emitter, address(intents));
    }

    function test_pay_twice_reverts() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        vm.startPrank(payer);
        intents.pay(t);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISetraPaymentIntent.InvalidTransition.selector,
                ISetraPaymentIntent.Status.Paid,
                ISetraPaymentIntent.Status.Paid
            )
        );
        intents.pay(t);
        vm.stopPrank();
        assertEq(usdc.balanceOf(merchant), AMOUNT, "no second debit");
    }

    function test_pay_byAnotherPayer_afterPaid_reverts() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        vm.prank(payer);
        intents.pay(t);
        usdc.mint(stranger, AMOUNT);
        vm.startPrank(stranger);
        usdc.approve(address(intents), AMOUNT);
        vm.expectRevert();
        intents.pay(t);
        vm.stopPrank();
    }

    function test_pay_atOrAfterExpiry_reverts() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        vm.warp(t.expiresAt);
        vm.prank(payer);
        vm.expectRevert(ISetraPaymentIntent.IntentExpired.selector);
        intents.pay(t);
        assertEq(uint8(intents.stateOf(t)), uint8(ISetraPaymentIntent.State.Expired));
    }

    function test_pay_rejectsInvalidTerms() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        t.merchant = address(0);
        vm.prank(payer);
        vm.expectRevert(ISetraPaymentIntent.ZeroAddress.selector);
        intents.pay(t);

        t = _terms();
        t.token = address(0x1234); // EOA, no code
        vm.prank(payer);
        vm.expectRevert(ISetraPaymentIntent.NotAContract.selector);
        intents.pay(t);

        t = _terms();
        t.amount = 0;
        vm.prank(payer);
        vm.expectRevert(ISetraPaymentIntent.ZeroAmount.selector);
        intents.pay(t);
    }

    function test_pay_toContractItself_reverts() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        t.merchant = address(intents);
        vm.prank(payer);
        vm.expectRevert(ISetraPaymentIntent.InvalidMerchant.selector);
        intents.pay(t);
        assertEq(usdc.balanceOf(address(intents)), 0);
    }

    function test_pay_byMerchant_reverts() public {
        vm.prank(merchant);
        vm.expectRevert(ISetraPaymentIntent.PayerIsMerchant.selector);
        intents.pay(_terms());
    }

    function test_pay_withoutAllowance_reverts() public {
        usdc.mint(stranger, AMOUNT);
        vm.prank(stranger);
        vm.expectRevert(SafeTransfer.TokenCallFailed.selector);
        intents.pay(_terms());
        assertEq(uint8(intents.stateOf(_terms())), uint8(ISetraPaymentIntent.State.Open), "state rolled back");
    }

    function test_pay_withPermit() public {
        address fresh;
        uint256 freshKey;
        (fresh, freshKey) = makeAddrAndKey("fresh");
        usdc.mint(fresh, AMOUNT);
        ISetraPaymentIntent.Terms memory t = _terms();
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(usdc.PERMIT_TYPEHASH(), fresh, address(intents), AMOUNT, 0, deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(freshKey, digest);

        vm.prank(fresh);
        intents.payWithPermit(t, deadline, v, r, s);
        assertEq(usdc.balanceOf(merchant), AMOUNT);
    }

    function test_payWithPermit_survivesFrontRunPermit() public {
        address fresh;
        uint256 freshKey;
        (fresh, freshKey) = makeAddrAndKey("fresh");
        usdc.mint(fresh, AMOUNT);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(usdc.PERMIT_TYPEHASH(), fresh, address(intents), AMOUNT, 0, deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(freshKey, digest);
        // An attacker submits the permit first. The nonce is consumed, so the inner permit call fails.
        usdc.permit(fresh, address(intents), AMOUNT, deadline, v, r, s);

        vm.prank(fresh);
        intents.payWithPermit(_terms(), deadline, v, r, s);
        assertEq(usdc.balanceOf(merchant), AMOUNT);
    }

    // ── cancel ────────────────────────────────────────────────────────────────────────────────

    function test_cancel_byMerchant_blocksPayment() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        bytes32 id = intents.intentIdOf(t);
        vm.expectEmit(true, true, false, true, address(intents));
        emit PaymentIntentCancelled(id, merchant, t.ref);
        vm.prank(merchant);
        intents.cancel(t);
        assertEq(uint8(intents.stateOf(t)), uint8(ISetraPaymentIntent.State.Cancelled));

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISetraPaymentIntent.InvalidTransition.selector,
                ISetraPaymentIntent.Status.Cancelled,
                ISetraPaymentIntent.Status.Paid
            )
        );
        intents.pay(t);
    }

    function test_cancel_byStranger_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(ISetraPaymentIntent.Unauthorized.selector);
        intents.cancel(_terms());
    }

    function test_cancel_afterPaid_reverts() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        vm.prank(payer);
        intents.pay(t);
        vm.prank(merchant);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISetraPaymentIntent.InvalidTransition.selector,
                ISetraPaymentIntent.Status.Paid,
                ISetraPaymentIntent.Status.Cancelled
            )
        );
        intents.cancel(t);
    }

    // ── refund ────────────────────────────────────────────────────────────────────────────────

    function test_refund_returnsFundsToOriginalPayer() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        bytes32 id = intents.intentIdOf(t);
        vm.prank(payer);
        intents.pay(t);
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.startPrank(merchant);
        usdc.approve(address(intents), AMOUNT);
        vm.expectEmit(true, true, true, true, address(intents));
        emit PaymentIntentRefunded(id, merchant, payer, address(usdc), AMOUNT, t.ref);
        intents.refund(t);
        vm.stopPrank();

        assertEq(usdc.balanceOf(payer), payerBefore + AMOUNT);
        assertEq(usdc.balanceOf(merchant), 0);
        assertEq(uint8(intents.stateOf(t)), uint8(ISetraPaymentIntent.State.Refunded));
    }

    function test_refund_twice_reverts() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        vm.prank(payer);
        intents.pay(t);
        vm.startPrank(merchant);
        usdc.approve(address(intents), type(uint256).max);
        intents.refund(t);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISetraPaymentIntent.InvalidTransition.selector,
                ISetraPaymentIntent.Status.Refunded,
                ISetraPaymentIntent.Status.Refunded
            )
        );
        intents.refund(t);
        vm.stopPrank();
    }

    function test_refund_unpaid_reverts() public {
        vm.prank(merchant);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISetraPaymentIntent.InvalidTransition.selector,
                ISetraPaymentIntent.Status.Open,
                ISetraPaymentIntent.Status.Refunded
            )
        );
        intents.refund(_terms());
    }

    function test_refund_byStranger_reverts() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        vm.prank(payer);
        intents.pay(t);
        vm.prank(stranger);
        vm.expectRevert(ISetraPaymentIntent.Unauthorized.selector);
        intents.refund(t);
    }

    function test_refundedIntent_cannotBePaidAgain() public {
        ISetraPaymentIntent.Terms memory t = _terms();
        vm.prank(payer);
        intents.pay(t);
        vm.startPrank(merchant);
        usdc.approve(address(intents), AMOUNT);
        intents.refund(t);
        vm.stopPrank();
        vm.prank(payer);
        vm.expectRevert();
        intents.pay(t);
    }

    // ── hostile tokens ────────────────────────────────────────────────────────────────────────

    function test_feeOnTransferToken_isRejected() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        fee.mint(payer, AMOUNT);
        vm.prank(payer);
        fee.approve(address(intents), AMOUNT);
        ISetraPaymentIntent.Terms memory t = _terms();
        t.token = address(fee);
        vm.prank(payer);
        vm.expectRevert(ISetraPaymentIntent.InexactTransfer.selector);
        intents.pay(t);
    }

    function test_falseReturningToken_isRejected() public {
        FalseReturningToken bad = new FalseReturningToken();
        ISetraPaymentIntent.Terms memory t = _terms();
        t.token = address(bad);
        vm.prank(payer);
        vm.expectRevert(SafeTransfer.TokenCallFailed.selector);
        intents.pay(t);
    }

    function test_noReturnToken_isSupported() public {
        NoReturnToken usdt = new NoReturnToken();
        usdt.mint(payer, AMOUNT);
        vm.prank(payer);
        usdt.approve(address(intents), AMOUNT);
        ISetraPaymentIntent.Terms memory t = _terms();
        t.token = address(usdt);
        vm.prank(payer);
        intents.pay(t);
        assertEq(usdt.balanceOf(merchant), AMOUNT);
    }

    function test_reentrantToken_cannotReenter() public {
        ReentrantToken evil = new ReentrantToken();
        evil.mint(payer, AMOUNT * 2);
        vm.prank(payer);
        evil.approve(address(intents), type(uint256).max);
        ISetraPaymentIntent.Terms memory t = _terms();
        t.token = address(evil);
        IPay.Terms memory second =
            IPay.Terms({merchant: merchant, token: address(evil), amount: AMOUNT, expiresAt: t.expiresAt, ref: bytes32("x")});
        evil.arm(address(intents), second);
        vm.prank(payer);
        vm.expectRevert(SafeTransfer.TokenCallFailed.selector);
        intents.pay(t);
        assertEq(uint8(intents.stateOf(t)), uint8(ISetraPaymentIntent.State.Open));
        assertEq(evil.balanceOf(merchant), 0);
    }

    // ── fuzz ──────────────────────────────────────────────────────────────────────────────────

    function testFuzz_pay_transfersExactAmount(uint256 amount, uint64 ttl, bytes32 ref) public {
        amount = bound(amount, 1, 1_000_000e6);
        ttl = uint64(bound(ttl, 1, 365 days));
        ISetraPaymentIntent.Terms memory t = ISetraPaymentIntent.Terms({
            merchant: merchant,
            token: address(usdc),
            amount: amount,
            expiresAt: uint64(block.timestamp) + ttl,
            ref: ref
        });
        uint256 before = usdc.balanceOf(payer);
        vm.prank(payer);
        intents.pay(t);
        assertEq(usdc.balanceOf(merchant), amount);
        assertEq(before - usdc.balanceOf(payer), amount);
    }

    function testFuzz_onlyMerchantCanCancel(address caller) public {
        vm.assume(caller != merchant);
        vm.prank(caller);
        vm.expectRevert(ISetraPaymentIntent.Unauthorized.selector);
        intents.cancel(_terms());
    }

    function testFuzz_expiredNeverPayable(uint64 lateBy) public {
        ISetraPaymentIntent.Terms memory t = _terms();
        vm.warp(uint256(t.expiresAt) + bound(lateBy, 0, 3650 days));
        vm.prank(payer);
        vm.expectRevert(ISetraPaymentIntent.IntentExpired.selector);
        intents.pay(t);
    }
}
