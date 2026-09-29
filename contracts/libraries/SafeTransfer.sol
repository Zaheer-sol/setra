// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title SafeTransfer
/// @notice Minimal ERC-20 helpers that tolerate tokens which return no value (e.g. USDT-style)
///         and reject tokens that return false or malformed data.
library SafeTransfer {
    error TokenCallFailed();

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) revert TokenCallFailed();
    }

    function balanceOf(address token, address account) internal view returns (uint256 balance) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!ok || data.length != 32) revert TokenCallFailed();
        balance = abi.decode(data, (uint256));
    }
}
