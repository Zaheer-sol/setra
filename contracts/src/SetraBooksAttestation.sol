// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title SetraBooksAttestation
/// @notice A business publishes a fingerprint of a closed accounting month from its own wallet, so
///         anyone it shares its books with (an accountant, an auditor, an investor) can check later
///         that those books are the ones it vouched for. The fingerprint is the Merkle root of the
///         month's posted journal entries; the entries themselves stay private.
///
/// @dev    No owner, no admin, no funds, no upgrade path. An attestation belongs to the address that
///         sent it: nobody can publish, change or remove another publisher's attestations. A month
///         that was reopened and closed again is attested again, which bumps its version; every
///         version stays visible in the BooksAttested events, and `latest` returns the newest.
///
///         `book` identifies the set of books (Setra derives it from the workspace and its mode), and
///         `period` is the month as YYYYMM, e.g. 202608 for August 2026.
///
///         `publish` does the same and, in the same transaction, can put the books themselves on chain
///         as event data: an encrypted copy of the month's entries (readable only with the passphrase
///         the business chose, which never leaves its browser) and/or public statements (totals anyone
///         can read). Neither is kept in contract storage; both stay in the chain's logs.
contract SetraBooksAttestation {
    /// @notice Largest encrypted-books or statements payload accepted, in bytes.
    uint256 public constant MAX_PAYLOAD = 98_304;

    struct Attestation {
        bytes32 root;
        uint32 entryCount;
        uint32 version;
        uint64 publishedAt;
    }

    mapping(address publisher => mapping(bytes32 book => mapping(uint32 period => Attestation))) private _latest;

    event BooksAttested(
        address indexed publisher, bytes32 indexed book, uint32 indexed period, bytes32 root, uint32 entryCount, uint32 version
    );

    event BooksPublished(
        address indexed publisher, bytes32 indexed book, uint32 indexed period, uint32 version, bytes encryptedBooks, bytes statements
    );

    error EmptyRoot();
    error InvalidPeriod(uint32 period);
    error PayloadTooLarge(uint256 length);

    /// @notice Attest to the books of one month. Sending the same month again records a new version.
    function attest(bytes32 book, uint32 period, bytes32 root, uint32 entryCount) external returns (uint32 version) {
        version = _attest(book, period, root, entryCount);
    }

    /// @notice Attest to a month's books and publish them: an encrypted copy, public statements, or both
    ///         (either may be empty). The fingerprint is recorded exactly as `attest` does.
    function publish(
        bytes32 book,
        uint32 period,
        bytes32 root,
        uint32 entryCount,
        bytes calldata encryptedBooks,
        bytes calldata statements
    ) external returns (uint32 version) {
        if (encryptedBooks.length > MAX_PAYLOAD) revert PayloadTooLarge(encryptedBooks.length);
        if (statements.length > MAX_PAYLOAD) revert PayloadTooLarge(statements.length);
        version = _attest(book, period, root, entryCount);
        if (encryptedBooks.length != 0 || statements.length != 0) {
            emit BooksPublished(msg.sender, book, period, version, encryptedBooks, statements);
        }
    }

    function _attest(bytes32 book, uint32 period, bytes32 root, uint32 entryCount) private returns (uint32 version) {
        if (root == bytes32(0)) revert EmptyRoot();
        uint32 month = period % 100;
        if (period < 200_001 || period > 999_912 || month == 0 || month > 12) revert InvalidPeriod(period);
        Attestation storage current = _latest[msg.sender][book][period];
        version = current.version + 1;
        _latest[msg.sender][book][period] =
            Attestation({root: root, entryCount: entryCount, version: version, publishedAt: uint64(block.timestamp)});
        emit BooksAttested(msg.sender, book, period, root, entryCount, version);
    }

    /// @notice The newest attestation a publisher made for a month; all zero if there is none.
    function latest(address publisher, bytes32 book, uint32 period) external view returns (Attestation memory) {
        return _latest[publisher][book][period];
    }
}
