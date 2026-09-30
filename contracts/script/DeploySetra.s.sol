// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {SetraPaymentIntent} from "../src/SetraPaymentIntent.sol";
import {SetraBooksAttestation} from "../src/SetraBooksAttestation.sol";

/// @notice Deploys both Setra contracts. Neither has constructor arguments, an owner or an admin.
///
/// Monad testnet (you'll be asked for your keystore password; nothing else is needed):
///   cd contracts && forge script script/DeploySetra.s.sol --rpc-url https://testnet-rpc.monad.xyz \
///     --account <keystore-name> --broadcast
/// Then record the deployment for Setra:
///   npm run contracts:record -- --network monad-testnet
contract DeploySetra is Script {
    function run() external returns (SetraPaymentIntent intents, SetraBooksAttestation books) {
        vm.startBroadcast();
        intents = new SetraPaymentIntent();
        books = new SetraBooksAttestation();
        vm.stopBroadcast();
        console2.log("SetraPaymentIntent", address(intents));
        console2.log("SetraBooksAttestation", address(books));
        console2.log("chainId", block.chainid);
        console2.log("block", block.number);
    }
}
