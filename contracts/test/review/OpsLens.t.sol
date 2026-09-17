// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {ArcArbExecutor} from "../../src/ArcArbExecutor.sol";
import {MockV2Pair} from "../mocks/MockV2Pair.sol";

contract OpsLensTest is Deployers {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    ArcArbExecutor internal exec;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    ArcArbExecutor.Guard[] internal NO_GUARDS;

    PoolKey internal poolA;
    PoolKey internal poolB;
    PoolKey internal nativeA;
    MockERC20 internal t0;
    MockERC20 internal t1;
    ModifyLiquidityParams internal WIDE =
        ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100e18, salt: 0});

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));
        (poolA,) = initPool(currency0, currency1, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        (poolB,) = initPool(currency0, currency1, IHooks(address(0)), 500, 10, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(poolA, WIDE, ZERO_BYTES);
        modifyLiquidityRouter.modifyLiquidity(poolB, WIDE, ZERO_BYTES);
        vm.deal(address(this), 10_000 ether);
        (nativeA,) = initPool(CurrencyLibrary.ADDRESS_ZERO, currency1, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 100 ether}(nativeA, WIDE, ZERO_BYTES);
        exec = new ArcArbExecutor(manager, owner, operator);
    }

    function _v4(PoolKey memory key, bool zeroForOne) internal pure returns (ArcArbExecutor.Step memory) {
        return ArcArbExecutor.Step({kind: 0, zeroForOne: zeroForOne, pool: address(0), key: key});
    }

    function _ext(uint8 kind, address pool, bool zeroForOne) internal view returns (ArcArbExecutor.Step memory) {
        return ArcArbExecutor.Step({
            kind: kind,
            zeroForOne: zeroForOne,
            pool: pool,
            key: PoolKey({currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 0, hooks: IHooks(address(0))})
        });
    }

    function _deployV2(uint256 r0, uint256 r1) internal returns (MockV2Pair pair) {
        pair = new MockV2Pair(t0, t1, 3000);
        t0.transfer(address(pair), r0);
        t1.transfer(address(pair), r1);
        pair.sync();
    }

    // ------------------------------------------------------------------
    // v2 guard compares the pair's PRICE (sqrt(reserve1/reserve0) * 2^96), not reserve0.
    // Regressions for the pre-e50e556 guard, which read reserve0 alone.
    // ------------------------------------------------------------------

    /// reserve1 doubles (price of token0 doubles) while reserve0 is untouched: the guard must trip
    /// before any swap runs (a reserve0-only guard would pass and burn gas up to Unprofitable).
    function test_v2Guard_tripsWhenOnlyReserve1Moved() public {
        MockV2Pair v2 = _deployV2(100e18, 100e18);
        (uint112 r0, uint112 r1,) = v2.getReserves();
        ArcArbExecutor.Guard[] memory guards = new ArcArbExecutor.Guard[](1);
        guards[0] = ArcArbExecutor.Guard({
            kind: 2,
            poolId: bytes32(uint256(uint160(address(v2)))),
            expected: exec.v2SqrtPriceX96(r0, r1),
            toleranceBps: 0
        });

        // plan: buy token0 with token1 on v2, sell token0 on v4 A
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _ext(2, address(v2), false);
        steps[1] = _v4(poolA, true);

        // Price moves by 100% on the pair without touching reserve0.
        t1.transfer(address(v2), 100e18);
        v2.sync();
        (uint112 r0After, uint112 r1After,) = v2.getReserves();
        assertEq(r0After, r0, "reserve0 unchanged");
        assertEq(r1After, 200e18, "reserve1 doubled");
        uint160 movedPrice = exec.v2SqrtPriceX96(r0After, r1After);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.StaleState.selector, 0, movedPrice));
        exec.execute(steps, 1e18, 1, guards);
    }

    /// Adding liquidity proportionally (price unchanged, opportunity intact) must NOT trip the guard.
    function test_v2Guard_passesOnProportionalMint() public {
        MockV2Pair v2 = _deployV2(100e18, 50e18); // token0 cheap here vs v4 (1:1)
        (uint112 r0, uint112 r1,) = v2.getReserves();
        ArcArbExecutor.Guard[] memory guards = new ArcArbExecutor.Guard[](1);
        guards[0] = ArcArbExecutor.Guard({
            kind: 2,
            poolId: bytes32(uint256(uint160(address(v2)))),
            expected: exec.v2SqrtPriceX96(r0, r1),
            toleranceBps: 50
        });

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _ext(2, address(v2), false);
        steps[1] = _v4(poolA, true);

        // LP adds 10% of both reserves: same price, deeper pool.
        t0.transfer(address(v2), 10e18);
        t1.transfer(address(v2), 5e18);
        v2.sync();

        vm.prank(operator);
        assertGt(exec.execute(steps, 1e18, 1, guards), 0);
    }

    // ------------------------------------------------------------------
    // native settle without sync(address(0))
    // ------------------------------------------------------------------

    /// Regression for `_pay(native)`: an external hop (or a hook) may leave `PoolManager.sync(X)`
    /// pending; settling native while a currency is synced reverts `NonzeroNativeValue`, so the
    /// executor must `sync(address(0))` first. The pool below pays native for t1 and leaves a stray
    /// sync set; the following native v4 hop must still settle.
    function test_nativePay_survivesStraySyncLeftByPreviousHop() public {
        MockERC20 stray = new MockERC20("S", "S", 18);
        NativePayingPool pool = new NativePayingPool(manager, stray, t1);
        vm.deal(address(pool), 10 ether);

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = ArcArbExecutor.Step({
            kind: 1,
            zeroForOne: false, // t1 -> native, t1 flash-loaned from the manager
            pool: address(pool),
            key: PoolKey({currency0: CurrencyLibrary.ADDRESS_ZERO, currency1: currency1, fee: 0, tickSpacing: 0, hooks: IHooks(address(0))})
        });
        steps[1] = _v4(nativeA, true); // native -> t1

        vm.prank(operator);
        uint256 profit = exec.execute(steps, 1e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        assertEq(t1.balanceOf(address(exec)), profit);
        assertEq(address(exec).balance, 0, "no native left in the wallet");
    }

    // ------------------------------------------------------------------
    // fallback / probes
    // ------------------------------------------------------------------

    function test_fallback_probesRevertButDoNotBrick() public {
        (bool ok, bytes memory ret) = address(exec).staticcall(abi.encodeWithSignature("supportsInterface(bytes4)", bytes4(0x01ffc9a7)));
        assertFalse(ok);
        assertEq(bytes4(ret), ArcArbExecutor.UnexpectedCallback.selector);
        (ok,) = address(exec).call("");
        assertTrue(ok, "receive works");
        (ok,) = address(exec).call{value: 1}("");
        assertTrue(ok, "plain value works");
        (ok,) = address(exec).call{value: 1}(hex"01");
        assertFalse(ok, "value with data reverts (fallback not payable)");
        (ok,) = address(exec).call(hex"0102");
        assertFalse(ok, "short calldata reverts cleanly");
    }
}

/// @dev External "pool" that takes t1 and pays native (stands in for a v3 pool paying ERC-20 USDC on Arc,
///      where that transfer also raises the native balance). Optionally leaves `sync(stray)` set.
contract NativePayingPool {
    IPoolManager immutable pm;
    MockERC20 immutable stray;
    MockERC20 immutable t1;
    bool public leaveSync = true;

    constructor(IPoolManager _pm, MockERC20 _stray, MockERC20 _t1) {
        pm = _pm;
        stray = _stray;
        t1 = _t1;
    }

    function setLeaveSync(bool v) external {
        leaveSync = v;
    }

    receive() external payable {}

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        uint256 out = amountIn + amountIn / 10; // generous: 10% better than 1:1
        (bool ok,) = recipient.call{value: out}("");
        require(ok);
        if (leaveSync) pm.sync(Currency.wrap(address(stray)));
        (ok,) = msg.sender.call(abi.encodeWithSignature("uniswapV3SwapCallback(int256,int256,bytes)", -int256(out), int256(amountIn), data));
        require(ok, "cb");
        require(t1.balanceOf(address(this)) >= amountIn, "not paid");
        return (-int256(out), int256(amountIn));
    }
}
