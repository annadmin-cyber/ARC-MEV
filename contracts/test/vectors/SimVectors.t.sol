// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice End-to-end reference vectors for src/math/simulate.ts: real PoolManager swaps over a
/// multi-range pool. Run: forge test --match-path 'test/vectors/*' -vv
/// Lines starting with "V|" are parsed into test/math/fixtures.ts.
import {Test, console} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

contract SimVectors is Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    PoolKey internal keyMain; // 0.30%, tick spacing 60, no protocol fee
    PoolKey internal keyPf; // 0.05%, tick spacing 10, protocol fee 500 (0->1) / 1000 (1->0)

    int24[6] internal TICKS = [int24(-600), -120, 60, 180, 600, 1200];
    int24[6] internal TICKS_PF = [int24(-500), -100, 50, 150, 500, 1000];

    function s(uint256 v) internal pure returns (string memory) {
        return vm.toString(v);
    }

    function s(int256 v) internal pure returns (string memory) {
        return vm.toString(v);
    }

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        (keyMain,) = initPool(currency0, currency1, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        _add(keyMain, -600, 600, 100e18);
        _add(keyMain, -120, 180, 50e18);
        _add(keyMain, 60, 1200, 30e18);

        (keyPf,) = initPool(currency0, currency1, IHooks(address(0)), 500, 10, SQRT_PRICE_1_1);
        vm.prank(feeController);
        manager.setProtocolFee(keyPf, uint24(500) | (uint24(1000) << 12));
        _add(keyPf, -500, 500, 100e18);
        _add(keyPf, -100, 150, 50e18);
        _add(keyPf, 50, 1000, 30e18);
    }

    function _add(PoolKey memory k, int24 lower, int24 upper, int256 liquidity) internal {
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: liquidity, salt: 0}), ZERO_BYTES
        );
    }

    function _logPool(string memory name, PoolKey memory k, int24[6] memory ticks) internal view {
        PoolId id = k.toId();
        (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee) = manager.getSlot0(id);
        uint128 liquidity = manager.getLiquidity(id);
        console.log(
            string.concat(
                "V|pool|", name, "|", s(int256(k.tickSpacing)), "|", s(uint256(sqrtPriceX96)), "|", s(int256(tick)), "|",
                s(uint256(protocolFee)), "|", s(uint256(lpFee)), "|", s(uint256(liquidity))
            )
        );
        for (uint256 i = 0; i < ticks.length; i++) {
            (uint128 gross, int128 net,,) = manager.getTickInfo(id, ticks[i]);
            console.log(string.concat("V|tick|", name, "|", s(int256(ticks[i])), "|", s(uint256(gross)), "|", s(int256(net))));
        }
    }

    function _logSwap(string memory name, PoolKey memory k, bool zeroForOne, int256 amountSpecified) internal {
        uint256 snap = vm.snapshotState();
        BalanceDelta delta = swap(k, zeroForOne, amountSpecified, ZERO_BYTES);
        PoolId id = k.toId();
        (uint160 sqrtPriceX96, int24 tick,,) = manager.getSlot0(id);
        uint128 liquidity = manager.getLiquidity(id);
        console.log(
            string.concat(
                "V|swap|", name, "|", zeroForOne ? "1" : "0", "|", s(amountSpecified), "|", s(uint256(sqrtPriceX96)), "|",
                s(int256(tick)), "|", s(uint256(liquidity)), "|", s(int256(delta.amount0())), "|", s(int256(delta.amount1()))
            )
        );
        vm.revertToState(snap);
    }

    function test_simVectors() public {
        _logPool("main", keyMain, TICKS);
        // independent swaps from the same initial state
        _logSwap("main", keyMain, true, -0.01e18);
        _logSwap("main", keyMain, true, -1e18);
        _logSwap("main", keyMain, true, -3e18);
        _logSwap("main", keyMain, false, -0.01e18);
        _logSwap("main", keyMain, false, -1e18);
        _logSwap("main", keyMain, false, -3e18);
        _logSwap("main", keyMain, false, -7e18);
        // exhausts all liquidity below -600: partial fill up to the price limit
        _logSwap("main", keyMain, true, -50e18);
        // exact output
        _logSwap("main", keyMain, true, 1e18);
        _logSwap("main", keyMain, false, 2.5e18);

        // sequential: state after swap A is the starting state of swap B
        swap(keyMain, true, -1e18, ZERO_BYTES);
        _logPool("afterA", keyMain, TICKS);
        _logSwap("afterA", keyMain, false, -2e18);
        _logSwap("afterA", keyMain, true, -1.5e18);

        _logPool("pf", keyPf, TICKS_PF);
        _logSwap("pf", keyPf, true, -1e18);
        _logSwap("pf", keyPf, false, -1e18);
        _logSwap("pf", keyPf, true, -2.5e18);
        _logSwap("pf", keyPf, false, 0.7e18);
    }
}
