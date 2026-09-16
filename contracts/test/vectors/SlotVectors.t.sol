// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @notice Reference vector generator for `src/state/slots.ts`.
/// @dev Uses the exact keccak expressions from v4-core StateLibrary so the TypeScript
///      slot derivation can be checked bit-for-bit. Run with
///      `forge test --match-contract SlotVectors -vv` and copy the output into
///      `test/data/fixtures.ts`.
contract SlotVectors is Test {
    bytes32 constant POOL_ID = 0xba2b9bdf04fd659448a44ac6cabc27f8565bcdf00f58028ec9a07ccf31286514;

    function stateSlot(bytes32 poolId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(poolId, StateLibrary.POOLS_SLOT));
    }

    function tickInfoSlot(bytes32 poolId, int24 tick) internal pure returns (bytes32) {
        bytes32 ticksMappingSlot = bytes32(uint256(stateSlot(poolId)) + StateLibrary.TICKS_OFFSET);
        return keccak256(abi.encodePacked(int256(tick), ticksMappingSlot));
    }

    function bitmapWordSlot(bytes32 poolId, int16 wordPos) internal pure returns (bytes32) {
        bytes32 tickBitmapMapping = bytes32(uint256(stateSlot(poolId)) + StateLibrary.TICK_BITMAP_OFFSET);
        return keccak256(abi.encodePacked(int256(wordPos), tickBitmapMapping));
    }

    function test_printVectors() public pure {
        bytes32 s = stateSlot(POOL_ID);
        console.log("poolId");
        console.logBytes32(POOL_ID);
        console.log("stateSlot");
        console.logBytes32(s);
        console.log("slot0Slot");
        console.logBytes32(s);
        console.log("liquiditySlot");
        console.logBytes32(bytes32(uint256(s) + StateLibrary.LIQUIDITY_OFFSET));
        console.log("ticksMappingSlot");
        console.logBytes32(bytes32(uint256(s) + StateLibrary.TICKS_OFFSET));
        console.log("tickBitmapSlot");
        console.logBytes32(bytes32(uint256(s) + StateLibrary.TICK_BITMAP_OFFSET));

        int24[7] memory ticks = [int24(-887272), -60, -1, 0, 1, 60, 887272];
        for (uint256 i = 0; i < ticks.length; i++) {
            console.log("tickInfoSlot", ticks[i]);
            console.logBytes32(tickInfoSlot(POOL_ID, ticks[i]));
        }
        int16[5] memory words = [int16(-3466), -1, 0, 1, 3465];
        for (uint256 i = 0; i < words.length; i++) {
            console.log("bitmapWordSlot", words[i]);
            console.logBytes32(bitmapWordSlot(POOL_ID, words[i]));
        }
    }
}
