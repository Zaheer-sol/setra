// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {SetraPaymentIntent} from "../src/SetraPaymentIntent.sol";

/// @notice Deploys SetraPaymentIntent. The contract has no constructor arguments, owner or admin.
///
/// Monad testnet:
///   forge script script/DeployPaymentIntent.s.sol --rpc-url https://testnet-rpc.monad.xyz \
///     --account <keystore-name> --broadcast
/// Then record the deployment for Setra:
///   npm run contracts:record -- --network monad-testnet
contract DeployPaymentIntent is Script {
    function run() external returns (SetraPaymentIntent deployed) {
        vm.startBroadcast();
        deployed = new SetraPaymentIntent();
        vm.stopBroadcast();
        console2.log("SetraPaymentIntent", address(deployed));
        console2.log("chainId", block.chainid);
        console2.log("block", block.number);
    }
}
