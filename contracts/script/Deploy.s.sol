// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ArcArbExecutor} from "../src/ArcArbExecutor.sol";

/// @notice Deploys ArcArbExecutor.
///
/// Environment:
///   POOL_MANAGER  Uniswap v4 PoolManager (Arc mainnet: 0x8366a39CC670B4001A1121B8F6A443A643e40951)
///   OWNER         cold key that can withdraw profit (defaults to the deployer)
///   OPERATOR      bot hot key allowed to call execute (defaults to the deployer)
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --private-key $DEPLOYER_KEY --broadcast
contract Deploy is Script {
    function run() external returns (ArcArbExecutor executor) {
        address poolManager = vm.envOr("POOL_MANAGER", address(0x8366a39CC670B4001A1121B8F6A443A643e40951));
        address deployer = msg.sender;
        address owner = vm.envOr("OWNER", deployer);
        address operator = vm.envOr("OPERATOR", deployer);

        require(poolManager.code.length > 0, "POOL_MANAGER has no code on this chain");

        vm.startBroadcast();
        executor = new ArcArbExecutor(IPoolManager(poolManager), owner, operator);
        vm.stopBroadcast();

        console.log("ArcArbExecutor deployed at", address(executor));
        console.log("  poolManager", poolManager);
        console.log("  owner      ", owner);
        console.log("  operator   ", operator);
    }
}
