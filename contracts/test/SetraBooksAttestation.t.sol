// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {SetraBooksAttestation} from "../src/SetraBooksAttestation.sol";

contract SetraBooksAttestationTest is Test {
    SetraBooksAttestation internal books;

    address internal business = makeAddr("business");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant BOOK = keccak256("setra-books:org_1:live");
    bytes32 internal constant ROOT = keccak256("root-august");
    uint32 internal constant AUGUST = 202_608;

    event BooksAttested(
        address indexed publisher, bytes32 indexed book, uint32 indexed period, bytes32 root, uint32 entryCount, uint32 version
    );
    event BooksPublished(
        address indexed publisher, bytes32 indexed book, uint32 indexed period, uint32 version, bytes encryptedBooks, bytes statements
    );

    function setUp() public {
        vm.warp(1_790_000_000);
        books = new SetraBooksAttestation();
    }

    function test_attest_recordsAndEmits() public {
        vm.expectEmit(true, true, true, true, address(books));
        emit BooksAttested(business, BOOK, AUGUST, ROOT, 42, 1);
        vm.prank(business);
        uint32 version = books.attest(BOOK, AUGUST, ROOT, 42);

        assertEq(version, 1);
        SetraBooksAttestation.Attestation memory a = books.latest(business, BOOK, AUGUST);
        assertEq(a.root, ROOT);
        assertEq(a.entryCount, 42);
        assertEq(a.version, 1);
        assertEq(a.publishedAt, 1_790_000_000);
    }

    function test_attestAgain_bumpsVersionAndReplacesLatest() public {
        vm.startPrank(business);
        books.attest(BOOK, AUGUST, ROOT, 42);
        bytes32 corrected = keccak256("root-august-after-reopen");
        vm.warp(1_790_086_400);
        uint32 version = books.attest(BOOK, AUGUST, corrected, 43);
        vm.stopPrank();

        assertEq(version, 2);
        SetraBooksAttestation.Attestation memory a = books.latest(business, BOOK, AUGUST);
        assertEq(a.root, corrected);
        assertEq(a.entryCount, 43);
        assertEq(a.version, 2);
        assertEq(a.publishedAt, 1_790_086_400);
    }

    function test_attestationsBelongToTheirPublisher() public {
        vm.prank(business);
        books.attest(BOOK, AUGUST, ROOT, 42);
        // A stranger attesting the same book and month writes only their own record.
        vm.prank(stranger);
        books.attest(BOOK, AUGUST, keccak256("forged"), 1);

        assertEq(books.latest(business, BOOK, AUGUST).root, ROOT);
        assertEq(books.latest(business, BOOK, AUGUST).version, 1);
        assertEq(books.latest(stranger, BOOK, AUGUST).root, keccak256("forged"));
    }

    function test_monthsAndBooksAreIndependent() public {
        vm.startPrank(business);
        books.attest(BOOK, AUGUST, ROOT, 42);
        books.attest(BOOK, 202_609, keccak256("root-september"), 10);
        books.attest(keccak256("setra-books:org_1:test"), AUGUST, keccak256("test-mode"), 3);
        vm.stopPrank();

        assertEq(books.latest(business, BOOK, AUGUST).root, ROOT);
        assertEq(books.latest(business, BOOK, 202_609).root, keccak256("root-september"));
        assertEq(books.latest(business, keccak256("setra-books:org_1:test"), AUGUST).root, keccak256("test-mode"));
    }

    function test_latest_isEmptyWhenNothingWasAttested() public view {
        SetraBooksAttestation.Attestation memory a = books.latest(business, BOOK, AUGUST);
        assertEq(a.root, bytes32(0));
        assertEq(a.version, 0);
    }

    function test_revert_emptyRoot() public {
        vm.prank(business);
        vm.expectRevert(SetraBooksAttestation.EmptyRoot.selector);
        books.attest(BOOK, AUGUST, bytes32(0), 1);
    }

    function test_revert_invalidPeriods() public {
        uint32[5] memory bad = [uint32(202_600), 202_613, 199_912, 2026, 1_000_001];
        vm.startPrank(business);
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(SetraBooksAttestation.InvalidPeriod.selector, bad[i]));
            books.attest(BOOK, bad[i], ROOT, 1);
        }
        vm.stopPrank();
    }

    function testFuzz_validMonthsAreAccepted(uint16 year, uint8 month, bytes32 root) public {
        vm.assume(root != bytes32(0));
        uint32 period = uint32(bound(year, 2000, 9999)) * 100 + uint32(bound(month, 1, 12));
        vm.prank(business);
        assertEq(books.attest(BOOK, period, root, 1), 1);
        assertEq(books.latest(business, BOOK, period).root, root);
    }

    function test_publish_attestsAndCarriesTheBooks() public {
        bytes memory encrypted = hex"5342010203040506070809";
        bytes memory statements = bytes('{"v":1,"revenue":"1200.00"}');
        vm.expectEmit(true, true, true, true, address(books));
        emit BooksAttested(business, BOOK, AUGUST, ROOT, 42, 1);
        vm.expectEmit(true, true, true, true, address(books));
        emit BooksPublished(business, BOOK, AUGUST, 1, encrypted, statements);
        vm.prank(business);
        assertEq(books.publish(BOOK, AUGUST, ROOT, 42, encrypted, statements), 1);
        assertEq(books.latest(business, BOOK, AUGUST).root, ROOT);
    }

    function test_publish_withoutPayloadsIsJustAnAttestation() public {
        vm.recordLogs();
        vm.prank(business);
        books.publish(BOOK, AUGUST, ROOT, 42, "", "");
        assertEq(vm.getRecordedLogs().length, 1, "only BooksAttested");
        assertEq(books.latest(business, BOOK, AUGUST).version, 1);
    }

    function test_publish_sharesVersionsWithAttest() public {
        vm.startPrank(business);
        books.attest(BOOK, AUGUST, ROOT, 42);
        assertEq(books.publish(BOOK, AUGUST, keccak256("v2"), 43, "", bytes("{}")), 2);
        vm.stopPrank();
    }

    function test_revert_publish_payloadTooLarge() public {
        bytes memory tooBig = new bytes(books.MAX_PAYLOAD() + 1);
        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(SetraBooksAttestation.PayloadTooLarge.selector, tooBig.length));
        books.publish(BOOK, AUGUST, ROOT, 1, tooBig, "");
        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(SetraBooksAttestation.PayloadTooLarge.selector, tooBig.length));
        books.publish(BOOK, AUGUST, ROOT, 1, "", tooBig);
    }

    function test_revert_publish_emptyRoot() public {
        vm.prank(business);
        vm.expectRevert(SetraBooksAttestation.EmptyRoot.selector);
        books.publish(BOOK, AUGUST, bytes32(0), 1, "", bytes("{}"));
    }
}
