// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {ArcArbExecutor} from "../../src/ArcArbExecutor.sol";

/// @dev v3-style pool that, like a real pool whose liquidity runs out before the price limit,
///      consumes only `fillPips` of the requested exact input and asks for exactly that in the
///      callback. Constant-product pricing on the consumed part.
contract PartialFillV3Pool {
    MockERC20 public immutable token0;
    MockERC20 public immutable token1;
    uint256 public immutable fillPips;

    constructor(MockERC20 _t0, MockERC20 _t1, uint256 _fillPips) {
        token0 = _t0;
        token1 = _t1;
        fillPips = _fillPips;
    }

    function quote(bool zeroForOne, uint256 amountIn) public view returns (uint256 consumed, uint256 amountOut) {
        (MockERC20 tokenIn, MockERC20 tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
        consumed = amountIn * fillPips / 1_000_000;
        uint256 rIn = tokenIn.balanceOf(address(this));
        uint256 rOut = tokenOut.balanceOf(address(this));
        uint256 withFee = consumed * 997_000;
        amountOut = (withFee * rOut) / (rIn * 1_000_000 + withFee);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        (uint256 consumed, uint256 amountOut) = quote(zeroForOne, uint256(amountSpecified));
        (MockERC20 tokenIn, MockERC20 tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 rIn = tokenIn.balanceOf(address(this));
        tokenOut.transfer(recipient, amountOut);
        (amount0, amount1) =
            zeroForOne ? (int256(consumed), -int256(amountOut)) : (-int256(amountOut), int256(consumed));
        (bool ok,) = msg.sender.call(
            abi.encodeWithSelector(ArcArbExecutor.uniswapV3SwapCallback.selector, amount0, amount1, data)
        );
        require(ok, "callback failed");
        require(tokenIn.balanceOf(address(this)) >= rIn + consumed, "not paid");
    }
}

contract PartialFillV3Test is Deployers {
    ArcArbExecutor internal exec;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    ArcArbExecutor.Guard[] internal NO_GUARDS;
    PoolKey internal poolA;
    MockERC20 internal t0;
    MockERC20 internal t1;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));
        (poolA,) = initPool(currency0, currency1, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            poolA, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100e18, salt: 0}), ZERO_BYTES
        );
        exec = new ArcArbExecutor(manager, owner, operator);
    }

    function _v4(PoolKey memory key, bool zeroForOne) internal pure returns (ArcArbExecutor.Step memory) {
        return ArcArbExecutor.Step({kind: 0, zeroForOne: zeroForOne, pool: address(0), key: key});
    }

    function _v3(address pool, bool zeroForOne) internal view returns (ArcArbExecutor.Step memory) {
        return ArcArbExecutor.Step({
            kind: 1,
            zeroForOne: zeroForOne,
            pool: pool,
            key: PoolKey({currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 0, hooks: IHooks(address(0))})
        });
    }

    /// @dev Quote a v4 exact-input swap on poolA without changing state.
    function _quoteV4(bool zeroForOne, uint256 amountIn) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        BalanceDelta d = swap(poolA, zeroForOne, -int256(amountIn), ZERO_BYTES);
        out = uint256(uint128(zeroForOne ? d.amount1() : d.amount0()));
        vm.revertToState(snap);
    }

    /// Reviewer's scenario: [v3 start->X (60% fill), v4 X->start]. Claim: fast path charges full amountIn.
    function test_v3First_partialFill_isMeasuredExactly_notViaFastPath() public {
        PartialFillV3Pool v3 = new PartialFillV3Pool(t0, t1, 600_000); // fills 60%
        t0.transfer(address(v3), 100e18); // token0 cheap here
        t1.transfer(address(v3), 50e18);

        uint256 amountIn = 1e18;
        (uint256 consumed, uint256 xOut) = v3.quote(false, amountIn); // token1 -> token0
        assertEq(consumed, 0.6e18);
        uint256 out2 = _quoteV4(true, xOut); // token0 -> token1 on v4

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v3(address(v3), false);
        steps[1] = _v4(poolA, true);

        uint256 expected = out2 - consumed; // true position: unconsumed 0.4e18 stays in the wallet
        assertGt(expected, out2 - amountIn, "fast-path figure would be lower");

        // Demanding the exact true profit must succeed: if the fast path charged the full amountIn
        // this would revert Unprofitable(out2 - amountIn, expected).
        vm.prank(operator);
        uint256 profit = exec.execute(steps, amountIn, expected, NO_GUARDS);
        assertEq(profit, expected, "profit counts the unconsumed start currency");
        assertEq(t1.balanceOf(address(exec)), expected, "wallet holds exactly the profit");
        assertEq(t0.balanceOf(address(exec)), 0, "no stranded intermediate");
        assertEq(manager.balanceOf(address(exec), 0), 0);
    }

    /// Mirror: [v4 start->X, v3 X->start (60% fill)]. The unconsumed X is an intermediate token:
    /// it stays in the wallet and is (necessarily) not valued in start units.
    function test_v4First_partialFill_leavesIntermediateUnvalued() public {
        PartialFillV3Pool v3 = new PartialFillV3Pool(t0, t1, 600_000);
        t0.transfer(address(v3), 50e18); // token0 expensive here
        t1.transfer(address(v3), 100e18);

        uint256 amountIn = 1e18;
        uint256 xOut = _quoteV4(false, amountIn); // token1 -> token0 on v4
        (uint256 consumed, uint256 out2) = v3.quote(true, xOut); // token0 -> token1 on v3

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v4(poolA, false);
        steps[1] = _v3(address(v3), true);

        uint256 expected = out2 - amountIn;
        vm.prank(operator);
        uint256 profit = exec.execute(steps, amountIn, expected, NO_GUARDS);
        assertEq(profit, expected, "start-currency profit is exact");
        assertEq(t1.balanceOf(address(exec)), expected);
        assertEq(t0.balanceOf(address(exec)), xOut - consumed, "unconsumed intermediate stranded in wallet, uncounted");
    }
}
