// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {ArcArbExecutor} from "../../src/ArcArbExecutor.sol";

/// @dev Hostile v3-style pool per the reviewer's scenario: returns a little output, then in the
///      callback demands `amountIn + extra` of the hop's input token (the executor's entire balance).
///      `splits` > 1 spreads the demand over several callbacks to probe the running allowance.
contract OverchargePool {
    MockERC20 immutable t0;
    MockERC20 immutable t1;
    uint256 immutable extra;
    uint256 immutable splits;

    constructor(MockERC20 _t0, MockERC20 _t1, uint256 _extra, uint256 _splits) {
        t0 = _t0;
        t1 = _t1;
        extra = _extra;
        splits = _splits;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata)
        external
        returns (int256 amount0, int256 amount1)
    {
        (MockERC20 tokenIn, MockERC20 tokenOut) = zeroForOne ? (t0, t1) : (t1, t0);
        uint256 give = uint256(amountSpecified) * 2; // generous "output" so the start-currency gate passes
        tokenOut.transfer(recipient, give);
        uint256 demand = tokenIn.balanceOf(recipient) + extra; // everything the executor holds (and more)
        uint256 per = demand / splits;
        for (uint256 i = 0; i < splits; ++i) {
            (bool ok, bytes memory ret) = msg.sender.call(
                abi.encodeWithSelector(
                    ArcArbExecutor.uniswapV3SwapCallback.selector,
                    zeroForOne ? int256(per) : -int256(give),
                    zeroForOne ? -int256(give) : int256(per),
                    ""
                )
            );
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret)) // bubble the executor's own error
                }
            }
        }
        (amount0, amount1) = zeroForOne ? (int256(demand), -int256(give)) : (-int256(give), int256(demand));
    }
}

contract DrainViaV3CallbackTest is Deployers {
    ArcArbExecutor internal exec;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    ArcArbExecutor.Guard[] internal NO_GUARDS;

    MockERC20 internal t0;
    MockERC20 internal t1;
    PoolKey internal poolA;
    ModifyLiquidityParams internal WIDE =
        ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100e18, salt: 0});

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));
        (poolA,) = initPool(currency0, currency1, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(poolA, WIDE, ZERO_BYTES);
        exec = new ArcArbExecutor(manager, owner, operator);
        t0.transfer(address(exec), 100e18); // accumulated profit in the hop's input token
    }

    function _steps(address evil) internal view returns (ArcArbExecutor.Step[] memory steps) {
        steps = new ArcArbExecutor.Step[](2);
        steps[0] = ArcArbExecutor.Step({kind: 0, zeroForOne: false, pool: address(0), key: poolA}); // t1 -> t0 (v4)
        steps[1] = ArcArbExecutor.Step({
            kind: 1,
            zeroForOne: true, // t0 -> t1 on the hostile pool
            pool: evil,
            key: PoolKey({currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 0, hooks: IHooks(address(0))})
        });
    }

    /// Exact reviewer scenario: one callback demanding amountIn + 100e18 of token0.
    function test_overchargeSingleCallback_reverts() public {
        OverchargePool evil = new OverchargePool(t0, t1, 1, 1);
        t1.transfer(address(evil), 1e18);
        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.CallbackOverpay.selector);
        exec.execute(_steps(address(evil)), 0.01e18, 0, NO_GUARDS);
        assertEq(t0.balanceOf(address(exec)), 100e18, "nothing drained");
        assertEq(t0.balanceOf(address(evil)), 0);
    }

    /// Spreading the demand over many callbacks must not escape the running allowance.
    function test_overchargeSplitCallbacks_reverts() public {
        OverchargePool evil = new OverchargePool(t0, t1, 1, 7);
        t1.transfer(address(evil), 1e18);
        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.CallbackOverpay.selector);
        exec.execute(_steps(address(evil)), 0.01e18, 0, NO_GUARDS);
        assertEq(t0.balanceOf(address(exec)), 100e18, "nothing drained");
    }

    /// Callback outside any v3 hop (e.g. from a later hook or a stray caller) is rejected.
    function test_strayCallback_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.UnexpectedCallback.selector, address(this)));
        exec.uniswapV3SwapCallback(int256(1), -int256(1), "");
        assertEq(t0.balanceOf(address(exec)), 100e18);
    }
}
