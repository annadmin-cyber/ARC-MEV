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

import {ArcArbExecutor} from "../src/ArcArbExecutor.sol";
import {MockV3Pool} from "./mocks/MockV3Pool.sol";
import {MockV2Pair} from "./mocks/MockV2Pair.sol";

contract ArcArbExecutorTest is Deployers {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    ArcArbExecutor internal exec;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");

    ArcArbExecutor.Guard[] internal NO_GUARDS;

    // Two ERC20/ERC20 v4 pools on the same pair with different fee tiers.
    PoolKey internal poolA; // 0.30%, tick spacing 60
    PoolKey internal poolB; // 0.05%, tick spacing 10

    // Two native/ERC20 v4 pools (currency0 = address(0), like native USDC on Arc).
    PoolKey internal nativeA;
    PoolKey internal nativeB;

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
        (nativeB,) = initPool(CurrencyLibrary.ADDRESS_ZERO, currency1, IHooks(address(0)), 500, 10, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 100 ether}(nativeA, WIDE, ZERO_BYTES);
        modifyLiquidityRouter.modifyLiquidity{value: 100 ether}(nativeB, WIDE, ZERO_BYTES);

        exec = new ArcArbExecutor(manager, owner, operator);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _v4(PoolKey memory key, bool zeroForOne) internal pure returns (ArcArbExecutor.Step memory) {
        return ArcArbExecutor.Step({kind: 0, zeroForOne: zeroForOne, pool: address(0), key: key});
    }

    function _ext(uint8 kind, address pool, Currency c0, Currency c1, uint24 fee, bool zeroForOne)
        internal
        pure
        returns (ArcArbExecutor.Step memory)
    {
        return ArcArbExecutor.Step({
            kind: kind,
            zeroForOne: zeroForOne,
            pool: pool,
            key: PoolKey({currency0: c0, currency1: c1, fee: fee, tickSpacing: 0, hooks: IHooks(address(0))})
        });
    }

    /// @dev Push token0 into pool B so token0 becomes cheap there relative to pool A.
    function _skewB() internal {
        swap(poolB, true, -1e18, ZERO_BYTES);
    }

    /// @dev Buy token0 cheap in B (sell token1), sell it in A (get token1 back). Start currency = token1.
    function _arbSteps() internal view returns (ArcArbExecutor.Step[] memory steps) {
        steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v4(poolB, false);
        steps[1] = _v4(poolA, true);
    }

    /// @dev A v3-style mock pool where token0 is expensive (few token0, many token1).
    function _deployV3(uint256 r0, uint256 r1, bytes4 selector) internal returns (MockV3Pool pool) {
        pool = new MockV3Pool(t0, t1, 3000, selector);
        t0.transfer(address(pool), r0);
        t1.transfer(address(pool), r1);
    }

    function _deployV2(uint256 r0, uint256 r1) internal returns (MockV2Pair pair) {
        pair = new MockV2Pair(t0, t1, 3000);
        t0.transfer(address(pair), r0);
        t1.transfer(address(pair), r1);
        pair.sync();
    }

    // ------------------------------------------------------------------
    // v4-only cycles
    // ------------------------------------------------------------------

    function test_execute_profitableCycle_erc20() public {
        _skewB();
        uint256 before = currency1.balanceOf(address(exec));

        vm.prank(operator);
        uint256 profit = exec.execute(_arbSteps(), 0.1e18, 1, NO_GUARDS);

        assertGt(profit, 0, "profit should be positive");
        assertEq(currency1.balanceOf(address(exec)) - before, profit, "profit must land in executor");
        assertEq(currency0.balanceOf(address(exec)), 0, "no leftover intermediate token");
    }

    function test_execute_ownerMayExecute() public {
        _skewB();
        vm.prank(owner);
        uint256 profit = exec.execute(_arbSteps(), 0.1e18, 0, NO_GUARDS);
        assertGt(profit, 0);
    }

    function test_execute_profitableCycle_native() public {
        swapNativeInput(nativeB, true, -1e18, ZERO_BYTES, 1e18);

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v4(nativeB, false);
        steps[1] = _v4(nativeA, true);

        vm.prank(operator);
        uint256 profit = exec.execute(steps, 0.1e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        assertEq(currency1.balanceOf(address(exec)), profit);

        ArcArbExecutor.Step[] memory steps2 = new ArcArbExecutor.Step[](2);
        steps2[0] = _v4(nativeA, true);
        steps2[1] = _v4(nativeB, false);
        vm.prank(operator);
        uint256 nativeProfit = exec.execute(steps2, 0.05e18, 1, NO_GUARDS);
        assertGt(nativeProfit, 0);
        assertEq(address(exec).balance, nativeProfit, "native profit must land in executor");
    }

    function test_execute_threeHopCycle() public {
        MockERC20 c = new MockERC20("C", "C", 18);
        c.mint(address(this), 1_000_000e18);
        c.approve(address(modifyLiquidityRouter), type(uint256).max);
        c.approve(address(swapRouter), type(uint256).max);
        Currency cc = Currency.wrap(address(c));

        (Currency c0a, Currency c1a) = _sort(cc, currency0);
        (Currency c0b, Currency c1b) = _sort(cc, currency1);
        (PoolKey memory pC0,) = initPool(c0a, c1a, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        (PoolKey memory pC1,) = initPool(c0b, c1b, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(pC0, WIDE, ZERO_BYTES);
        modifyLiquidityRouter.modifyLiquidity(pC1, WIDE, ZERO_BYTES);

        _skewB();

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](3);
        steps[0] = _v4(poolB, false);
        steps[1] = _v4(pC0, Currency.unwrap(pC0.currency0) == Currency.unwrap(currency0));
        steps[2] = _v4(pC1, Currency.unwrap(pC1.currency0) == Currency.unwrap(cc));

        vm.prank(operator);
        uint256 profit = exec.execute(steps, 0.1e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        assertEq(currency1.balanceOf(address(exec)), profit);
        assertEq(currency0.balanceOf(address(exec)), 0);
        assertEq(c.balanceOf(address(exec)), 0);
    }

    // ------------------------------------------------------------------
    // cross-venue cycles (v3 / v2 mocks)
    // ------------------------------------------------------------------

    function test_v4_then_v3_cycle_withForkSelector() public {
        // token0 expensive on the v3 mock: buy token0 on v4 (1:1), sell it on v3.
        MockV3Pool v3 = _deployV3(50e18, 100e18, bytes4(keccak256("someForkSwapCallback(int256,int256,bytes)")));

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v4(poolA, false); // token1 -> token0 on v4
        steps[1] = _ext(1, address(v3), currency0, currency1, 3000, true); // token0 -> token1 on v3

        uint256 before = t1.balanceOf(address(exec));
        vm.prank(operator);
        uint256 profit = exec.execute(steps, 1e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        assertEq(t1.balanceOf(address(exec)) - before, profit, "profit held in wallet");
        assertEq(t0.balanceOf(address(exec)), 0, "no leftover token0");
    }

    function test_v3_first_flashLoanFromPoolManager_then_v4() public {
        // token0 cheap on the v3 mock (many token0, few token1): buy token0 there, sell on v4.
        MockV3Pool v3 = _deployV3(100e18, 50e18, ArcArbExecutor.uniswapV3SwapCallback.selector);

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _ext(1, address(v3), currency0, currency1, 3000, false); // token1 -> token0 on v3 (flash-borrowed token1)
        steps[1] = _v4(poolA, true); // token0 -> token1 on v4

        assertEq(t1.balanceOf(address(exec)), 0, "executor starts with nothing");
        vm.prank(operator);
        uint256 profit = exec.execute(steps, 1e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        assertEq(t1.balanceOf(address(exec)), profit);
        assertEq(t0.balanceOf(address(exec)), 0);
    }

    function test_v4_then_v2_cycle() public {
        MockV2Pair v2 = _deployV2(50e18, 100e18); // token0 expensive on v2

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v4(poolA, false); // token1 -> token0 on v4
        steps[1] = _ext(2, address(v2), currency0, currency1, 3000, true); // token0 -> token1 on v2

        vm.prank(operator);
        uint256 profit = exec.execute(steps, 1e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        assertEq(t1.balanceOf(address(exec)), profit);
        assertEq(t0.balanceOf(address(exec)), 0);
    }

    function test_v2_then_v3_noV4Hops_stillWorksViaFlashLoan() public {
        MockV2Pair v2 = _deployV2(100e18, 50e18); // token0 cheap on v2
        MockV3Pool v3 = _deployV3(50e18, 100e18, ArcArbExecutor.uniswapV3SwapCallback.selector); // token0 expensive on v3

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _ext(2, address(v2), currency0, currency1, 3000, false); // token1 -> token0 on v2
        steps[1] = _ext(1, address(v3), currency0, currency1, 3000, true); // token0 -> token1 on v3

        vm.prank(operator);
        uint256 profit = exec.execute(steps, 1e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        assertEq(t1.balanceOf(address(exec)), profit);
    }

    function test_crossVenue_revertsWhenUnprofitable() public {
        MockV3Pool v3 = _deployV3(100e18, 100e18, ArcArbExecutor.uniswapV3SwapCallback.selector); // 1:1, only fees
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v4(poolA, false);
        steps[1] = _ext(1, address(v3), currency0, currency1, 3000, true);
        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.Unprofitable.selector);
        exec.execute(steps, 1e18, 0, NO_GUARDS);
    }

    function test_callback_rejectsUnexpectedCaller() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.UnexpectedCallback.selector, stranger));
        exec.uniswapV3SwapCallback(1, -1, "");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.UnexpectedCallback.selector, stranger));
        (bool ok,) = address(exec).call(abi.encodeWithSignature("pancakeV3SwapCallback(int256,int256,bytes)", 1, -1, ""));
        ok;
    }

    function test_v3Callback_cannotDrainHeldBalances() public {
        // Executor holds 100 token1 of accumulated profit. A hostile "pool" supplied by a (stolen)
        // operator key demands far more than the hop amount in the callback.
        t1.transfer(address(exec), 100e18);
        GreedyV3Pool evil = new GreedyV3Pool(t0, t1);
        t0.transfer(address(evil), 10e18);

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v4(poolA, false); // token1 -> token0 on v4 (creates a small token1 debt)
        steps[1] = _ext(1, address(evil), currency0, currency1, 3000, true); // token0 -> token1 via evil

        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.CallbackOverpay.selector);
        exec.execute(steps, 1e18, 0, NO_GUARDS);
        assertEq(t1.balanceOf(address(exec)), 100e18, "held profit untouched");
    }

    function test_v3Callback_ignoresPoolSuppliedTokenInData() public {
        // Executor holds token0 profit; a hostile pool names token0 in `data` while the hop pays token1.
        t0.transfer(address(exec), 50e18);
        TokenNamingV3Pool evil = new TokenNamingV3Pool(t0, t1);
        t0.transfer(address(evil), 10e18);
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v4(poolA, true); // token0 -> token1 on v4
        steps[1] = _ext(1, address(evil), currency0, currency1, 3000, false); // token1 -> token0 via evil
        vm.prank(operator);
        exec.execute(steps, 1e18, 0, NO_GUARDS);
        // The evil pool received token1 (the hop input), not the token0 it named. The executor keeps its
        // 50 token0, gains the pool's 10 token0 payout and repays the 1 token0 v4 debt.
        assertEq(t0.balanceOf(address(exec)), 50e18 + 10e18 - 1e18, "token0 profit untouched");
        assertEq(t0.balanceOf(address(evil)), 0, "pool got no token0");
        assertGt(t1.balanceOf(address(evil)), 0, "pool got the real input token");
    }

    function test_v3Callback_rejectsTwoPositiveDeltas() public {
        GreedyV3Pool evil = new GreedyV3Pool(t0, t1);
        evil.setBothPositive(true);
        t0.transfer(address(evil), 10e18);
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v4(poolA, false);
        steps[1] = _ext(1, address(evil), currency0, currency1, 3000, true);
        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.InvalidCallbackDeltas.selector);
        exec.execute(steps, 1e18, 0, NO_GUARDS);
    }

    function test_unknownKindReverts() public {
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](1);
        steps[0] = _ext(7, address(0), currency0, currency1, 0, true);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.UnknownKind.selector, 0));
        exec.execute(steps, 1e18, 0, NO_GUARDS);
    }

    function test_crossVenue_cycleNotClosedWhenEndDiffers() public {
        MockV3Pool v3 = _deployV3(50e18, 100e18, ArcArbExecutor.uniswapV3SwapCallback.selector);
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v4(nativeA, true); // native -> token1 on v4
        steps[1] = _ext(1, address(v3), currency0, currency1, 3000, false); // token1 -> token0 on v3: ends in token0
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.CycleNotClosed.selector, CurrencyLibrary.ADDRESS_ZERO, currency0));
        exec.execute(steps, 1e18, 0, NO_GUARDS);
    }

    // ------------------------------------------------------------------
    // guards
    // ------------------------------------------------------------------

    function test_guards_v4_passWithinTolerance_andRevertWhenStale() public {
        _skewB();
        (uint160 priceA,,,) = manager.getSlot0(poolA.toId());
        (uint160 priceB,,,) = manager.getSlot0(poolB.toId());

        ArcArbExecutor.Guard[] memory guards = new ArcArbExecutor.Guard[](2);
        guards[0] = ArcArbExecutor.Guard({kind: 0, poolId: PoolId.unwrap(poolA.toId()), expected: priceA, toleranceBps: 0});
        guards[1] = ArcArbExecutor.Guard({kind: 0, poolId: PoolId.unwrap(poolB.toId()), expected: priceB, toleranceBps: 1});

        uint256 snap = vm.snapshotState();
        vm.prank(operator);
        uint256 profit = exec.execute(_arbSteps(), 0.1e18, 1, guards);
        assertGt(profit, 0);
        vm.revertToState(snap);

        swap(poolB, false, -0.5e18, ZERO_BYTES);
        (uint160 movedB,,,) = manager.getSlot0(poolB.toId());
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.StaleState.selector, 1, movedB));
        exec.execute(_arbSteps(), 0.1e18, 1, guards);

        guards[1].toleranceBps = 10_000;
        vm.prank(operator);
        exec.execute(_arbSteps(), 0.01e18, 0, guards);
    }

    function test_guards_areCheckedBeforeSwaps() public {
        ArcArbExecutor.Guard[] memory guards = new ArcArbExecutor.Guard[](1);
        guards[0] = ArcArbExecutor.Guard({kind: 0, poolId: PoolId.unwrap(poolA.toId()), expected: 1, toleranceBps: 0});
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](1);
        steps[0] = _v4(poolB, false);
        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.StaleState.selector);
        exec.execute(steps, 0.1e18, 0, guards);
    }

    function test_guards_v3_and_v2() public {
        MockV3Pool v3 = _deployV3(50e18, 100e18, ArcArbExecutor.uniswapV3SwapCallback.selector);
        MockV2Pair v2 = _deployV2(50e18, 100e18);
        (uint160 v3Price,,,,,,) = v3.slot0();
        (uint112 r0, uint112 r1,) = v2.getReserves();
        uint160 v2Price = exec.v2SqrtPriceX96(r0, r1);

        ArcArbExecutor.Guard[] memory guards = new ArcArbExecutor.Guard[](2);
        guards[0] = ArcArbExecutor.Guard({kind: 1, poolId: bytes32(uint256(uint160(address(v3)))), expected: v3Price, toleranceBps: 0});
        guards[1] = ArcArbExecutor.Guard({kind: 2, poolId: bytes32(uint256(uint160(address(v2)))), expected: v2Price, toleranceBps: 1});

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v4(poolA, false);
        steps[1] = _ext(1, address(v3), currency0, currency1, 3000, true);

        uint256 snap = vm.snapshotState();
        vm.prank(operator);
        exec.execute(steps, 0.5e18, 1, guards);
        vm.revertToState(snap);

        // Move the v2 pair's price: its guard must trip.
        t0.transfer(address(v2), 1e18);
        v2.sync();
        (uint112 m0, uint112 m1,) = v2.getReserves();
        uint160 movedPrice = exec.v2SqrtPriceX96(m0, m1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.StaleState.selector, 1, movedPrice));
        exec.execute(steps, 0.5e18, 1, guards);

        // A proportional liquidity add keeps the price: the guard must still pass.
        vm.revertToState(snap);
        t0.transfer(address(v2), 50e18);
        t1.transfer(address(v2), 100e18);
        v2.sync();
        vm.prank(operator);
        exec.execute(steps, 0.5e18, 1, guards);
    }

    function test_v2SqrtPriceX96_matchesV3Convention() public view {
        // 1:1 reserves -> 2^96; 4:1 (reserve1 = 4 * reserve0) -> 2 * 2^96.
        assertEq(exec.v2SqrtPriceX96(100e18, 100e18), uint160(1 << 96));
        assertEq(exec.v2SqrtPriceX96(100e18, 400e18), uint160(2 << 96));
        // Huge ratio falls back to the sqrt-quotient path and stays within 1e-6 of exact.
        uint256 big = exec.v2SqrtPriceX96(1, 1 << 100);
        assertApproxEqRel(big, uint256(1 << 50) << 96, 1e12);
        assertEq(exec.v2SqrtPriceX96(0, 1e18), 0);
    }

    // ------------------------------------------------------------------
    // reverts / access control
    // ------------------------------------------------------------------

    function test_execute_revertsWhenUnprofitable() public {
        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.Unprofitable.selector);
        exec.execute(_arbSteps(), 0.1e18, 0, NO_GUARDS);
    }

    function test_execute_revertsWhenBelowMinProfit() public {
        _skewB();
        uint256 snap = vm.snapshotState();
        vm.prank(operator);
        uint256 profit = exec.execute(_arbSteps(), 0.1e18, 0, NO_GUARDS);
        vm.revertToState(snap);

        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.Unprofitable.selector);
        exec.execute(_arbSteps(), 0.1e18, profit + 1, NO_GUARDS);

        vm.prank(operator);
        assertEq(exec.execute(_arbSteps(), 0.1e18, profit, NO_GUARDS), profit);
    }

    function test_execute_revertsOnEmptyPlan() public {
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](0);
        vm.prank(operator);
        vm.expectRevert(ArcArbExecutor.EmptyPlan.selector);
        exec.execute(steps, 1e18, 0, NO_GUARDS);
    }

    function test_execute_revertsOnBrokenPath() public {
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _v4(poolB, false); // out: token0
        steps[1] = _v4(poolA, false); // in: token1 != token0
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.PathBroken.selector, 1));
        exec.execute(steps, 0.1e18, 0, NO_GUARDS);
    }

    function test_execute_revertsWhenCycleNotClosed() public {
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](1);
        steps[0] = _v4(poolB, false);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.CycleNotClosed.selector, currency1, currency0));
        exec.execute(steps, 0.1e18, 0, NO_GUARDS);
    }

    function test_execute_onlyOperatorOrOwner() public {
        vm.prank(stranger);
        vm.expectRevert(ArcArbExecutor.NotOperator.selector);
        exec.execute(_arbSteps(), 0.1e18, 0, NO_GUARDS);
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.prank(stranger);
        vm.expectRevert(ArcArbExecutor.NotPoolManager.selector);
        exec.unlockCallback("");
    }

    // ------------------------------------------------------------------
    // owner functions
    // ------------------------------------------------------------------

    function test_withdraw_erc20_and_native() public {
        t1.transfer(address(exec), 5e18);
        vm.deal(address(exec), 3 ether);

        vm.startPrank(owner);
        exec.withdraw(currency1, owner, 2e18);
        exec.withdraw(CurrencyLibrary.ADDRESS_ZERO, owner, 1 ether);
        exec.sweep(currency1, owner);
        exec.sweep(CurrencyLibrary.ADDRESS_ZERO, owner);
        vm.stopPrank();

        assertEq(currency1.balanceOf(owner), 5e18);
        assertEq(owner.balance, 3 ether);
        assertEq(currency1.balanceOf(address(exec)), 0);
        assertEq(address(exec).balance, 0);
    }

    function test_withdraw_onlyOwner() public {
        vm.prank(operator);
        vm.expectRevert(ArcArbExecutor.NotOwner.selector);
        exec.withdraw(currency1, operator, 1);
        vm.prank(operator);
        vm.expectRevert(ArcArbExecutor.NotOwner.selector);
        exec.sweep(currency1, operator);
    }

    function test_call_onlyOwner_andForwards() public {
        t1.transfer(address(exec), 1e18);
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", owner, 1e18);

        vm.prank(operator);
        vm.expectRevert(ArcArbExecutor.NotOwner.selector);
        exec.call(address(t1), 0, data);

        vm.prank(owner);
        exec.call(address(t1), 0, data);
        assertEq(currency1.balanceOf(owner), 1e18);
    }

    function test_roles() public {
        vm.prank(owner);
        exec.setOperator(stranger);
        assertEq(exec.operator(), stranger);

        vm.prank(owner);
        exec.transferOwnership(stranger);
        assertEq(exec.owner(), stranger);

        vm.prank(owner);
        vm.expectRevert(ArcArbExecutor.NotOwner.selector);
        exec.setOperator(owner);

        vm.prank(stranger);
        vm.expectRevert(ArcArbExecutor.ZeroAddress.selector);
        exec.transferOwnership(address(0));
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(ArcArbExecutor.ZeroAddress.selector);
        new ArcArbExecutor(IPoolManager(address(0)), owner, operator);
        vm.expectRevert(ArcArbExecutor.ZeroAddress.selector);
        new ArcArbExecutor(manager, address(0), operator);
    }

    function _sort(Currency a, Currency b) internal pure returns (Currency, Currency) {
        return Currency.unwrap(a) < Currency.unwrap(b) ? (a, b) : (b, a);
    }
}

