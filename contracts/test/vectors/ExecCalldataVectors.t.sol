// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {ArcArbExecutor} from "../../src/ArcArbExecutor.sol";

/// @notice Reference vector for `src/exec/encode.ts` (`encodeExecute`): the calldata Solidity's
///         `abi.encodeCall` produces for the fixture in `test/exec/helpers.ts`. Run with
///         `forge test --match-contract ExecCalldataVectors -vv` and compare with
///         `npx tsx test/exec/calldata-vector.ts` (both print the same hex).
contract ExecCalldataVectors is Test {
    address constant TOKEN_B = 0xC8c256e41C6Cc5FCBf6a8E3b1b53f5778F033E22;
    address constant HOOK = 0x00000000000000000000000000000000000000C0;
    bytes32 constant P1 = 0x00000000000000000000000000000000000000000000000000000000000000a1;
    bytes32 constant P2 = 0x00000000000000000000000000000000000000000000000000000000000000a2;

    function test_executeCalldata() public pure {
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = ArcArbExecutor.Step({
            kind: 0,
            zeroForOne: true,
            pool: address(0),
            key: PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(TOKEN_B),
                fee: 3000,
                tickSpacing: 60,
                hooks: IHooks(address(0))
            })
        });
        steps[1] = ArcArbExecutor.Step({
            kind: 0,
            zeroForOne: false,
            pool: address(0),
            key: PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(TOKEN_B),
                fee: 10000,
                tickSpacing: 200,
                hooks: IHooks(HOOK)
            })
        });
        uint160 q96 = uint160(1) << 96;
        ArcArbExecutor.Guard[] memory guards = new ArcArbExecutor.Guard[](2);
        guards[0] = ArcArbExecutor.Guard({kind: 0, poolId: P1, expected: q96 + q96 / 50, toleranceBps: 2});
        guards[1] = ArcArbExecutor.Guard({kind: 0, poolId: P2, expected: q96 - q96 / 50, toleranceBps: 2});

        bytes memory data =
            abi.encodeCall(ArcArbExecutor.execute, (steps, 1234567890123456789, 50000000000000000, guards));
        console.log("EXECUTE_CALLDATA");
        console.logBytes(data);
    }
}
