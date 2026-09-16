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

    // ---- mixed-kind plan: v4 hop, v3-style hop, v2-style hop (test/exec/helpers.ts MIXED_*) ----

    address constant TOKEN_C = 0xD1d1d1D1d1d1D1d1D1D1D1d1d1D1D1D1d1D1d1d1;
    address constant V3_POOL = 0x82916bee18fCEF517B26C72d7Cb5F13694E1dB41;
    address constant V2_PAIR = 0x5Dbf58814d0736Fa09b6Ad7f290800B805dd383D;

    function test_executeCalldata_mixed() public pure {
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](3);
        // native -> B on the v4 pool P1
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
        // B -> C on the v3-style pool (fee 500; tickSpacing / hooks are zero for non-v4 hops)
        steps[1] = ArcArbExecutor.Step({
            kind: 1,
            zeroForOne: true,
            pool: V3_POOL,
            key: PoolKey({
                currency0: Currency.wrap(TOKEN_B),
                currency1: Currency.wrap(TOKEN_C),
                fee: 500,
                tickSpacing: 0,
                hooks: IHooks(address(0))
            })
        });
        // C -> native on the v2-style pair (fee 3000 pips)
        steps[2] = ArcArbExecutor.Step({
            kind: 2,
            zeroForOne: false,
            pool: V2_PAIR,
            key: PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(TOKEN_C),
                fee: 3000,
                tickSpacing: 0,
                hooks: IHooks(address(0))
            })
        });
        uint160 q96 = uint160(1) << 96;
        ArcArbExecutor.Guard[] memory guards = new ArcArbExecutor.Guard[](3);
        guards[0] = ArcArbExecutor.Guard({kind: 0, poolId: P1, expected: q96 + q96 / 50, toleranceBps: 3});
        guards[1] = ArcArbExecutor.Guard({
            kind: 1, poolId: bytes32(uint256(uint160(V3_POOL))), expected: 2 * q96, toleranceBps: 3
        });
        guards[2] = ArcArbExecutor.Guard({
            kind: 2,
            poolId: bytes32(uint256(uint160(V2_PAIR))),
            // v2SqrtPriceX96(1_000_000e18, 2_000_000e18) = isqrt(2 * 2^192): the pair price, not reserve0
            expected: uint160(112045541949572279837463876454),
            toleranceBps: 3
        });

        bytes memory data = abi.encodeCall(ArcArbExecutor.execute, (steps, 1e18, 12345, guards));
        console.log("EXECUTE_CALLDATA_MIXED");
        console.logBytes(data);
    }
}
