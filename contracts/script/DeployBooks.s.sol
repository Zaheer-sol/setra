// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {SetraBooksAttestation} from "../src/SetraBooksAttestation.sol";

/// @notice Deploys only SetraBooksAttestation (for example a new version), leaving SetraPaymentIntent
///         where it is. No constructor arguments, owner or admin.
///
///   cd contracts && forge script script/DeployBooks.s.sol --rpc-url https://testnet-rpc.monad.xyz \
///     --account <keystore-name> --broadcast
///   npm run contracts:record -- --network monad-testnet
contract DeployBooks is Script {
    function run() external returns (SetraBooksAttestation books) {
        vm.startBroadcast();
        books = new SetraBooksAttestation();
        vm.stopBroadcast();
        console2.log("SetraBooksAttestation", address(books));
        console2.log("chainId", block.chainid);
        console2.log("block", block.number);
    }
}
