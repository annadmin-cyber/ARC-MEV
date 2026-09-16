// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {ArcArbExecutor} from "../src/ArcArbExecutor.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

contract ArcArbExecutorTest is Deployers {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    ArcArbExecutor.Guard[] internal NO_GUARDS;

    ArcArbExecutor internal exec;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal stranger = makeAddr("stranger");

    // Two ERC20/ERC20 pools on the same pair with different fee tiers.
    PoolKey internal poolA; // 0.30%, tick spacing 60
    PoolKey internal poolB; // 0.05%, tick spacing 10

    // Two native/ERC20 pools (currency0 = address(0), like native USDC on Arc).
    PoolKey internal nativeA;
    PoolKey internal nativeB;

    ModifyLiquidityParams internal WIDE =
        ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100e18, salt: 0});

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        (poolA,) = initPool(currency0, currency1, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        (poolB,) = initPool(currency0, currency1, IHooks(address(0)), 500, 10, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(poolA, WIDE, ZERO_BYTES);
        modifyLiquidityRouter.modifyLiquidity(poolB, WIDE, ZERO_BYTES);

        // Native pools: currency0 = native, currency1 = an ERC20.
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

    /// @dev Push token0 into pool B so token0 becomes cheap there relative to pool A.
    function _skewB() internal {
        swap(poolB, true, -1e18, ZERO_BYTES);
    }

    /// @dev Buy token0 cheap in B (sell token1), sell it in A (get token1 back). Start currency = token1.
    function _arbSteps() internal view returns (ArcArbExecutor.Step[] memory steps) {
        steps = new ArcArbExecutor.Step[](2);
        steps[0] = ArcArbExecutor.Step({key: poolB, zeroForOne: false});
        steps[1] = ArcArbExecutor.Step({key: poolA, zeroForOne: true});
    }

    // ------------------------------------------------------------------
    // happy path
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
        // Skew native pool B by selling native into it.
        swapNativeInput(nativeB, true, -1e18, ZERO_BYTES, 1e18);

        // Buy native cheap in B (sell token1 -> native), sell native in A (native -> token1).
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = ArcArbExecutor.Step({key: nativeB, zeroForOne: false});
        steps[1] = ArcArbExecutor.Step({key: nativeA, zeroForOne: true});

        vm.prank(operator);
        uint256 profit = exec.execute(steps, 0.1e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        assertEq(currency1.balanceOf(address(exec)), profit);

        // And the reverse orientation with native as the start currency:
        // sell native in A (expensive), buy back in B (cheap)... only profitable while skew remains.
        // After the first arb the gap is smaller but still non-zero because we under-sized the input.
        ArcArbExecutor.Step[] memory steps2 = new ArcArbExecutor.Step[](2);
        steps2[0] = ArcArbExecutor.Step({key: nativeA, zeroForOne: true});
        steps2[1] = ArcArbExecutor.Step({key: nativeB, zeroForOne: false});
        vm.prank(operator);
        uint256 nativeProfit = exec.execute(steps2, 0.05e18, 1, NO_GUARDS);
        assertGt(nativeProfit, 0);
        assertEq(address(exec).balance, nativeProfit, "native profit must land in executor");
    }

    function test_execute_threeHopCycle() public {
        // Third token C with pools C/token0 and C/token1 at 1:1, plus skewed token0/token1 pool.
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

        _skewB(); // token0 cheap in pool B

        // Cycle: token1 -> token0 (pool B, cheap), token0 -> C (pC0), C -> token1 (pC1).
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](3);
        steps[0] = ArcArbExecutor.Step({key: poolB, zeroForOne: false});
        steps[1] = ArcArbExecutor.Step({key: pC0, zeroForOne: Currency.unwrap(pC0.currency0) == Currency.unwrap(currency0)});
        steps[2] = ArcArbExecutor.Step({key: pC1, zeroForOne: Currency.unwrap(pC1.currency0) == Currency.unwrap(cc)});

        vm.prank(operator);
        uint256 profit = exec.execute(steps, 0.1e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        assertEq(currency1.balanceOf(address(exec)), profit);
        assertEq(currency0.balanceOf(address(exec)), 0);
        assertEq(c.balanceOf(address(exec)), 0);
    }

    // ------------------------------------------------------------------
    // reverts
    // ------------------------------------------------------------------

    function test_execute_revertsWhenUnprofitable() public {
        // No skew: any round trip loses the fees.
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

        // Exactly minProfit passes.
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
        steps[0] = ArcArbExecutor.Step({key: poolB, zeroForOne: false}); // out: token0
        steps[1] = ArcArbExecutor.Step({key: poolA, zeroForOne: false}); // in: token1 != token0
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.PathBroken.selector, 1));
        exec.execute(steps, 0.1e18, 0, NO_GUARDS);
    }

    function test_execute_revertsWhenCycleNotClosed() public {
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](1);
        steps[0] = ArcArbExecutor.Step({key: poolB, zeroForOne: false});
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.CycleNotClosed.selector, currency1, currency0));
        exec.execute(steps, 0.1e18, 0, NO_GUARDS);
    }

    function test_guards_passWithinTolerance_andRevertWhenStale() public {
        _skewB();
        (uint160 priceA,,,) = manager.getSlot0(poolA.toId());
        (uint160 priceB,,,) = manager.getSlot0(poolB.toId());

        ArcArbExecutor.Guard[] memory guards = new ArcArbExecutor.Guard[](2);
        guards[0] = ArcArbExecutor.Guard({poolId: PoolId.unwrap(poolA.toId()), expectedSqrtPriceX96: priceA, toleranceBps: 0});
        guards[1] = ArcArbExecutor.Guard({poolId: PoolId.unwrap(poolB.toId()), expectedSqrtPriceX96: priceB, toleranceBps: 1});

        uint256 snap = vm.snapshotState();
        vm.prank(operator);
        uint256 profit = exec.execute(_arbSteps(), 0.1e18, 1, guards);
        assertGt(profit, 0);
        vm.revertToState(snap);

        // Someone else moves pool B first: exact guard on A still passes, 1 bp guard on B fails.
        swap(poolB, false, -0.5e18, ZERO_BYTES);
        (uint160 movedB,,,) = manager.getSlot0(poolB.toId());
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ArcArbExecutor.StaleState.selector, 1, movedB));
        exec.execute(_arbSteps(), 0.1e18, 1, guards);

        // A wide tolerance lets it through again.
        guards[1].toleranceBps = 10_000;
        vm.prank(operator);
        exec.execute(_arbSteps(), 0.01e18, 0, guards);
    }

    function test_guards_areCheckedBeforeAccessToSwaps() public {
        // A stale guard must revert even for a plan that would otherwise fail later, proving the check runs first.
        ArcArbExecutor.Guard[] memory guards = new ArcArbExecutor.Guard[](1);
        guards[0] = ArcArbExecutor.Guard({poolId: PoolId.unwrap(poolA.toId()), expectedSqrtPriceX96: 1, toleranceBps: 0});
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](1);
        steps[0] = ArcArbExecutor.Step({key: poolB, zeroForOne: false});
        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.StaleState.selector);
        exec.execute(steps, 0.1e18, 0, guards);
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
        MockERC20(Currency.unwrap(currency1)).transfer(address(exec), 5e18);
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
        MockERC20(Currency.unwrap(currency1)).transfer(address(exec), 1e18);
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", owner, 1e18);

        vm.prank(operator);
        vm.expectRevert(ArcArbExecutor.NotOwner.selector);
        exec.call(Currency.unwrap(currency1), 0, data);

        vm.prank(owner);
        exec.call(Currency.unwrap(currency1), 0, data);
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