/// @dev A hostile v3-style pool that pays out all its token0 and names token0 as the token to be paid with.
contract TokenNamingV3Pool {
    MockERC20 internal immutable token0;
    MockERC20 internal immutable token1;

    constructor(MockERC20 _t0, MockERC20 _t1) {
        token0 = _t0;
        token1 = _t1;
    }

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata) external returns (int256, int256) {
        token0.transfer(recipient, token0.balanceOf(address(this)));
        (bool ok,) = msg.sender.call(
            abi.encodeWithSignature(
                "uniswapV3SwapCallback(int256,int256,bytes)", -int256(10e18), amountSpecified, abi.encode(address(token0))
            )
        );
        require(ok, "callback failed");
        return (-int256(10e18), amountSpecified);
    }
}

/// @dev A hostile v3-style pool: pays a token0 "output" then demands the caller's whole token1 balance.
contract GreedyV3Pool {
    MockERC20 internal immutable token0;
    MockERC20 internal immutable token1;
    bool internal bothPositive;

    constructor(MockERC20 _t0, MockERC20 _t1) {
        token0 = _t0;
        token1 = _t1;
    }

    function setBothPositive(bool v) external {
        bothPositive = v;
    }

    function swap(address recipient, bool, int256, uint160, bytes calldata data) external returns (int256, int256) {
        token0.transfer(recipient, 1e18); // "output" the executor did not ask for, to look legitimate
        uint256 demand = bothPositive ? 5e18 : token1.balanceOf(msg.sender);
        int256 a0 = bothPositive ? int256(1) : int256(-1e18);
        (bool ok, bytes memory ret) = msg.sender.call(
            abi.encodeWithSignature("uniswapV3SwapCallback(int256,int256,bytes)", a0, int256(demand), data)
        );
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return (a0, int256(demand));
    }
}
